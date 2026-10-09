const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit surface for the title bar renderer.
contextBridge.exposeInMainWorld("kaneoWindow", {
  minimize: () => ipcRenderer.send("kaneo:minimize"),
  toggleMaximize: () => ipcRenderer.send("kaneo:toggle-maximize"),
  close: () => ipcRenderer.send("kaneo:close"),
  menu: () => ipcRenderer.send("kaneo:menu"),
  onTheme: (fn) => ipcRenderer.on("kaneo:theme", (_e, v) => fn(v)),
  onMaximized: (fn) => ipcRenderer.on("kaneo:maximized", (_e, v) => fn(v)),
  onFocused: (fn) => ipcRenderer.on("kaneo:focused", (_e, v) => fn(v)),
  onStatus: (fn) => ipcRenderer.on("kaneo:status", (_e, v) => fn(v)),
});
