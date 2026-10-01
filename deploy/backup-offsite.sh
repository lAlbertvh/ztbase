#!/usr/bin/env bash
# Вывоз резервных копий за пределы машины.
#
#   sudo bash /opt/ztlab/deploy/backup-offsite.sh
#
# Логика простая: бэкапы лежат там же, где данные. Если сгорит диск
# ноутбука или VPS, копии исчезнут вместе с ними — бэкап, который стоит
# рядом с оригиналом, не является страховкой. Поэтому копии дублируются
# на другую машину.
#
# По умолчанию вывозится только база: она весит килобайты и восстанавливается
# целиком. Файлы пациентов (STL, сканы) по сети не вывозятся, пока
# OFFSITE_FILES не включён явно: на VPS 25 ГБ, туда может не влезть
# архив с медицинскими данными.
#
# Настройка на приёмной стороне (один раз):
#   ssh-copy-id root@157.22.175.141

set -euo pipefail

SRC_DIR="${SRC_DIR:-/var/backups/ztlab}"
DEST_HOST="${DEST_HOST:-root@157.22.175.141}"
DEST_DIR="${DEST_DIR:-/var/backups/ztlab-offsite}"
KEEP_REMOTE="${KEEP_REMOTE:-14}"
OFFSITE_FILES="${OFFSITE_FILES:-0}"

command -v rsync >/dev/null || { echo "rsync не установлен" >&2; exit 1; }
[ -d "$SRC_DIR" ] || { echo "нет каталога с копиями: $SRC_DIR" >&2; exit 1; }

# --- Проверка связи и прав ---
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEST_HOST" true 2>/dev/null; then
    echo "НЕТ ДОСТУПА к $DEST_HOST без пароля." >&2
    echo "Настройте ключ: ssh-copy-id $DEST_HOST" >&2
    exit 1
fi

ssh -o BatchMode=yes "$DEST_HOST" "mkdir -p '$DEST_DIR'" \
    || { echo "Не смог создать $DEST_DIR на $DEST_HOST" >&2; exit 1; }

# --- Что вывозим ---
EXCLUDES=(--exclude 'uploads-*.tar.gz' --exclude 'exo-prerestore-*.db')
if [ "$OFFSITE_FILES" = "1" ]; then
    echo "  файлы пациентов: ВЫВОЗЯТСЯ (проверьте свободное место на приёмной стороне)"
    # Ограничиваем размер, чтобы не забить приёмную машину.
    REMOTE_FREE_KB="$(ssh -o BatchMode=yes "$DEST_HOST" "df -Pk '$DEST_DIR' | awk 'NR==2{print \$4}'")"
    LOCAL_BYTES="$(du -sb "$SRC_DIR" | cut -f1)"
    LOCAL_KB=$((LOCAL_BYTES / 1024))
    if [ "$LOCAL_BYTES" -gt 0 ] && [ "$REMOTE_FREE_KB" -lt $((LOCAL_KB * 2)) ]; then
        echo "  ВНИМАНИЕ: на приёмной стороне ${REMOTE_FREE_KB} КБ свободно," >&2
        echo "  а копий нужно около ${LOCAL_KB} КБ. Вывоз файлов прерван." >&2
        OFFSITE_FILES=0
    fi
else
    echo "  файлы пациентов: не вывозятся (OFFSITE_FILES=0)"
fi

echo "  Вывожу копии в $DEST_HOST:$DEST_DIR"
rsync -a --delete "${EXCLUDES[@]}" \
      --timeout=120 -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
      "$SRC_DIR/" "$DEST_HOST:$DEST_DIR/"

# --- Ротация на приёмной стороне ---
# Свои копии на приёмной машине надо чистить иначе: там лежат и база,
# и файлы, и их нельзя просто перезаписать пустым rsync.
ssh -o BatchMode=yes "$DEST_HOST" "
    find '$DEST_DIR' -name 'exo-*.db' -mtime +$KEEP_REMOTE -delete
    find '$DEST_DIR' -name 'uploads-*.tar.gz' -mtime +$KEEP_REMOTE -delete
    find '$DEST_DIR' -name 'exo-*.manifest.txt' -mtime +$KEEP_REMOTE -delete
    echo -n '  на приёмной стороне: баз='
    find '$DEST_DIR' -name 'exo-*.db' | wc -l
    echo -n '  свободно: '
    df -h '$DEST_DIR' | awk 'NR==2{print \$4}'
"

log_count="$(find "$SRC_DIR" -name 'exo-*.db' | wc -l)"
echo "  Локально копий: $log_count"
echo "  Готово."
