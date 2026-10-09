# Kaneo Desktop (Electron wrapper)

A thin Electron shell that loads your self-hosted Kaneo instance in its own window
instead of a browser tab.

## Current setup

- Backend: Kaneo + PostgreSQL, running in Docker inside WSL2 Ubuntu (`~/kaneo`).
- Frontend: this Electron app, running on Windows, pointed at `http://localhost:5173`.
- WSL2 forwards `localhost`, so the Windows app can reach the containers directly.
- Repo: https://github.com/Huthaifa-HajAhmad/kaneo-desktop (private) — used as the
  release feed for shell updates.

## Run it

```powershell
cd C:\Users\HSA19\kaneo-desktop
.\run.ps1
```

`run.ps1` clears `ELECTRON_RUN_AS_NODE` before starting (see Troubleshooting).
`npm start` works too from a normal terminal.

Start Kaneo's containers first, or the window will retry until they're up.

## Start / stop the Kaneo backend (WSL)

```powershell
wsl -d Ubuntu -u hsa19 -- bash -lc "cd ~/kaneo && docker compose up -d"
wsl -d Ubuntu -u hsa19 -- bash -lc "cd ~/kaneo && docker compose ps"
wsl -d Ubuntu -u hsa19 -- bash -lc "cd ~/kaneo && docker compose down"
```

Kaneo UI/API: http://localhost:5173
Health check: http://localhost:5173/api/health

## Title bar

The window is frameless (`frame: false`) and drawn by `titlebar.html` in a second
`WebContentsView` stacked above the Kaneo view. It mirrors Kaneo's own design
tokens, pulled from the app itself:

- background `#141414` (Kaneo's dark `--background`), hairline `--border` at 15% white
- the bundled Geist typeface (`fonts/geist-latin.woff2`), same as the app
- 46x40 caption buttons and a 10px glyph set matching Windows geometry
- the close button is the single accent moment: it only turns red (`#fb414a`) on hover

It also reflects live state:

- **Theme**: every 2s the main process reads the resolved background of Kaneo's
  `<body>` and switches the bar between its dark and light palettes, so toggling
  the app's theme restyles the title bar too.
- **Status**: a quiet indicator appears only when something needs attention —
  amber "Offline" when the backend stops answering, muted "Updating…" during an update.
- **Focus**: the wordmark dims when the window loses focus, like native chrome.

The `⋯` button (and right-clicking the bar) opens the menu: reload, update Kaneo,
check for app updates, dev tools, quit.

Because the window is frameless, Windows 11 snap-layout hover on the maximize
button is unavailable (snapping via drag and `Win`+arrows still works).

## App icon

`build/icon.svg` is the master: Kaneo's `#141414` tile, its 6% white hairline, and
the `#f5f5f5` mark from the app's own favicon. Regenerate the raster set after
editing it:

```powershell
npm run icons
```

That renders `build/icons/{16,20,24,32,48,64,128,256}.png` through Electron's
Chromium (no ImageMagick needed) and packs them into `build/icon.ico`
(`tools/make-icons.js`, `tools/make-ico.js`). The ICO is wired into the window and
into the electron-builder config, so a packaged build embeds it in the `.exe`.

## Updates

There are two independent things to update.

### Kaneo itself (the containers)

Title bar `⋯` → **Update Kaneo…** runs, in WSL:

```
cd $HOME/kaneo && docker compose pull && docker compose up -d
```

and reloads the window when it finishes.

`~/kaneo/.env` is set to `KANEO_IMAGE_TAG=2`, so a pull follows the newest 2.x
release; the stack currently runs `ghcr.io/usekaneo/kaneo:2`. Pin an exact version
instead (e.g. `KANEO_IMAGE_TAG=2.28.3`) if you'd rather review each release
yourself — but note that a pinned tag turns this action into a no-op until you
bump it.

### This desktop shell

`electron-updater` is wired in and checks on launch, then every 6 hours. It is
**inert unless the app is packaged** — running from source it does nothing, and
"Check for app updates…" is grayed out.

`v1.0.0` is already published as the baseline. To cut the next one:

1. Bump `version` in `package.json` and commit it — the updater compares the
   published version against the installed one.
2. `$env:GH_TOKEN = gh auth token`, then `npm run release`.

`tools/release.ps1` builds the installer, tags `v<version>`, pushes the tag, and
attaches three assets: `Kaneo-Setup-<version>.exe`, its `.blockmap`, and
`latest.yml`. That last file is what the updater actually reads — a release
without it is never offered.

(It doesn't call electron-builder's `--publish always`, because that requires the
git tag to exist first or GitHub rejects it with "Published releases must have a
valid tag". The script tags before it uploads.)

**Private repo caveat:** GitHub only serves release assets from a private repo
with authentication, so the updater needs `GH_TOKEN` set in the environment on any
machine that should auto-update. To drop that requirement, make the repo public:

```powershell
gh repo edit Huthaifa-HajAhmad/kaneo-desktop --visibility public --accept-visibility-change-consequences
```

Nothing in the repo is sensitive (it's a UI shell; your Kaneo data lives in Docker
volumes, not here), but that's your call.

Notes: unsigned Windows builds still auto-update, but the first install shows a
SmartScreen warning. An update downloads in the background and then offers
"Restart now" / "Later".

## Configuration

Environment variables (all optional):

- `KANEO_URL` — target URL (default `http://localhost:5173`)
- `KANEO_WSL_DISTRO` — WSL distro for updates (default `Ubuntu`)
- `KANEO_WSL_USER` — WSL user for updates (default `hsa19`)
- `KANEO_COMPOSE_DIR` — compose directory in WSL (default `$HOME/kaneo`)

```powershell
$env:KANEO_URL="https://kaneo.example.com"; npm start
```

## Notes

- The wrapper auto-retries the main page if the backend is unreachable.
- Links that open a new window are handed to your default browser.
- The app only works while the WSL2 Docker containers are running. `.wslconfig`
  sets `instanceIdleTimeout=-1` and `vmIdleTimeout=-1` so WSL doesn't tear the
  containers down when no console is attached.

## Troubleshooting

`Kaneo Desktop must run under Electron, not plain Node` — your shell has
`ELECTRON_RUN_AS_NODE=1` set (some Electron-based terminals do this). Use
`.\run.ps1`, or clear it: `Remove-Item Env:\ELECTRON_RUN_AS_NODE`.

## Packaging

electron-builder is already configured (`build` key in `package.json`): NSIS
target, per-user install, icon from `build/icon.ico`.

```powershell
npm run dist      # dist\Kaneo-Setup-<version>.exe
npm run release   # same, plus upload to GitHub Releases
```

A packaged app still points at a local backend, so it only makes sense as a
launcher on the machine that runs Kaneo.
