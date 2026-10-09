# Launches the Kaneo desktop wrapper.
# Clears ELECTRON_RUN_AS_NODE first, which some Electron-based terminals set and
# which would otherwise make Electron run as plain Node.
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npx electron .
