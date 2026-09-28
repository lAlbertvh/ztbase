#!/usr/bin/env bash
# Сборка exo в единый исполняемый файл для Linux/Windows/macOS.
# Каждый нативный модуль better-sqlite3 собирается под свою ОС,
# pkg подхватывает его из node_modules/better-sqlite3/build/Release/.
set -e

cd "$(dirname "$0")"
export PATH="$HOME/.local/node/v20/bin:$PATH"
export PATH="$(pwd)/node_modules/.bin:$PATH"

NATIVE=node_modules/better-sqlite3/build/Release/better_sqlite3.node
ORIGINAL="$NATIVE.linux.bak"

if [ ! -f "$ORIGINAL" ]; then
  cp "$NATIVE" "$ORIGINAL"
fi

restore_linux() {
  cp "$ORIGINAL" "$NATIVE"
}

mkdir -p dist prebuilds

# ---- Windows ----
echo "=== Windows x64 ==="
if [ ! -f prebuilds/better_sqlite3-win32-x64.node ]; then
  curl -sL -o /tmp/bsqlite-win.tar.gz \
    "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.6.0/better-sqlite3-v12.6.0-node-v115-win32-x64.tar.gz"
  tar -xzf /tmp/bsqlite-win.tar.gz -C /tmp
  cp /tmp/build/Release/better_sqlite3.node prebuilds/better_sqlite3-win32-x64.node
fi
cp prebuilds/better_sqlite3-win32-x64.node "$NATIVE"
pkg . --targets node20-win-x64 --output dist/exo-win.exe
restore_linux

# ---- macOS ----
echo "=== macOS x64 ==="
if [ ! -f prebuilds/better_sqlite3-darwin-x64.node ]; then
  curl -sL -o /tmp/bsqlite-mac.tar.gz \
    "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.6.0/better-sqlite3-v12.6.0-node-v115-darwin-x64.tar.gz"
  tar -xzf /tmp/bsqlite-mac.tar.gz -C /tmp
  cp /tmp/build/Release/better_sqlite3.node prebuilds/better_sqlite3-darwin-x64.node
fi
cp prebuilds/better_sqlite3-darwin-x64.node "$NATIVE"
pkg . --targets node20-macos-x64 --output dist/exo-macos
restore_linux

# ---- Linux ----
echo "=== Linux x64 ==="
pkg . --targets node20-linux-x64 --output dist/exo-linux

# ---- Linux arm64 (для Raspberry Pi и т.п.) ----
echo "=== Linux arm64 ==="
if [ ! -f prebuilds/better_sqlite3-linux-arm64.node ]; then
  curl -sL -o /tmp/bsqlite-arm.tar.gz \
    "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.6.0/better-sqlite3-v12.6.0-node-v115-linux-arm64.tar.gz"
  tar -xzf /tmp/bsqlite-arm.tar.gz -C /tmp
  cp /tmp/build/Release/better_sqlite3.node prebuilds/better_sqlite3-linux-arm64.node
fi
cp prebuilds/better_sqlite3-linux-arm64.node "$NATIVE"
pkg . --targets node20-linux-arm64 --output dist/exo-linux-arm64
restore_linux

echo
echo "Готово! Файлы в dist/:"
ls -la dist/