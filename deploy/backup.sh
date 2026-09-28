#!/usr/bin/env bash
# Резервная копия ZT Lab.
#
# Копируются две вещи, обе нужны для восстановления:
#   1. База SQLite — заказы, пользователи, настройки.
#   2. Папка uploads — сами 3D-файлы.
#
# Копия базы снимается командой .backup, а не копированием файла:
# при работающем сервисе файл базы может содержать недописанные
# страницы, и обычная копия получится битой.
#
# Запуск вручную:  sudo ./deploy/backup.sh
# В крон:          17 3 * * *  /opt/ztlab/deploy/backup.sh
set -euo pipefail

DATA_DIR=/var/lib/ztlab
BACKUP_DIR=/var/backups/ztlab
KEEP_DAYS=30
STAMP=$(date +%Y%m%d-%H%M%S)

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"
[[ -d "$DATA_DIR" ]] || fail "Нет каталога $DATA_DIR"

mkdir -p "$BACKUP_DIR"

# --- База ---
if [[ -f "$DATA_DIR/database/exo.db" ]]; then
  if command -v sqlite3 >/dev/null; then
    sqlite3 "$DATA_DIR/database/exo.db" ".backup '$BACKUP_DIR/exo-$STAMP.db'"
    log "База сохранена: exo-$STAMP.db"
  else
    fail "Нет утилиты sqlite3. Установите: apt install sqlite3"
  fi
else
  log "Пропускаю базу: файла нет"
fi

# --- 3D-файлы ---
# Копируются только изменённые: rsync сравнивает по размеру и времени,
# поэтому ночная копия гигабайтов занимает секунды.
# Начальную копию нужно делать в покое, rsync сам разберётся.
if [[ -d "$DATA_DIR/uploads" ]]; then
  rsync -a --delete \
        --link-dest="$BACKUP_DIR/uploads-latest" \
        "$DATA_DIR/uploads/" "$BACKUP_DIR/uploads-$STAMP/"
  rm -rf "$BACKUP_DIR/uploads-latest"
  ln -sfn "uploads-$STAMP" "$BACKUP_DIR/uploads-latest"
  SIZE=$(du -sh "$BACKUP_DIR/uploads-$STAMP" 2>/dev/null | cut -f1 || echo "?")
  log "Файлы сохранены: uploads-$STAMP ($SIZE)"
else
  log "Пропускаю файлы: папки uploads нет"
fi

# --- Ротация ---
# Базы храним 30 последних, файлы — 30 дней.
find "$BACKUP_DIR" -maxdepth 1 -name 'exo-*.db'       -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*'      -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true

# Если копия снята, но диск заполнен — молча пропасть хуже, чем громкая ошибка.
USE=$(df -h "$BACKUP_DIR" | awk 'NR==2 {print $5}' | tr -d '%')
if [[ "$USE" -gt 85 ]]; then
  log "ВНИМАНИЕ: диск с бэкапами заполнен на ${USE}%"
fi

log "Готово. Всего в $BACKUP_DIR: $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
