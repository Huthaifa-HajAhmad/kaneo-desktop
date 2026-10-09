# Builds the installer and publishes it as a GitHub release the updater can see.
#
#   $env:GH_TOKEN = gh auth token
#   npm run release
#
# electron-builder's own `--publish always` requires the git tag to exist before
# it runs (otherwise GitHub rejects it with "Published releases must have a valid
# tag"), so this script owns the whole flow instead: tag first, then upload.
#
# The asset list matters. electron-updater reads `latest.yml` from the release to
# learn the newest version and its sha512. A release without it is never offered.

$ErrorActionPreference = "Stop"

$version = (Get-Content (Join-Path $PSScriptRoot ".." "package.json") -Raw | ConvertFrom-Json).version
$tag = "v$version"
$repo = "Huthaifa-HajAhmad/kaneo-desktop"

if (-not $env:GH_TOKEN) {
  throw "GH_TOKEN is not set. Run:  `$env:GH_TOKEN = gh auth token"
}

Write-Host "==> Building $tag" -ForegroundColor Cyan
npm run dist
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$exe = "dist/Kaneo-Setup-$version.exe"
foreach ($f in @($exe, "$exe.blockmap", "dist/latest.yml")) {
  if (-not (Test-Path $f)) { throw "expected build output missing: $f" }
}

Write-Host "==> Tagging $tag" -ForegroundColor Cyan
git rev-parse -q --verify "refs/tags/$tag" *> $null
if ($LASTEXITCODE -ne 0) {
  git tag $tag
  git push origin $tag
} else {
  Write-Host "    tag already exists"
}

$assets = @($exe, "$exe.blockmap", "dist/latest.yml")

Write-Host "==> Publishing" -ForegroundColor Cyan
gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
  gh release upload $tag @assets --repo $repo --clobber
} else {
  gh release create $tag @assets --repo $repo --latest `
    --title "Kaneo Desktop $version" `
    --notes "Desktop wrapper for a self-hosted Kaneo instance."
}

if ($LASTEXITCODE -ne 0) { throw "publish failed" }
Write-Host "==> https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
