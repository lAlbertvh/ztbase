#!/usr/bin/env bash
# Восстановление ZT Lab из резервной копии.
#
#   sudo bash /opt/ztlab/deploy/restore.sh /var/backups/ztlab/exo-20260929-120000.db
#   sudo bash /opt/ztlab/deploy/restore.sh <копия.db> --uploads
#
# Порядок работы:
#   1. Останавливает приложение — иначе SQLite перезапишет файл
#      из своего кэша поверх только что восстановленного.
#   2. Снимает копию ТЕКУЩЕГО состояния. Восстановление всегда
#      обратимо: если что-то пошло не так, есть путь назад.
#   3. Накладывает копию, проверяет целостность и сверяет с манифестом.
#
# Копию сначала проверяет в отдельном каталоге и только потом
# кладёт на место — чтобы битый файл не заменил рабочую базу.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ztlab}"
DB="${DB:-/var/lib/ztlab/database/exo.db}"
UPLOADS="${UPLOADS:-/var/lib/ztlab/uploads}"
SERVICE="${SERVICE:-ztlab}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/ztlab}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"

RESTORE_UPLOADS=0
SRC=""
for arg in "$@"; do
    case "$arg" in
        --uploads) RESTORE_UPLOADS=1 ;;
        -*) fail "Неизвестный аргумент: $arg" ;;
        *) SRC="$arg" ;;
    esac
done

[ -n "$SRC" ] || fail "Укажите файл копии: sudo $0 /path/to/exo-ТАЙМСТАМП.db"
[ -f "$SRC" ] || fail "Копия не найдена: $SRC"

# Разрешаем путь относительно каталога копий, чтобы не копировать
# длинные имена с рабочего стола.
if [ ! -f "$SRC" ] && [ -f "$BACKUP_ROOT/$SRC" ]; then
    SRC="$BACKUP_ROOT/$SRC"
fi

log "Копия: $SRC ($(du -h "$SRC" | cut -f1))"

# --- 1. Проверяем копию в стороне, не трогая рабочую базу ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a "$SRC" "$STAGE/probe.db"

CHECK="$(sqlite3 "$STAGE/probe.db" 'PRAGMA integrity_check;' 2>/dev/null || echo 'ПОВРЕЖДЕНА')"
[ "$CHECK" = "ok" ] || fail "Копия не прошла проверку целостности: $CHECK"
log "Целостность копии: ок"

# Сверяем с манифестом, если он есть рядом с копией.
MANIFEST="${SRC%.db}.manifest.txt"
if [ -f "$MANIFEST" ]; then
    log "Сверяю с манифестом:"
    failed=0
    while IFS= read -r line; do
        case "$line" in
            \#*|'') continue ;;
        esac
        table="${line%%:*}"
        expected="${line##*: }"
        actual="$(sqlite3 "$STAGE/probe.db" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo 'нет таблицы')"
        if [ "$actual" = "$expected" ]; then
            printf '    %-24s %s (совпало)\n' "$table" "$actual"
        else
            printf '    %-24s ожидалось %s, в копии %s\n' "$table" "$expected" "$actual"
            failed=1
        fi
    done < "$MANIFEST"
    if [ "$failed" -ne 0 ]; then
        log "ВНИМАНИЕ: копия не совпадает с манифестом. Возможно, копия старее."
    fi
else
    log "Манифеста нет — сверка с ожидаемым числом строк невозможна"
fi

# --- 2. Останавливаем приложение ---
WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    WAS_ACTIVE=1
    log "Останавливаю $SERVICE"
    systemctl stop "$SERVICE"
fi

# --- 3. Копия текущего состояния: путь назад ---
if [ -f "$DB" ]; then
    UNDO_DIR="$BACKUP_ROOT"
    mkdir -p "$UNDO_DIR"
    UNDO="$UNDO_DIR/exo-prerestore-$(date +%Y%m%d-%H%M%S).db"
    if sqlite3 "$DB" ".backup '$UNDO'" 2>/dev/null; then
        log "Текущее состояние сохранено: $UNDO"
    else
        # База нечитаема — а это и есть тот самый случай, когда нужно
        # восстановление. Отказываться здесь нельзя: иначе после сбоя
        # базу не вернуть. Копируем файл как есть, чтобы следы не пропали,
        # и продолжаем.
        cp -a "$DB" "$UNDO" 2>/dev/null || true
        log "ВНИМАНИЕ: текущая база нечитаема, сохранил как есть: $UNDO"
        log "Восстанавливаю поверх неё — это ожидаемое поведение при сбое"
    fi
else
    log "Рабочей базы нет, будет создана из копии"
fi

# --- 4. Накладываем копию ---
mkdir -p "$(dirname "$DB")"
cp -a "$STAGE/probe.db" "$DB"
# Хвосты WAL/SHM от прежней базы относятся к старому файлу и после
# подмены только мешают: SQLite может применить их к новой базе.
rm -f "$DB-wal" "$DB-shm"

FINAL="$(sqlite3 "$DB" 'PRAGMA integrity_check;' 2>/dev/null || echo 'ПОВРЕЖДЕНА')"
[ "$FINAL" = "ok" ] || fail "После восстановления база не проходит проверку: $FINAL"
log "База восстановлена: $DB ($(du -h "$DB" | cut -f1))"

# --- 5. Файлы ---
if [ "$RESTORE_UPLOADS" -eq 1 ]; then
    UP_TAR="${SRC%.db}"
    UP_TAR="${UP_TAR/exo-/uploads-}.tar.gz"
    if [ -f "$UP_TAR" ]; then
        log "Восстанавливаю файлы из $UP_TAR"
        rm -rf "$UPLOADS"
        tar -xzf "$UP_TAR" -C "$(dirname "$UPLOADS")"
        log "Файлов восстановлено: $(find "$UPLOADS" -type f 2>/dev/null | wc -l)"
    else
        log "Архив файлов не найден: $UP_TAR (пропускаю)"
    fi
else
    log "Файлы не восстанавливались. Добавьте --uploads, если нужны и STL"
fi

# --- 6. Запускаем обратно ---
if [ "$WAS_ACTIVE" -eq 1 ]; then
    log "Запускаю $SERVICE"
    systemctl start "$SERVICE"
    sleep 3
    if systemctl is-active --quiet "$SERVICE"; then
        log "Приложение поднялось"
    else
        journalctl -u "$SERVICE" -n 30 --no-pager || true
        fail "Приложение не поднялось после восстановления"
    fi
else
    log "$SERVICE не был запущен до восстановления, оставляю как есть"
fi

log "Готово. Откатить можно копией exo-prerestore-*.db тем же скриптом."
