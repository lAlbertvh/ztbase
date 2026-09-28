#!/usr/bin/env bash
# Сквозная проверка развёрнутого ZT Lab.
# Запуск:  sudo ./deploy/check.sh
#
# Проверяет всю цепочку: приложение на ноутбуке, туннель WireGuard,
# nginx на VPS, HTTPS и сертификат. Каждый шаг подписан, чтобы было
# видно, где именно обрыв.
set -uo pipefail

# Домен обязателен: без него проверка HTTPS не имеет смысла.
if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Использование: $0 <домен> [ip-ноутбука] [порт]" >&2
  echo "Пример:          $0 ztbase.ru 10.8.0.2 3000" >&2
  exit 2
fi
DOMAIN="$1"
# Адрес ноутбука в сети WireGuard
LAPTOP_IP="${2:-10.8.0.2}"
APP_PORT="${3:-3000}"

PASS=0
FAIL=0
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mОШИБКА\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

info "1. Приложение на ноутбуке (локально)"
H=$(curl -s --max-time 5 "http://127.0.0.1:${APP_PORT}/health" || true)
if echo "$H" | grep -q '"status":"ok"'; then
  ok "приложение отвечает на порту ${APP_PORT}"
else
  bad "приложение не отвечает. sudo systemctl status ztlab; sudo journalctl -u ztlab -n 50"
fi

info "2. Слушает только адрес туннеля (не всю сеть)"
LISTEN=$(ss -ltnp 2>/dev/null | grep ":${APP_PORT}" || true)
if echo "$LISTEN" | grep -q "${LAPTOP_IP}\|127.0.0.1"; then
  ok "слушает ${LAPTOP_IP} или 127.0.0.1 — в обход nginx не выйти"
else
  bad "слушает не там: ${LISTEN:-не найдено}. Проверьте HOST в /etc/ztlab/ztlab.env"
fi

info "3. Туннель WireGuard"
if ping -c 2 -W 3 10.8.0.1 >/dev/null 2>&1; then
  ok "VPS 10.8.0.1 отвечает"
else
  bad "VPS недоступен. На ноутбуке: systemctl status wg-quick@wg0; на VPS: wg show"
fi
if ping -c 2 -W 3 "${LAPTOP_IP}" >/dev/null 2>&1; then
  ok "ноутбук ${LAPTOP_IP} отвечает"
else
  bad "ноутбук ${LAPTOP_IP} недоступен. Проверьте AllowedIPs на обеих сторонах"
fi

info "4. nginx на VPS (если скрипт запущен на VPS)"
if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then
    ok "конфигурация nginx корректна"
  else
    bad "конфигурация nginx битая. nginx -t"
  fi
  H=$(curl -s --max-time 5 "http://${LAPTOP_IP}:${APP_PORT}/health" || true)
  if echo "$H" | grep -q '"status":"ok"'; then
    ok "nginx достучился до приложения через туннель"
  else
    bad "nginx не достучался. Проверьте upstream в /etc/nginx/sites-enabled/ztlab"
  fi
else
  printf '  пропуск: nginx на этой машине нет\n'
fi

info "5. HTTPS снаружи"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/health" || echo 000)
if [[ "$CODE" == "200" ]]; then
  ok "https://${DOMAIN}/health отвечает 200"
else
  bad "https://${DOMAIN}/health вернул ${CODE}. Проверьте DNS, сертификат и nginx"
fi

CERT=$(echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null \
       | openssl x509 -noout -enddate 2>/dev/null || true)
if [[ -n "$CERT" ]]; then
  ok "сертификат действителен до: ${CERT#notAfter=}"
else
  bad "не удалось прочитать сертификат"
fi

info "6. Вход в боевом режиме (самое частое место поломки)"
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

info "Итог"
echo "  успешно: ${PASS}, ошибок: ${FAIL}"
[[ $FAIL -eq 0 ]] || exit 1
