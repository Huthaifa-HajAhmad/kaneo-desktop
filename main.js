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
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Keep development runs out of the installed app's profile. Two Chromium
// instances sharing one userData directory can corrupt cookies and storage,
// which looks exactly like being randomly signed out.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "Kaneo Dev"));
}

const APP_URL = process.env.KANEO_URL || "http://localhost:5173";
const BAR_HEIGHT = 40; // px, must match --bar-h in titlebar.html
const DARK_BG = "#141414"; // Kaneo's dark --background token
const PROBE_INTERVAL_MS = 8000;
const FAILS_BEFORE_OFFLINE = 2;

// How the backend is repaired/updated. Defaults match the WSL setup in the README.
const WSL_DISTRO = process.env.KANEO_WSL_DISTRO || "Ubuntu";
const WSL_USER = process.env.KANEO_WSL_USER || "hsa19";
const COMPOSE_DIR = process.env.KANEO_COMPOSE_DIR || "$HOME/kaneo";

let win = null;
let barView = null;
let contentView = null;
let themeTimer = null;
let reachTimer = null;
let updateTimer = null;
let autoUpdater = null;

let updatingKaneo = false;
let repairing = false;
let blankReloads = 0;
let failStreak = 0;
let ticking = false;

// null | "app" | "offline"
let showing = null;
let offlineReason = "";
const REASON_NO_RESPONSE = `no response from ${APP_URL}`;

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
// "ready" | "loading" | "offline" | "updating" | "repairing"
let status = null;
function setStatus(next) {
  if (next === status) return;
  status = next;
  send("kaneo:status", next);
}

// ---- app log -----------------------------------------------------------------
// electron-updater and the reachability state machine are otherwise invisible.
// Everything lands in <userData>/update.log so problems are diagnosable.
function logEvent(level, ...args) {
  const text = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${text}`;
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "update.log"), line + "\n");
  } catch {
    /* logging must never break the app */
  }
  console.log(`[app] ${line}`);
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
  if (showing !== "app" || !contentView || contentView.webContents.isDestroyed()) return;
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

// ---- reachability -------------------------------------------------------------
// Never load the SPA unless the API answers. If Kaneo's API is unreachable the
// SPA can't validate the session and renders a sign-in page, which reads as
// "you were signed out" when nothing of the sort happened. Probing first keeps
// that misleading state off the screen.
async function probeBackend(timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${APP_URL}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function showApp() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  showing = "app";
  offlineReason = "";
  setStatus("loading");
  contentView.webContents.loadURL(APP_URL);
}

function showOffline(reason) {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  const next = String(reason || REASON_NO_RESPONSE).trim();
  const unchanged = showing === "offline" && offlineReason === next;
  showing = "offline";
  offlineReason = next;
  setStatus("offline");
  if (unchanged) return; // don't reload the page just to say the same thing
  contentView.webContents.loadFile(path.join(__dirname, "offline.html"), {
    query: { url: APP_URL, reason: next },
  });
}

async function tick() {
  if (ticking || repairing) return;
  ticking = true;
  try {
    const ok = await probeBackend();
    if (ok) {
      if (failStreak > 0) logEvent("info", "backend reachable again");
      failStreak = 0;
      if (showing !== "app") {
        logEvent("info", "backend reachable; loading Kaneo");
        showApp();
      }
      return;
    }

    failStreak += 1;
    if (showing === "app") {
      if (failStreak >= FAILS_BEFORE_OFFLINE) {
        logEvent(
          "warn",
          `backend unreachable (${failStreak} consecutive probes); showing the offline screen`
        );
        showOffline(REASON_NO_RESPONSE);
      }
    } else {
      // Keep the existing reason so the page isn't reloaded on every probe.
      showOffline(offlineReason || REASON_NO_RESPONSE);
    }
  } finally {
    ticking = false;
  }
}

// ---- self-heal a blank SPA shell --------------------------------------------
// Kaneo serves hashed asset names. After a backend upgrade a cached index.html
// points at chunks that no longer exist; the SPA fallback answers those with
// HTML, Chromium won't execute it, and React never mounts: a blank window with
// no load error to react to. So check for an empty root and force one
// cache-bypassing reload (bounded, to avoid a loop).
async function healBlankShell() {
  if (showing !== "app" || !contentView || contentView.webContents.isDestroyed()) return;
  try {
    const children = await contentView.webContents.executeJavaScript(
      `(() => { const r = document.getElementById("root"); return r ? r.childElementCount : -1; })()`,
      true
    );
    if (typeof children !== "number" || children < 0) return; // not the SPA shell
    if (children > 0) {
      blankReloads = 0;
      return;
    }
    if (blankReloads >= 2) return;
    blankReloads += 1;
    logEvent("warn", `Kaneo shell is empty (stale cached assets?); hard reload ${blankReloads}/2`);
    contentView.webContents.reloadIgnoringCache();
  } catch {
    /* ignore */
  }
}

function hardReloadKaneo() {
  blankReloads = 0;
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.reloadIgnoringCache();
  }
}

// ---- repair: restart WSL, then bring the containers back --------------------
async function confirmRepair() {
  if (repairing) return;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Repair backend", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Repair backend",
    message: "Restart WSL and the Kaneo containers?",
    detail:
      "This stops every WSL distro for a few seconds and then restarts Kaneo. " +
      "Any other WSL work in progress is interrupted.",
  });
  if (response === 0) runRepair();
}

function runRepair() {
  if (repairing) return;
  repairing = true;
  setStatus("repairing");
  logEvent("warn", "repair: restarting WSL");

  const shutdown = spawn("wsl", ["--shutdown"], { windowsHide: true });
  shutdown.on("error", (err) => logEvent("error", "wsl --shutdown failed:", err));
  shutdown.on("close", (code) => {
    logEvent("info", `wsl --shutdown exited ${code}; booting ${WSL_DISTRO} and containers`);

    const boot = spawn(
      "wsl",
      ["-d", WSL_DISTRO, "-u", WSL_USER, "--", "bash", "-lc", `cd ${COMPOSE_DIR} && docker compose up -d`],
      { windowsHide: true }
    );
    let stderr = "";
    boot.stderr.on("data", (d) => {
      stderr += d;
    });
    boot.on("error", (err) => {
      stderr += err.message;
    });
    boot.on("close", (code) => {
      repairing = false;
      if (code === 0) {
        logEvent("info", "repair: containers started; waiting for the API");
      } else {
        logEvent("error", `repair: docker compose exited ${code}`, stderr.trim().slice(0, 400));
      }
      failStreak = FAILS_BEFORE_OFFLINE;
      tick();
    });
  });
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
    if (code === 0) {
      logEvent("info", "Kaneo containers updated; reloading (asset hashes changed)");
      showApp();
    } else {
      setStatus("ready");
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
    logEvent("error", "electron-updater is not installed");
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.logger = {
    info: (...a) => logEvent("info", ...a),
    warn: (...a) => logEvent("warn", ...a),
    error: (...a) => logEvent("error", ...a),
    debug: (...a) => logEvent("debug", ...a),
  };

  autoUpdater.on("checking-for-update", () =>
    logEvent("info", `checking (installed ${app.getVersion()})`)
  );
  autoUpdater.on("update-available", (i) => logEvent("info", "available:", i?.version));
  autoUpdater.on("update-not-available", (i) =>
    logEvent("info", "not available; latest is", i?.version)
  );
  autoUpdater.on("download-progress", (p) =>
    logEvent("debug", `downloading ${Math.round(p?.percent ?? 0)}%`)
  );
  autoUpdater.on("error", (err) => logEvent("error", err));
  autoUpdater.on("update-downloaded", async (info) => {
    logEvent("info", "downloaded:", info?.version);
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
    else logEvent("info", "update deferred to next launch");
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
        detail: "Run `npm run dist` and use the installed app. See README.",
      });
    }
    return;
  }
  logEvent("info", "manual check requested");
  u.checkForUpdates().catch((err) => {
    logEvent("error", err);
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
  u.checkForUpdatesAndNotify().catch((err) => logEvent("error", err));
  updateTimer = setInterval(
    () => u.checkForUpdates().catch((err) => logEvent("error", err)),
    6 * 60 * 60 * 1000
  );
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
      preload: path.join(__dirname, "shell-preload.js"),
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
    if (showing !== "app") return; // the offline page, not Kaneo
    setStatus(updatingKaneo ? "updating" : "ready");
    logEvent("info", "Kaneo loaded");
    syncTheme();
    setTimeout(healBlankShell, 1500);
  });
  contentView.webContents.on("did-navigate-in-page", syncTheme);

  contentView.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // ERR_ABORTED: a superseded load, not a real failure
    logEvent("warn", `content load failed: ${code} ${desc} (${url})`);
    if (showing === "app") showOffline(`${desc} (${code})`);
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // The first load is decided by tick(): the SPA is only fetched once the API
  // answers, so it can never render a misleading sign-in page.
  layout();
  win.show();

  themeTimer = setInterval(syncTheme, 2000);
}

// ---- title bar menu ----------------------------------------------------------
function showBarMenu() {
  const template = [
    { label: "Reconnect now", click: () => tick() },
    { label: "Repair backend…", click: () => confirmRepair() },
    { type: "separator" },
    { label: "Reload Kaneo", click: () => hardReloadKaneo() },
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

ipcMain.on("kaneo:retry", () => {
  logEvent("info", "reconnect requested");
  failStreak = 0;
  tick();
});

ipcMain.on("kaneo:repair", () => confirmRepair());

// ---- lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
  app.setAppUserModelId("app.kaneo.desktop"); // Windows taskbar identity
  logEvent("info", `starting v${app.getVersion()} (packaged=${app.isPackaged})`);
  createWindow();
  startAutoUpdate();

  tick();
  reachTimer = setInterval(tick, PROBE_INTERVAL_MS);

  app.on("activate", () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (themeTimer) clearInterval(themeTimer);
  if (reachTimer) clearInterval(reachTimer);
  if (updateTimer) clearInterval(updateTimer);
  if (process.platform !== "darwin") app.quit();
});
