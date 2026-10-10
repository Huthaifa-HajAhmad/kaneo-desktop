const { contextBridge, ipcRenderer } = require("electron");

// Preload for the *content* view. It runs for Kaneo's page too, so the surface
// is deliberately tiny: two actions the offline screen needs.
contextBridge.exposeInMainWorld("kaneoShell", {
  retry: () => ipcRenderer.send("kaneo:retry"),
  repair: () => ipcRenderer.send("kaneo:repair"),
});
