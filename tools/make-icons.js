// Rasterises build/icon.svg to PNGs at every size Windows asks for.
// Uses Electron's own Chromium (an offscreen <canvas>) so no
// ImageMagick / Inkscape / sharp is needed.
//
//   npm run icons        (runs this, then tools/make-ico.js)
//
// Writes build/icons/<size>.png and build/icon.png (256).
//
// Note: capturing a BrowserWindow is unreliable here because Windows clamps
// tiny windows and display scaling inflates capturePage. Drawing into a canvas
// sized exactly `size` px is DPI-independent and pixel-exact.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "build", "icon.svg");
const OUT = path.join(ROOT, "build", "icons");
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();

// Runs inside the renderer: draw the SVG at exactly `size` and hand back a PNG.
function drawScript(svg, size) {
  return `(async () => {
    const svg = ${JSON.stringify(svg)};
    const size = ${size};
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    img.decoding = "sync";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("svg decode failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  })()`;
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const svg = fs.readFileSync(SRC, "utf8");

    const win = new BrowserWindow({
      width: 300,
      height: 300,
      show: false,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
    });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<html><body></body></html>"));

    const written = [];
    for (const size of SIZES) {
      const dataUrl = await win.webContents.executeJavaScript(drawScript(svg, size), true);
      const png = Buffer.from(String(dataUrl).split(",")[1], "base64");

      // Verify the PNG's real pixel dimensions from its IHDR chunk.
      const w = png.readUInt32BE(16);
      const h = png.readUInt32BE(20);
      if (w !== size || h !== size) throw new Error(`expected ${size}x${size}, got ${w}x${h}`);

      fs.writeFileSync(path.join(OUT, `${size}.png`), png);
      written.push({ size, bytes: png.length });
    }

    fs.copyFileSync(path.join(OUT, "256.png"), path.join(ROOT, "build", "icon.png"));

    win.destroy();
    console.log("rendered:");
    for (const w of written) console.log(`  ${String(w.size).padStart(3)}px  ${w.bytes} bytes`);
    app.exit(0);
  } catch (err) {
    console.error("icon render failed:", err);
    app.exit(1);
  }
});
