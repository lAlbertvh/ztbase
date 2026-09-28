#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
    echo "Устанавливаю зависимости..."
    npm install
fi

node server.js