#!/usr/bin/env bash
# Обновление ZT Lab на ноутбуке.
#
# Код ставится в /opt/ztlab, данные — в /var/lib/ztlab.
# Разделено намеренно: обновление кода не должно задевать
# базу и загруженные 3D-файлы.
#
# Запуск:  sudo ./deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/ztlab
DATA_DIR=/var/lib/ztlab
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=ztlab

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"

# --- 1. Проверки до остановки сервиса ---
command -v node >/dev/null || fail "node не найден. Установите Node 22 (см. README)"

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [[ "$NODE_MAJOR" != "22" ]]; then
  # better-sqlite3 не собирается под Node 26: V8 убрал info.This().
  fail "Нужен Node 22, а стоит $(node -v). Подробности в deploy/README.md"
fi

log "Проверка конфигурации: /etc/ztlab/ztlab.env"
[[ -f /etc/ztlab/ztlab.env ]] || fail "Нет файла /etc/ztlab/ztlab.env — приложение не запустится без SESSION_SECRET"
grep -qE '^SESSION_SECRET=.+' /etc/ztlab/ztlab.env || fail "В /etc/ztlab/ztlab.env пустой SESSION_SECRET"

# Приложение не должно слушать наружу: перед ним стоит nginx, и порт
# 3000 в интернете — это доступ к базе в обход TLS и лимитов.
if grep -qE '^HOST=0\.0\.0\.0' /etc/ztlab/ztlab.env; then
  fail "В /etc/ztlab/ztlab.env HOST=0.0.0.0. Приложение должно слушать 127.0.0.1"
fi

# --- 2. Останавливаем сервис ---
if systemctl is-active --quiet "$SERVICE"; then
  log "Останавливаю $SERVICE"
  systemctl stop "$SERVICE"
else
  log "$SERVICE не запущен, продолжаю"
fi

# --- 3. Резервная копия базы перед обновлением ---
if [[ -f "$DATA_DIR/database/exo.db" ]]; then
  BACKUP_DIR=/var/backups/ztlab
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  # Копия делается через .backup, а не копированием файла: при работающем
  # сервисе в базе может быть недописанная страница, и простая копия
  # получится битой.
  if sqlite3 "$DATA_DIR/database/exo.db" ".backup '$BACKUP_DIR/exo-$STAMP.db'" 2>/dev/null; then
    log "База сохранена: $BACKUP_DIR/exo-$STAMP.db"
  else
    log "ВНИМАНИЕ: не смог снять копию базы (нужен пакет sqlite3)"
  fi
  # Храним последние 30 копий, старые удаляем.
  ls -1t "$BACKUP_DIR"/exo-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f
fi

# --- 4. Копируем новый код ---
log "Обновляю код в $APP_DIR"
mkdir -p "$APP_DIR"
# Копируем только код. Каталоги с данными (database/, uploads/) и .env
# не трогаем: без --delete старые файлы приложения останутся
# (например views при обновлении), поэтому чистим их отдельно.
rsync -a --exclude 'node_modules' --exclude '.git' \
      --exclude 'database' --exclude 'uploads' --exclude '.env' \
      "$SRC_DIR"/ "$APP_DIR"/

# Старые файлы кода, которых больше нет в новой версии
for d in views public src; do
  rsync -a --delete "$SRC_DIR/$d"/ "$APP_DIR/$d"/
done

# --- 5. Зависимости ---
log "Ставлю зависимости (npm ci берёт точные версии из package-lock.json)"
cd "$APP_DIR"
npm ci --omit=dev || fail "npm ci не прошёл. Чаще всего нет сети для сборки better-sqlite3 — проверьте, что установлены build-essential и python3"

mkdir -p "$DATA_DIR/database" "$DATA_DIR/uploads"
chown -R ztlab:ztlab "$APP_DIR" "$DATA_DIR"

# --- 6. Запуск ---
log "Запускаю $SERVICE"
systemctl start "$SERVICE"
sleep 3

# Туннель нужен только в схеме «приложение на ноутбуке, VPS только лендинг».
# На VPS, где приложение живёт рядом с nginx, туннель не нужен и не ставится.
TUNNEL=ztlab-tunnel
if systemctl list-unit-files "$TUNNEL.service" --no-legend 2>/dev/null | grep -q .; then
  # Объявлен как Requires=ztlab.service, поэтому systemd останавливает его
  # вместе с приложением. Если не поднять обратно, публичный сайт будет
  # отдавать 502 до следующей перезагрузки.
  log "Поднимаю туннель $TUNNEL"
  systemctl start "$TUNNEL" || log "ВНИМАНИЕ: $TUNNEL не запустился — сайт будет недоступен снаружи"
else
  log "Туннель не используется (схема VPS)"
fi
sleep 2

if ! systemctl is-active --quiet "$SERVICE"; then
  log "Сервис не поднялся. Последние строки журнала:"
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  fail "Запуск не удался"
fi

# Проверка живости. На VPS приложение слушает петлю, поэтому проверяем
# 127.0.0.1; адрес WireGuard используется только в схеме с ноутбуком.
if curl -sf --max-time 5 "http://127.0.0.1:3000/health" >/dev/null; then
  log "Проверка живости: ок (127.0.0.1:3000)"
else
  WG_IP=$(sed -n 's/^HOST=//p' /etc/ztlab/ztlab.env | tail -1 | tr -d '"' || true)
  if [[ -n "${WG_IP:-}" ]] && curl -sf --max-time 5 "http://$WG_IP:3000/health" >/dev/null; then
    log "Проверка живости: ок ($WG_IP)"
  else
    log "ВНИМАНИЕ: /health не отвечает. Приложение запущено, но не отвечает по HTTP"
  fi
fi

log "Готово. Версия: $(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo 'не из git')"
systemctl --no-pager status "$SERVICE" | head -10
