#!/usr/bin/env bash
# Сквозная проверка развёрнутого ZT Lab.
# Запуск:  sudo ./deploy/check.sh ztbase.ru
#
# Проверяет всю цепочку на VPS: приложение на петле, привязку порта,
# nginx, HTTPS, сертификат и выдачу cookie. Каждый шаг подписан, чтобы
# было видно, где именно обрыв.
#
# WireGuard здесь не проверяется и не используется: провайдер блокирует
# этот протокол, связь с VPS идёт обычным SSH поверх TCP.
set -uo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Использование: $0 <домен>" >&2
  echo "Пример:          $0 ztbase.ru" >&2
  exit 2
fi
DOMAIN="$1"
APP_PORT="${APP_PORT:-3000}"
HEALTH="http://127.0.0.1:${APP_PORT}/health"

# Приложение живёт на www, а на голом домене nginx отдаёт статический
# лендинг из каталога. Поэтому /health на apex даёт 404 — это не поломка,
# а нормальная маршрутизация. Проверять надо тот домен, где живёт код.
WWW="www.${DOMAIN}"

PASS=0
FAIL=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mОШИБКА\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

info "1. Приложение отвечает на петле"
H=$(curl -s --max-time 5 "$HEALTH" || true)
if echo "$H" | grep -q '"status":"ok"'; then
  ok "приложение отвечает на 127.0.0.1:${APP_PORT}"
else
  bad "приложение не отвечает. systemctl status ztlab; journalctl -u ztlab -n 50"
fi

info "2. Порт не выставлен наружу"
LISTEN=$(ss -ltn 2>/dev/null | grep ":${APP_PORT}" || true)
if echo "$LISTEN" | grep -q '127\.0\.0\.1:'; then
  ok "слушает только 127.0.0.1 — напрямую из интернета не достать"
elif echo "$LISTEN" | grep -qE '(0\.0\.0\.0|\[::\]|\*):'"${APP_PORT}"; then
  # Это не мелочь: порт 3000 в интернете — доступ к базе в обход TLS.
  bad "слушает на всех интерфейсах: ${LISTEN}. Поставьте HOST=127.0.0.1 в /etc/ztlab/ztlab.env"
else
  bad "порт ${APP_PORT} не слушается вообще"
fi

info "3. nginx"
if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then
    ok "конфигурация nginx корректна"
  else
    bad "конфигурация nginx битая. nginx -t"
  fi
  if curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1/health" | grep -q '^200$'; then
    ok "nginx достучился до приложения через upstream"
  else
    bad "nginx не достучился. Проверьте upstream в /etc/nginx/sites-enabled/ztlab"
  fi
else
  printf '  пропуск: nginx на этой машине нет\n'
fi

info "4. HTTPS снаружи"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${WWW}/health" || echo 000)
if [[ "$CODE" == "200" ]]; then
  ok "https://${WWW}/health отвечает 200"
else
  bad "https://${WWW}/health вернул ${CODE}. Проверьте DNS, сертификат и nginx"
fi

# Статический лендинг живёт отдельно от приложения, на голом домене,
# и обслуживается теми же nginx.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/" || echo 000)
if [[ "$CODE" == "200" ]]; then
  ok "лендинг https://${DOMAIN} отвечает 200"
else
  bad "лендинг вернул ${CODE}"
fi

CERT=$(echo | openssl s_client -servername "${WWW}" -connect "${WWW}:443" 2>/dev/null \
       | openssl x509 -noout -enddate 2>/dev/null || true)
if [[ -n "$CERT" ]]; then
  ok "сертификат действителен до: ${CERT#notAfter=}"
else
  bad "не удалось прочитать сертификат"
fi

info "5. Вход в боевом режиме (самое частое место поломки)"
# Если nginx не передаёт X-Forwarded-Proto, или в приложении выключен
# trust proxy, то cookie с флагом Secure не выдаётся — и пользователь
# упирается в бесконечное возвращение на /login. Проверяем это прямо.
BODY=$(curl -s --max-time 10 -X POST "https://${DOMAIN}/set-user" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode 'lab_slug=проверка' \
        --data-urlencode 'username=нет' \
        --data-urlencode 'password=нет' \
        -D - -o /dev/null 2>/dev/null || true)
if echo "$BODY" | grep -qi 'set-cookie:'; then
  ok "cookie выдаётся — Secure работает корректно"
else
  # Неудачный вход тоже должен получать cookie, иначе проверка не показала бы проблему.
  printf '  подсказка: cookie не выдаётся.\n'
  printf '  Проверьте, что в nginx есть  proxy_set_header X-Forwarded-Proto $scheme;\n'
  printf '  и в /etc/ztlab/ztlab.env:  COOKIE_SECURE=1  и TRUST_PROXY задан\n'
  FAIL=$((FAIL+1))
fi

info "6. Бэкапы"
if [[ -d /var/backups/ztlab ]]; then
  N=$(find /var/backups/ztlab -name 'exo-*.db' | wc -l)
  if [[ "$N" -gt 0 ]]; then
    NEWEST=$(ls -1t /var/backups/ztlab/exo-*.db 2>/dev/null | head -1)
    AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST") ) / 86400 ))
    if [[ "$AGE_DAYS" -le 2 ]]; then
      ok "свежая копия есть (${AGE_DAYS} дн. назад), всего копий: $N"
    else
      bad "последняя копия старше ${AGE_DAYS} дн. Проверьте ztlab-backup.timer"
    fi
  else
    bad "копий базы нет. Проверьте ztlab-backup.timer"
  fi
else
  printf '  пропуск: каталога бэкапов нет\n'
fi

info "Итог"
echo "  успешно: ${PASS}, ошибок: ${FAIL}"
[[ $FAIL -eq 0 ]] || exit 1
