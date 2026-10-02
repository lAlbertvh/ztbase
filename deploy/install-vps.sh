#!/usr/bin/env bash
# Первая установка ZT Lab на VPS.
#
#   sudo ./deploy/install-vps.sh
#
# Отличие от install-laptop.sh: приложение слушает только 127.0.0.1,
# наружу его не выставляет — перед приложением стоит nginx на этой же
# машине. Порт 3000 в интернет не открывается.
#
# Скрипт ставит софт и создаёт каталоги, но НЕ запускает приложение:
# сначала переносим данные и переключаем nginx, и только потом стартуем.
set -euo pipefail

APP_DIR=/opt/ztlab
DATA_DIR=/var/lib/ztlab
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"

# --- Node 22 ---
# better-sqlite3 — нативный модуль, готовой сборки под Node 26 нет:
# в Node 26 движок V8 убрал info.This(), из-за чего исходники не
# компилируются. Поэтому версия зафиксирована.
if ! command -v node >/dev/null; then
  log "Устанавливаю Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[[ "$NODE_MAJOR" == "22" ]] || fail "Нужен Node 22, а стоит $(node -v). Подробности в deploy/README.md"

# --- Инструменты сборки и утилиты ---
log "Ставлю инструменты сборки и утилиты"
apt-get update -qq
apt-get install -y -qq build-essential python3 sqlite3 rsync

# --- Пользователь ---
if ! id -u ztlab >/dev/null 2>&1; then
  log "Создаю пользователя ztlab"
  # Без системных прав: приложению не нужно ни root, ни sudo.
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin ztlab
fi

# --- Каталоги ---
log "Готовлю каталоги"
# tmp-uploads создаём заранее: при ProtectSystem=strict в systemd
# приложению нельзя создать папку самой (родительский каталог
# read-only), и mkdir на старте уронил бы сервис.
mkdir -p "$APP_DIR" "$DATA_DIR/database" "$DATA_DIR/uploads" \
         "$DATA_DIR/content" "$DATA_DIR/tmp-uploads" /etc/ztlab /var/backups/ztlab
# В бэкапах лежат хэши паролей и данные пациентов — закрываем каталог.
# Группу ОБЯЗАТЕЛЬНО ставим ztlab: иначе копии не прочитает даже
# владелец данных, и восстановление невозможно проверить.
chown root:ztlab /var/backups/ztlab
chmod 750 /var/backups/ztlab

# --- Код ---
log "Копирую код в $APP_DIR"
rsync -a --exclude 'node_modules' --exclude '.git' \
      --exclude 'database' --exclude 'uploads' --exclude 'content' --exclude '.env' \
      "$SRC_DIR"/ "$APP_DIR"/

chown -R ztlab:ztlab "$APP_DIR" "$DATA_DIR"

# --- Зависимости ---
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

# HOST обязан быть 127.0.0.1. Если приложение начнёт слушать 0.0.0.0,
# порт 3000 окажется в интернете мимо nginx: без TLS и с лимитами,
# которых ждёт только прокси.
if grep -qE '^HOST=0\.0\.0\.0' "$ENV_FILE"; then
  log "Исправляю HOST на 127.0.0.1"
  sed -i 's/^HOST=0\.0\.0\.0/HOST=127.0.0.1/' "$ENV_FILE"
fi

# Квота хранилища не может превышать размер диска: иначе приложение
# посчитает, что места хватает, и упрётся в заполненный корневой том.
# Источник именно size, а не source: в колонке source лежит только
# имя устройства, и в неё не помещался размер. И номер поля — $1, а не
# $2: df печатает значение одним полем, и $2 был пустым. Из-за этого
# квота выходила -5 и молча уезжала в запасные 100 ГБ.
DISK_GB=$(df -BG --output=size "$DATA_DIR" | awk 'NR==2{gsub(/G/,"",$1); print $1}')
if ! [[ "$DISK_GB" =~ ^[0-9]+$ ]] || [ "$DISK_GB" -le 5 ]; then
  fail "Не удалось определить размер диска в $DATA_DIR (получено: '$DISK_GB'). Квоту оставьте пустой и задайте вручную."
fi
CURRENT_QUOTA=$(sed -n 's/^STORAGE_QUOTA_GB=//p' "$ENV_FILE" | tail -1)
if [ -n "$CURRENT_QUOTA" ] && [ "$CURRENT_QUOTA" -gt "$((DISK_GB - 5))" ] 2>/dev/null; then
  NEW_QUOTA=$((DISK_GB - 5))
  log "Квота $CURRENT_QUOTA ГБ больше свободного места (диск $DISK_GB ГБ) — ставлю $NEW_QUOTA ГБ"
  sed -i "s/^STORAGE_QUOTA_GB=.*/STORAGE_QUOTA_GB=$NEW_QUOTA/" "$ENV_FILE"
fi

# --- systemd ---
log "Включаю автозапуск"
install -m 644 "$SRC_DIR/deploy/ztlab.service" /etc/systemd/system/ztlab.service
systemctl daemon-reload
systemctl enable ztlab >/dev/null

# --- Бэкапы по расписанию ---
# Отдельный systemd-таймер вместо cron: он видит результат и пишет
# в журнал, а не молча падает, как это делает запись в crontab.
if [ -f "$SRC_DIR/deploy/ztlab-backup.service" ]; then
  log "Включаю таймер бэкапов"
  install -m 644 "$SRC_DIR/deploy/ztlab-backup.service" /etc/systemd/system/ztlab-backup.service
  install -m 644 "$SRC_DIR/deploy/ztlab-backup.timer" /etc/systemd/system/ztlab-backup.timer
  systemctl daemon-reload
  systemctl enable --now ztlab-backup.timer
fi

# --- Проверка живости ---
# Без этого падение видно только по жалобам клиента. Таймер сам
# перезапустит приложение и напишет в Telegram.
if [ -f "$SRC_DIR/deploy/ztlab-health.timer" ]; then
  log "Включаю проверку живости"
  install -m 755 "$SRC_DIR/deploy/health-check.sh" /opt/ztlab/deploy/health-check.sh
  install -m 644 "$SRC_DIR/deploy/ztlab-health.service" /etc/systemd/system/ztlab-health.service
  install -m 644 "$SRC_DIR/deploy/ztlab-health.timer" /etc/systemd/system/ztlab-health.timer
  systemctl daemon-reload
  # Включаю, но не запускаю сейчас: приложение ещё не стартовало,
  # иначе первая же проверка посчитала бы нормой падение.
  systemctl enable ztlab-health.timer
fi

# --- Файрвол ---
# Приложение слушает только петлю, наружу открыты 80 и 443.
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  log "Проверяю правила файрвола"
  if ufw status | grep -qE "^3000/tcp"; then
    log "Закрываю 3000/tcp наружу — приложение должно быть только на 127.0.0.1"
    ufw delete allow 3000/tcp >/dev/null 2>&1 || true
  fi
fi

log "Установлено. Приложение НЕ запущено."
cat <<EOF

Дальше:
  1. Перенесите данные на $DATA_DIR (база, uploads, content).
  2. Впишите в $ENV_FILE CONTENT_ADMIN_USER и CONTENT_ADMIN_PASS.
  3. Переключите nginx на локальный прокси: deploy/nginx/ztlab-vps.conf
  4. Запустите:   systemctl start ztlab
  5. Проверьте:    curl -sf http://127.0.0.1:3000/health

Туннель ztlab-tunnel на VPS не нужен и не ставится.

EOF
