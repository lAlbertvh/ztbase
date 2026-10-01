#!/usr/bin/env bash
# Резервное копирование ZT Lab: база, загруженные файлы, манифест.
#
#   sudo bash /opt/ztlab/deploy/backup.sh
#
# Копия базы делается через .backup, а не простым копированием файла:
# база работает в режиме WAL, поэтому рядом лежат exo.db-wal и exo.db-shm.
# Обычный cp в момент записи даёт битую копию. Команда .backup сама
# учитывает WAL, поэтому отдельные -wal/-shm копировать не нужно.
#
# Загруженные файлы (STL, сканы, фото) — это данные пациентов, и раньше
# они не копировались вообще. Теперь копируются отдельным архивом.
# Если архив не нужен, выключается переменной BACKUP_UPLOADS=0.

set -euo pipefail

DB="${DB:-/var/lib/ztlab/database/exo.db}"
UPLOADS="${UPLOADS:-/var/lib/ztlab/uploads}"
DEST="${DEST:-/var/backups/ztlab}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_UPLOADS="${BACKUP_UPLOADS:-1}"
# Минимальный запас свободного места перед попыткой архивировать файлы.
MIN_FREE_MB="${MIN_FREE_MB:-100}"

command -v sqlite3 >/dev/null || { echo "sqlite3 не установлен" >&2; exit 1; }
[ -f "$DB" ] || { echo "нет базы: $DB" >&2; exit 1; }

mkdir -p "$DEST"
# Копии содержат хэши паролей и данные пациентов: группа ztlab читает
# (восстановление проверяет копию не обязательно от root), остальные —
# нет. Каталог остаётся 750, иначе «остальные» не дойдут и до файла.
if [[ -z "${BACKUP_GROUP:-}" ]]; then
  BACKUP_GROUP=$(id -gn ztlab 2>/dev/null || echo root)
fi
chown root:"$BACKUP_GROUP" "$DEST" 2>/dev/null || true
chmod 750 "$DEST"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/exo-$STAMP.db"
MANIFEST="$DEST/exo-$STAMP.manifest.txt"

# --- 1. База ---
sqlite3 "$DB" ".backup '$OUT'"

# Проверяем, что копия читается: пустой или битый файл бесполезен.
CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>/dev/null || echo 'ПОВРЕЖДЕНА')"
if [ "$CHECK" != "ok" ]; then
  echo "Копия не прошла проверку целостности: $CHECK" >&2
  rm -f "$OUT"
  exit 1
fi
echo "  база:     $OUT ($(du -h "$OUT" | cut -f1))"

# --- 2. Манифест ---
# Число строк в ключевых таблицах. После восстановления сверяют с ним,
# иначе «база восстановилась» ничего не значит: пустая база тоже читается.
{
  echo "# ZT Lab backup manifest"
  echo "# generated: $(date -Is)"
  echo "# source_db: $DB"
  echo "# db_size: $(stat -c%s "$OUT")"
  for t in labs users orders order_teeth order_stages order_manipulations manipulation_log files; do
    if sqlite3 "$OUT" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t';" | grep -q 1; then
      echo "$t: $(sqlite3 "$OUT" "SELECT COUNT(*) FROM $t;")"
    fi
  done
} > "$MANIFEST"
# Права ставим после создания: umask скрипта запускается из systemd,
# где маска по умолчанию 0022, и файл получает 644 — доступен всем.
chown root:"$BACKUP_GROUP" "$OUT" "$MANIFEST" 2>/dev/null || true
chmod 640 "$OUT" "$MANIFEST" 2>/dev/null || true
echo "  манифест: $MANIFEST"

# --- 3. Файлы ---
if [ "$BACKUP_UPLOADS" = "1" ] && [ -d "$UPLOADS" ]; then
  UPLOAD_TAR="$DEST/uploads-$STAMP.tar.gz"
  UPLOAD_COUNT="$(find "$UPLOADS" -type f 2>/dev/null | wc -l)"
  if [ "$UPLOAD_COUNT" -eq 0 ]; then
    # Пустой каталог архивировать незачем: вложение без файлов
    # распаковывается в никуда и только путает при разборе копий.
    echo "  файлы:    нет, каталог $UPLOADS пуст"
  else
    # Бэкап файлов ложится на тот же диск, что и сами файлы. На тесном
    # месте архив способен съесть свободное пространство и положить
    # приложение — копия не должна убивать то, что копирует.
    SRC_BYTES="$(du -sb "$UPLOADS" | cut -f1)"
    # STL и DICOM сжимаются слабо, поэтому берём с запасом.
    EST_BYTES=$((SRC_BYTES / 2))
    FREE_BYTES="$(df -PB1 "$(dirname "$DEST")" | awk 'NR==2{print $4}')"
    if [ "$FREE_BYTES" -lt $((EST_BYTES * 2 + MIN_FREE_MB * 1048576)) ]; then
      echo "  файлы:    ПРОПУЩЕНО — мало места (нужно ~$((EST_BYTES / 1048576)) МБ," >&2
      echo "            свободно $((FREE_BYTES / 1048576)) МБ, запас $MIN_FREE_MB МБ). База сохранена." >&2
      echo "            Выгрузите копии через deploy/backup-offsite.sh" >&2
    else
      tar -czf "$UPLOAD_TAR" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
      echo "  файлы:    $UPLOAD_TAR ($(du -h "$UPLOAD_TAR" | cut -f1), файлов: $UPLOAD_COUNT)"
      # С префиксом # : при восстановлении скрипт считает строками таблиц
      # только то, что начинается с имени таблицы, и не пытается сделать
      # SELECT COUNT(*) FROM uploads.
      echo "# uploads_files: $UPLOAD_COUNT" >> "$MANIFEST"
    fi
  fi
fi

# --- 4. Ротация ---
# Чистим и базу, и архивы файлов, и манифесты: оставлять старые копии
# базы без соответствующих файлов бессмысленно, но и наоборот.
find "$DEST" -name 'exo-*.db' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'exo-*.manifest.txt' -mtime "+$KEEP_DAYS" -delete

echo "  копий базы осталось:  $(find "$DEST" -name 'exo-*.db' | wc -l)"
echo "  архивов файлов:       $(find "$DEST" -name 'uploads-*.tar.gz' | wc -l)"
echo "  свободно на диске:    $(df -h "$(dirname "$DEST")" | awk 'NR==2{print $4}')"
