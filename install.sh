#!/usr/bin/env bash
# Sensor Keeper installer for macOS, Linux and Raspberry Pi.
#   curl -fsSL https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.sh | bash
# Downloads the standalone program (no Node.js needed), puts it in
# ~/.sensor-keeper/bin, adds a "sensor-keeper" command, and starts setup.
set -euo pipefail

REPO="${SENSOR_KEEPER_REPO:-killgja/sensor-keeper}"
BASE="https://github.com/${REPO}/releases/latest/download"
DIR="$HOME/.sensor-keeper/bin"
mkdir -p "$DIR"; chmod 700 "$HOME/.sensor-keeper"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }

os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)          asset=sensor-keeper-darwin-arm64 ;;
  Darwin/x86_64)         asset=sensor-keeper-darwin-x64 ;;
  Linux/x86_64)          asset=sensor-keeper-linux-x64 ;;
  Linux/aarch64|Linux/arm64) asset=sensor-keeper-linux-arm64 ;;
  *)                     asset="" ;;
esac

say "Installing Sensor Keeper for $os/$arch…"
if [ -n "$asset" ] && fetch "$BASE/$asset" "$DIR/sensor-keeper.tmp"; then
  mv "$DIR/sensor-keeper.tmp" "$DIR/sensor-keeper"
  chmod 755 "$DIR/sensor-keeper"
  [ "$os" = Darwin ] && xattr -d com.apple.quarantine "$DIR/sensor-keeper" 2>/dev/null || true
  TARGET="$DIR/sensor-keeper"
else
  # No standalone build for this machine (e.g. 32-bit Raspberry Pi OS): use Node.js.
  if ! command -v node >/dev/null || [ "$(node -p 'parseInt(process.versions.node)')" -lt 18 ]; then
    echo "No standalone build for $os/$arch, and Node.js 18+ isn't installed."
    echo "Install Node.js (e.g. 'sudo apt install nodejs' or https://nodejs.org) and run this again."
    exit 1
  fi
  fetch "$BASE/keeper.js" "$DIR/keeper.js"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$DIR/keeper.js" > "$DIR/sensor-keeper"
  chmod 755 "$DIR/sensor-keeper"
  TARGET="$DIR/sensor-keeper"
fi

# Put a "sensor-keeper" command on the PATH.
LINKDIR=""
for d in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then LINKDIR="$d"; break; fi
done
if [ -z "$LINKDIR" ]; then LINKDIR="$HOME/.local/bin"; mkdir -p "$LINKDIR"; fi
ln -sf "$TARGET" "$LINKDIR/sensor-keeper"
case ":$PATH:" in *":$LINKDIR:"*) ;; *)
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || [ "$rc" = "$HOME/.zshrc" -a "$os" = Darwin ] || continue
    grep -q 'sensor-keeper PATH' "$rc" 2>/dev/null || printf '\nexport PATH="%s:$PATH"  # sensor-keeper PATH\n' "$LINKDIR" >> "$rc"
  done
  export PATH="$LINKDIR:$PATH" ;;
esac

say "Installed: $TARGET"
echo
# Run setup interactively even when this script was piped from curl.
if [ -t 0 ]; then "$TARGET" setup
elif (: < /dev/tty) 2>/dev/null; then "$TARGET" setup < /dev/tty
else echo "Now run:  sensor-keeper setup"; fi
