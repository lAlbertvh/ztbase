#!/usr/bin/env bash
# Первая установка ZT Lab на ноутбуке.
# Запуск: sudo ./install-laptop.sh
#
# Создаёт пользователя ztlab, кладёт код в /opt/ztlab,
# данные — в /var/lib/ztlab, включает автозапуск.
# Ключи и сертификат здесь не настраиваются: см. README.md
set -euo pipefail

APP_DIR=/opt/ztlab
DATA_DIR=/var/lib/ztlab
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"

# --- Node 22 ---
if ! command -v node >/dev/null; then
  log "Устанавливаю Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[[ "$NODE_MAJOR" == "22" ]] || fail "Нужен Node 22, а стоит $(node -v). Подробности в deploy/README.md"

# --- Инструменты для сборки better-sqlite3 ---
# Обычно скачивается готовая сборка, но без сети нужен компилятор.
log "Ставлю инструменты сборки и утилиты"
apt-get update -qq
apt-get install -y -qq build-essential python3 sqlite3 rsync

# --- Пользователь ---
if ! id -u ztlab >/dev/null 2>&1; then
  log "Создаю пользователя ztlab"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin ztlab
fi

# --- Каталоги ---
log "Готовлю каталоги"
mkdir -p "$APP_DIR" "$DATA_DIR/database" "$DATA_DIR/uploads" /etc/ztlab /var/backups/ztlab
# Бэкапы с паролями и хэшами не должны быть доступны всем подряд.
chmod 750 /var/backups/ztlab

# --- Код ---
log "Копирую код в $APP_DIR"
rsync -a --exclude 'node_modules' --exclude '.git' \
      --exclude 'database' --exclude 'uploads' --exclude '.env' \
      "$SRC_DIR"/ "$APP_DIR"/

chown -R ztlab:ztlab "$APP_DIR" "$DATA_DIR"

# --- Зависимости ---
# npm ci берёт точные версии из package-lock.json, поэтому результат
# одинаковый на любой машине.
log "Ставлю зависимости"
cd "$APP_DIR"
sudo -u ztlab npm ci --omit=dev

# --- Конфигурация ---
ENV_FILE=/etc/ztlab/ztlab.env
if [[ ! -f "$ENV_FILE" ]]; then
  log "Создаю $ENV_FILE"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -e "s/ЗАМЕНИТЬ_НА_СЛУЧАЙНУЮ_СТРОКУ/${SECRET}/" \
      "$SRC_DIR/deploy/ztlab.env.example" > "$ENV_FILE"
  log "Секрет сгенерирован и записан в $ENV_FILE"
else
  log "$ENV_FILE уже существует, не трогаю"
fi
chown root:ztlab "$ENV_FILE"
chmod 640 "$ENV_FILE"

# --- systemd ---
log "Включаю автозапуск"
install -m 644 "$SRC_DIR/deploy/ztlab.service" /etc/systemd/system/ztlab.service
systemctl daemon-reload
systemctl enable ztlab

log "Установлено. Сервис не запущен: сначала проверьте HOST."
echo
echo "Дальше:"
echo "  1. Убедитесь, что в $ENV_FILE стоит HOST=127.0.0.1."
echo "     Приложение слушает петлю: снаружи его видно только через nginx."
echo "  2. Запустите:  systemctl start ztlab"
echo "  3. Добавьте бэкапы в cron: см. deploy/README.md"
