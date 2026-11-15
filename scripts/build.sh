#!/usr/bin/env bash
# Builds LED Monitor from this checkout.
#
#   scripts/build.sh          install, typecheck, test, and build the dashboard and the server
#   scripts/build.sh mac      all of that, then package the Mac app (packages/launcher/release/*.dmg). Run on a Mac.
#   scripts/build.sh windows  all of that, then package the Windows installer (packages/launcher/release/*.exe). Run
#                             on Windows from Git Bash.
#   scripts/build.sh run      build, then run the server here in demo mode (two simulated SX40s) on port 6060
#
# SKIP_TESTS=1 skips typecheck and tests. The version comes from the release tags (scripts/app-version.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-all}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js 22 or newer is needed: https://nodejs.org (or: brew install node)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node.js 22 or newer is needed (this shell has $(node -v))."

case "$mode" in
  all|mac|windows|run) ;;
  *) die "Unknown mode \"$mode\". Use: scripts/build.sh [mac|windows|run]" ;;
esac
if [ "$mode" = mac ] && [ "$(uname)" != Darwin ]; then
  die "The Mac app can only be packaged on a Mac. GitHub Actions builds it on every pull request (Mac app workflow)."
fi

# The version shown in the dashboard and the app comes from the release tags.
git fetch --tags --quiet origin 2>/dev/null || echo "Could not fetch release tags; the version may show as -dev." >&2
APP_VERSION="$(scripts/app-version.sh 2>/dev/null || echo dev)"
export APP_VERSION
say "LED Monitor $APP_VERSION"

if [ "$mode" = windows ]; then
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) die "The Windows installer can only be packaged on Windows. GitHub Actions builds it on every pull request (Windows app workflow)." ;; esac
fi

# Only app packaging needs Electron's own binary.
if [ "$mode" != mac ] && [ "$mode" != windows ]; then export ELECTRON_SKIP_BINARY_DOWNLOAD=1; fi
say "Installing packages"
npm ci --no-audit --no-fund

if [ "${SKIP_TESTS:-0}" != 1 ]; then
  say "Typecheck and tests"
  npm run typecheck
  npm test
fi

say "Building the dashboard and the server"
npm run build

case "$mode" in
  mac|windows)
    # electron-builder wants a plain semver: v1.2.3 -> 1.2.3, v1.2.3-dev stays a prerelease, "dev" becomes 0.0.0-dev.
    semver="${APP_VERSION#v}"
    [[ "$semver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || semver="0.0.0-dev"
    # npm workspaces install Electron at the repo root, where electron-builder does not look, so name the version.
    electron="$(node -p "require('electron/package.json').version")"
    npm run build -w @ledmon/launcher
    if [ "$mode" = mac ]; then
      say "Packaging the Mac app"
      (cd packages/launcher && npx electron-builder --mac --publish never \
        -c.electronVersion="$electron" -c.extraMetadata.version="$semver")
      say "Built $(ls -t packages/launcher/release/*.dmg | head -n1)"
    else
      say "Packaging the Windows installer"
      (cd packages/launcher && npx electron-builder --win --publish never \
        -c.electronVersion="$electron" -c.extraMetadata.version="$semver")
      say "Built $(ls -t packages/launcher/release/*.exe | head -n1)"
    fi
    ;;
  run)
    say "Starting the server in demo mode. Open http://localhost:6060 (Ctrl+C to stop)"
    exec node packages/server/dist/cli.cjs --simulate --data ./data
    ;;
  *)
    say "Done. Run the server with: node packages/server/dist/cli.cjs --data ./data"
    ;;
esac
