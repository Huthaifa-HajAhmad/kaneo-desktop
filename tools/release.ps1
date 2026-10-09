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

$ErrorActionPreference = "Continue"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$tag = "v$version"
$repo = "Huthaifa-HajAhmad/kaneo-desktop"

gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "gh is not authenticated. Run: gh auth login" }

Write-Host "==> Building $tag" -ForegroundColor Cyan
npm run dist
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$exe = Join-Path $root "dist\Kaneo-Setup-$version.exe"
$blockmap = "$exe.blockmap"
$yml = Join-Path $root "dist\latest.yml"
foreach ($f in @($exe, $blockmap, $yml)) {
  if (-not (Test-Path $f)) { throw "expected build output missing: $f" }
}

Write-Host "==> Tagging $tag" -ForegroundColor Cyan
if (-not (git tag -l $tag)) {
  git tag $tag
  git push origin $tag
} else {
  Write-Host "    tag already exists"
}

Write-Host "==> Publishing" -ForegroundColor Cyan
$existing = gh release view $tag --repo $repo --json tagName 2>$null
if ($LASTEXITCODE -eq 0 -and $existing) {
  gh release upload $tag $exe $blockmap $yml --repo $repo --clobber
} else {
  gh release create $tag $exe $blockmap $yml --repo $repo --latest `
    --title "Kaneo Desktop $version" `
    --notes "Desktop wrapper for a self-hosted Kaneo instance."
}
if ($LASTEXITCODE -ne 0) { throw "publish failed" }

Write-Host "==> https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
