// Guard: if launched by plain Node (e.g. ELECTRON_RUN_AS_NODE=1 is set in the
// calling shell), Electron's module API is unavailable. Fail with a clear hint.
if (!process.versions.electron) {
  console.error(
    "\nKaneo Desktop must run under Electron, not plain Node.\n" +
      "If ELECTRON_RUN_AS_NODE is set in your shell, clear it first:\n" +
      "  PowerShell:  Remove-Item Env:\\ELECTRON_RUN_AS_NODE\n" +
      "  bash:        unset ELECTRON_RUN_AS_NODE\n" +
      "Then run:  npm start   (or: .\\run.ps1)\n"
  );
  process.exit(1);
}

const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
} = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_URL = process.env.KANEO_URL || "http://localhost:5173";
const BAR_HEIGHT = 40; // px, must match --bar-h in titlebar.html
const DARK_BG = "#141414"; // Kaneo's dark --background token

// How the backend is updated. Defaults match the WSL setup in the README.
const WSL_DISTRO = process.env.KANEO_WSL_DISTRO || "Ubuntu";
const WSL_USER = process.env.KANEO_WSL_USER || "hsa19";
const COMPOSE_DIR = process.env.KANEO_COMPOSE_DIR || "$HOME/kaneo";

let win = null;
let barView = null;
let contentView = null;
let themeTimer = null;
let updateTimer = null;
let autoUpdater = null;
let updatingKaneo = false;

function layout() {
  if (!win || !barView || !contentView) return;
  const [w, h] = win.getContentSize();
  barView.setBounds({ x: 0, y: 0, width: Math.round(w), height: BAR_HEIGHT });
  contentView.setBounds({
    x: 0,
    y: BAR_HEIGHT,
    width: Math.round(w),
    height: Math.max(0, Math.round(h) - BAR_HEIGHT),
  });
}

function send(channel, payload) {
  if (barView && !barView.webContents.isDestroyed()) {
    barView.webContents.send(channel, payload);
  }
}

// ---- status shown in the bar ------------------------------------------------
// "ready" | "loading" | "offline" | "updating"
let status = null;
function setStatus(next) {
  if (next === status) return;
  status = next;
  send("kaneo:status", next);
}

// ---- theme: mirror Kaneo's own background rather than guessing ---------------
const READ_THEME = `(() => {
  try {
    const c = getComputedStyle(document.body).backgroundColor || "";
    const m = c.match(/\\d+(\\.\\d+)?/g);
    if (!m || m.length < 3) return null;
    const r = Number(m[0]), g = Number(m[1]), b = Number(m[2]);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? "dark" : "light";
  } catch (e) { return null; }
})()`;

let theme = null;
async function syncTheme() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  try {
    const t = await contentView.webContents.executeJavaScript(READ_THEME, true);
    if (t && t !== theme) {
      theme = t;
      send("kaneo:theme", t);
    }
  } catch {
    /* page not ready yet */
  }
}

// ---- update Kaneo itself (the containers) ----------------------------------
function runKaneoUpdate() {
  if (updatingKaneo) return;
  updatingKaneo = true;
  setStatus("updating");

  const cmd = `cd ${COMPOSE_DIR} && docker compose pull && docker compose up -d`;
  const child = spawn(
    "wsl",
    ["-d", WSL_DISTRO, "-u", WSL_USER, "--", "bash", "-lc", cmd],
    { windowsHide: true }
  );

  let stderr = "";
  child.stdout.on("data", (d) => process.stdout.write(`[kaneo update] ${d}`));
  child.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(`[kaneo update] ${d}`);
  });
  child.on("error", (e) => {
    stderr += e.message;
  });
  child.on("close", (code) => {
    updatingKaneo = false;
    setStatus("ready");
    if (code === 0) {
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    } else {
      dialog.showErrorBox(
        "Kaneo update failed",
        (stderr || `docker compose exited with code ${code}`).trim().slice(0, 1500)
      );
    }
  });
}

// ---- update this app itself (packaged builds only) --------------------------
function loadUpdater() {
  if (!app.isPackaged) return null;
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    console.error("[update] electron-updater is not installed");
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.on("error", (err) => console.error("[update] error:", err?.message || err));
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Kaneo ${info.version} is ready to install.`,
      detail: "Restart to finish updating.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  return autoUpdater;
}

function checkAppUpdates(interactive) {
  const u = loadUpdater();
  if (!u) {
    if (interactive) {
      dialog.showMessageBox({
        type: "info",
        title: "App updates",
        message: "App updates are only available in a packaged build.",
        detail:
          "Install electron-builder, set a publish target in package.json, then run `npm run dist`. See README.",
      });
    }
    return;
  }
  u.checkForUpdates().catch((err) => {
    if (interactive) {
      dialog.showMessageBox({
        type: "error",
        title: "Update check failed",
        message: String(err?.message || err),
      });
    }
  });
}

function startAutoUpdate() {
  const u = loadUpdater();
  if (!u) return;
  u.checkForUpdatesAndNotify().catch(() => {});
  updateTimer = setInterval(() => u.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// ---- window ------------------------------------------------------------------
function createWindow() {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false, // we draw our own title bar
    backgroundColor: DARK_BG,
    title: "Kaneo",
    icon: path.join(__dirname, "build", "icon.ico"),
    show: false,
  });

  barView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  contentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.contentView.addChildView(barView);
  win.contentView.addChildView(contentView);

  barView.webContents.loadFile(path.join(__dirname, "titlebar.html"));

  barView.webContents.on("did-finish-load", () => {
    send("kaneo:theme", theme || (nativeTheme.shouldUseDarkColors ? "dark" : "light"));
    send("kaneo:status", status || "loading");
    send("kaneo:maximized", win.isMaximized());
    send("kaneo:focused", win.isFocused());
  });

  // ---- content wiring ----
  contentView.webContents.on("did-finish-load", () => {
    if (!updatingKaneo) setStatus("ready");
    syncTheme();
  });
  contentView.webContents.on("did-navigate-in-page", syncTheme);

  let retry = null;
  contentView.webContents.on("did-fail-load", (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    setStatus("offline");
    clearTimeout(retry);
    retry = setTimeout(() => {
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.loadURL(APP_URL);
      }
    }, 1500);
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  contentView.webContents.loadURL(APP_URL);

  // ---- window state ----
  const pushMax = () => send("kaneo:maximized", win.isMaximized());
  const pushFocus = () => send("kaneo:focused", win.isFocused());
  win.on("maximize", pushMax);
  win.on("unmaximize", pushMax);
  win.on("focus", pushFocus);
  win.on("blur", pushFocus);
  win.on("resize", layout);

  layout();
  win.show();

  themeTimer = setInterval(syncTheme, 2000);
}

// ---- title bar menu ----------------------------------------------------------
function showBarMenu() {
  const template = [
    { label: "Reload Kaneo", click: () => contentView?.webContents.reload() },
    { type: "separator" },
    { label: "Update Kaneo…", click: () => runKaneoUpdate() },
    {
      label: "Check for app updates…",
      enabled: app.isPackaged,
      click: () => checkAppUpdates(true),
    },
    { type: "separator" },
    { label: "Toggle developer tools", click: () => contentView?.webContents.toggleDevTools() },
    { type: "separator" },
    { label: "Quit Kaneo", click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

// ---- ipc ---------------------------------------------------------------------
ipcMain.on("kaneo:minimize", () => {
  if (win) win.minimize();
});

ipcMain.on("kaneo:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on("kaneo:close", () => {
  if (win) win.close();
});

ipcMain.on("kaneo:menu", () => showBarMenu());

// ---- lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
  app.setAppUserModelId("app.kaneo.desktop"); // Windows taskbar identity
  createWindow();
  startAutoUpdate();

  app.on("activate", () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (themeTimer) clearInterval(themeTimer);
  if (updateTimer) clearInterval(updateTimer);
  if (process.platform !== "darwin") app.quit();
});
