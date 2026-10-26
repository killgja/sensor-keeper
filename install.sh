#!/usr/bin/env bash
# Sensor Keeper installer for macOS, Linux and Raspberry Pi.
#   curl -fsSL https://raw.githubusercontent.com/killgja/sensor-keeper/main/install.sh | bash
# Downloads the standalone program (no Node.js needed), puts it in
# ~/.sensor-keeper/bin, adds a "sensor-keeper" command and an app icon, and opens the app.
set -euo pipefail

REPO="${SENSOR_KEEPER_REPO:-killgja/sensor-keeper}"
BASE="https://github.com/${REPO}/releases/latest/download"
DIR="$HOME/.sensor-keeper/bin"
mkdir -p "$DIR"; chmod 700 "$HOME/.sensor-keeper"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
# 1.8.1: check every download against the release's SHA256SUMS.txt, and check that file's signature
# (Sky Warden release key) where OpenSSL 3 is available.
PUBKEY='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIn+HiXl1K7chMOtwES5HUn/46r++NYw2BFsPoeoYWAI=\n-----END PUBLIC KEY-----'
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
SUMS="$DIR/.sums.$$"
get_sums() {
  [ -s "$SUMS" ] && return 0
  fetch "$BASE/SHA256SUMS.txt" "$SUMS" || { echo "Couldn't download SHA256SUMS.txt from the release."; return 1; }
  if command -v openssl >/dev/null && openssl version 2>/dev/null | grep -q '^OpenSSL [3-9]'; then
    if fetch "$BASE/SHA256SUMS.txt.sig" "$SUMS.sig" 2>/dev/null; then
      printf '%b\n' "$PUBKEY" > "$SUMS.pub"; base64 -d < "$SUMS.sig" > "$SUMS.bin" 2>/dev/null || openssl base64 -d -A < "$SUMS.sig" > "$SUMS.bin"
      openssl pkeyutl -verify -pubin -inkey "$SUMS.pub" -rawin -in "$SUMS" -sigfile "$SUMS.bin" >/dev/null 2>&1 \
        || { echo "The release's signature is wrong - not installing."; rm -f "$SUMS"*; return 1; }
      echo "Release signature OK."
    else echo "(This release isn't signed yet; checking checksums only.)"; fi
  fi
}
verify() {  # verify FILE ASSET-NAME
  get_sums || return 1
  want=$(awk -v f="$2" '$2==f || $2=="*"f {print $1}' "$SUMS")
  [ -n "$want" ] && [ "$want" = "$(sha256 "$1")" ] || { echo "Checksum mismatch for $2 - not installing."; return 1; }
}
trap 'rm -f "$SUMS" "$SUMS".sig "$SUMS".pub "$SUMS".bin' EXIT

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
  verify "$DIR/sensor-keeper.tmp" "$asset" || { rm -f "$DIR/sensor-keeper.tmp"; exit 1; }
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
  fetch "$BASE/keeper.js" "$DIR/keeper.js.tmp"
  verify "$DIR/keeper.js.tmp" keeper.js || { rm -f "$DIR/keeper.js.tmp"; exit 1; }
  mv "$DIR/keeper.js.tmp" "$DIR/keeper.js"
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
# Make sure new terminal windows can find it (checks the shell startup files,
# not just this session's PATH, which may differ from the user's own shell).
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$rc" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "$os" = Darwin ]; }; then
    if [ "$LINKDIR" != /usr/local/bin ] && ! grep -q 'sensor-keeper PATH' "$rc" 2>/dev/null; then
      printf '\nexport PATH="%s:$PATH"  # sensor-keeper PATH\n' "$LINKDIR" >> "$rc"
    fi
  fi
done
export PATH="$LINKDIR:$PATH"

say "Installed: $TARGET"
echo "(Open a new Terminal window to use the \"sensor-keeper\" command.)"
echo
"$TARGET" install-launcher || true
echo
if [ "$os" = Darwin ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  # Desktop: open the Sensor Keeper app window in the web browser.
  nohup "$TARGET" ui >/dev/null 2>&1 &
  say "Sensor Keeper is opening in your web browser — enter your details there and press Save."
  if [ "$os" = Darwin ]; then echo "Next time, open it from your Applications folder (Sensor Keeper)."
  else echo "Next time, open it from your app menu (Sensor Keeper) or run: sensor-keeper ui"; fi
  echo "Prefer the terminal? Run: sensor-keeper setup"
else
  # No desktop (e.g. a headless Raspberry Pi): answer the questions here instead.
  if [ -t 0 ]; then "$TARGET" setup
  elif (: < /dev/tty) 2>/dev/null; then "$TARGET" setup < /dev/tty
  else echo "Now run:  sensor-keeper setup"; fi
fi
