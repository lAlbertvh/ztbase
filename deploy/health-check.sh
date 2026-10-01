#!/usr/bin/env bash
# Проверка живости приложения. Запускается по таймеру, раз в 2 минуты.
#
#   /opt/ztlab/deploy/health-check.sh
#
# Смысл: пока ноутбук был единственным сервером, о падении узнавали
# от клиентов. Здесь падение обнаруживается само и попытка исправления
# происходит без участия человека.
#
# Что делает при сбое:
#   1. повторяет попытку через паузу (кратковременный сбок бывает);
#   2. если не помогло — перезапускает сервис;
#   3. если и это не помогло — пишет в Telegram, но не чаще раза в
#      час, иначе одно и то же падение завалит сообщениями.
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:3000/health}"
SERVICE="${SERVICE:-ztlab}"
STATE_DIR="${STATE_DIR:-/var/lib/ztlab}"
MAX_FAILS="${MAX_FAILS:-2}"
ALERT_COOLDOWN="${ALERT_COOLDOWN:-3600}"
LOG="${LOG:-/var/log/ztlab-health.log}"

STATE="$STATE_DIR/health.state"
FAILED_FILE="$STATE_DIR/health.failing"
mkdir -p "$STATE_DIR"

note() { echo "$(date '+%F %T') $*" >> "$LOG"; }

curl_ok() {
    # -s без -S: своё сообщение пишем в журнал сами, штатный вывод curl
    # в stdout systemd-юнита только мешает.
    curl -fs --max-time 10 -o /dev/null "$APP_URL" 2>/dev/null
}

# --- Случай всё в порядке ---
if curl_ok; then
    if [ -f "$FAILED_FILE" ]; then
        note "состояние восстановилось после $(cat "$FAILED_FILE") неудачных проверок"
        rm -f "$FAILED_FILE"
    fi
    # Держим счётчик, но чистим, чтобы копия не росла вечно.
    echo 0 > "$STATE"
    exit 0
fi

# --- Сбой ---
FAILS=0
[ -f "$STATE" ] && FAILS="$(cat "$STATE" 2>/dev/null || echo 0)"
case "$FAILS" in (*[!0-9]*) FAILS=0 ;; esac
FAILS=$((FAILS + 1))
echo "$FAILS" > "$STATE"
note "проверка не прошла (попытка $FAILS): $APP_URL не отвечает"

if [ "$FAILS" -lt "$MAX_FAILS" ]; then
    # Первый провал: возможно, сбой кратковременный. Не дёргаем сервис.
    exit 0
fi

note "сбой повторился, неудачных проверок подряд: $FAILS. Перезапускаю $SERVICE"
if systemctl restart "$SERVICE" 2>>"$LOG"; then
    sleep 5
    if curl_ok; then
        note "перезапуск помог, приложение отвечает"
        rm -f "$FAILED_FILE"
        echo 0 > "$STATE"
        exit 0
    fi
    note "перезапуск не помог: /health не отвечает"
fi

echo "$FAILS" > "$FAILED_FILE"

# --- Уведомление, но не чаще раза в час ---
LAST="$(cat "$STATE_DIR/health.alerted" 2>/dev/null || echo 0)"
NOW="$(date +%s)"
if [ $((NOW - LAST)) -ge "$ALERT_COOLDOWN" ]; then
    echo "$NOW" > "$STATE_DIR/health.alerted"
    TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    CHAT="${TELEGRAM_CHAT_ID:-}"
    if [ -n "$TOKEN" ] && [ -n "$CHAT" ] && [ -f /etc/ztlab/ztlab.env ]; then
        # Токен читаем из файла конфигурации, а не из окружения таймера.
        set -a
        # shellcheck disable=SC1091
        . /etc/ztlab/ztlab.env
        set +a
        MSG="ZT Lab не отвечает: /health не проходит, перезапуск не помог. Проверьте: journalctl -u ztlab -n 50"
        curl -fsS --max-time 15 -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$TELEGRAM_CHAT_ID" \
            -d text="$MSG" >>"$LOG" 2>&1 || note "не смог отправить уведомление в Telegram"
    else
        note "Telegram не настроен, уведомление пропущено"
    fi
fi

exit 0
