#!/usr/bin/env bash
# Puts the current build where it runs.
#
#   scripts/deploy.sh             on a Mac: build the app, install it in /Applications and start it
#   scripts/deploy.sh headless    on any machine with Node 22 and pm2: build, then run the server under pm2 as
#                                 "led-monitor" (no menu bar app), e.g. on a spare machine in the rack
#
# Pull first if you want the latest: git pull && scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-mac}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

case "$mode" in
  mac)
    [ "$(uname)" = Darwin ] || die "Use scripts/deploy.sh headless on this machine; the app is for macOS."
    scripts/build.sh mac
    app="$(find packages/launcher/release -maxdepth 2 -name 'LED Monitor.app' -type d | head -n1)"
    [ -n "$app" ] || die "The build finished but no LED Monitor.app was found in packages/launcher/release."
    if pgrep -xq "LED Monitor"; then
      say "Quitting the running LED Monitor"
      osascript -e 'quit app "LED Monitor"' || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq "LED Monitor" || break; sleep 1; done
    fi
    say "Installing in /Applications"
    rm -rf "/Applications/LED Monitor.app"
    cp -R "$app" /Applications/
    # A locally built copy is not notarized; clear the download flag so macOS opens it without a warning.
    xattr -dr com.apple.quarantine "/Applications/LED Monitor.app" 2>/dev/null || true
    open "/Applications/LED Monitor.app"
    say "LED Monitor is running. Look for its icon in the menu bar."
    ;;
  headless)
    command -v pm2 >/dev/null || die "pm2 is needed: npm install -g pm2"
    scripts/build.sh
    if pm2 describe led-monitor >/dev/null 2>&1; then
      pm2 reload ecosystem.config.cjs --update-env
    else
      pm2 start ecosystem.config.cjs
    fi
    pm2 save >/dev/null
    port="$(node -p 'try{require("./data/config.json").port}catch{8080}')"
    if curl -fs --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:${port}/healthz" >/dev/null; then
      say "LED Monitor is answering on port ${port}. Settings: $(pwd)/data/config.json"
    else
      die "LED Monitor did not answer. Look at: pm2 logs led-monitor"
    fi
    ;;
  *) die "Unknown mode \"$mode\". Use: scripts/deploy.sh [headless]" ;;
esac
