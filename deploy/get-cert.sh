#!/usr/bin/env bash
# Выпуск сертификата ztbase.ru после прорастания делегации .ru.
#
# Важно: сначала проверяем публичный DNS и только потом идём в certbot.
# Let's Encrypt считает каждую неудачную проверку авторизации и
# допускает 5 на домен в час. Частые попытки вслепую выжигают этот
# лимит, и потом сертификат нельзя получить даже при живом DNS.
set -uo pipefail
LOG=/var/log/ztlab-getcert.log
exec >>"$LOG" 2>&1

VPS_IP="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null)"
echo "=== попытка $(date -u '+%F %T UTC') ==="

# Публичный DNS через DoH. Обычный getent не годится: в /etc/hosts
# VPS есть запись ztbase.ru, и локальный резолвер всегда ответит
# успехом независимо от того, дошло ли делегирование до реестра.
resolve_public() {
  curl -s --max-time 10 -H 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=$1&type=A" 2>/dev/null \
  | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("НЕТОПРОС"); raise SystemExit
ans = [a["data"] for a in d.get("Answer", []) if a.get("type") == 1]
print(",".join(ans) if ans else "ПУСТО")
'
}

APEX="$(resolve_public ztbase.ru)"
WWW="$(resolve_public www.ztbase.ru)"
echo "публичный DNS: ztbase.ru=${APEX:-?} www.ztbase.ru=${WWW:-?}"

if [ -z "$VPS_IP" ]; then
  echo "не удалось определить свой внешний адрес, пропускаю"
  exit 2
fi

# DNS ещё не пророс, либо смотрит не на нас: в certbot не идём.
for d in $APEX $WWW; do
  case ",$d," in
    *",$VPS_IP,"*) : ;;
    *) echo "DNS ещё не смотрит на $VPS_IP, certbot не трогаю"
       exit 2 ;;
  esac
done

echo "DNS на месте, пробую certbot"
if ! certbot certonly --nginx -d ztbase.ru -d www.ztbase.ru \
      --non-interactive --agree-tos --register-unsafely-without-email \
      --keep-until-expiring; then
  echo "не вышло с www, пробую только основной домен"
  if ! certbot certonly --nginx -d ztbase.ru \
        --non-interactive --agree-tos --register-unsafely-without-email \
        --keep-until-expiring; then
    echo "пока не удалось"
    exit 1
  fi
  # Сертификат только на основной домен: убираем www из nginx,
  # иначе все будущие попытки продления будут падать на нём.
  sed -i 's#\bwww\.ztbase\.ru\b##g' /etc/nginx/sites-available/ztlab
  echo "сертификат только на ztbase.ru, www убран из конфига"
fi

sed -i 's#/etc/ssl/ztbase-bootstrap/cert.pem#/etc/letsencrypt/live/ztbase.ru/fullchain.pem#; s#/etc/ssl/ztbase-bootstrap/key.pem#/etc/letsencrypt/live/ztbase.ru/privkey.pem#' \
  /etc/nginx/sites-available/ztlab

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "ГОТОВО: nginx переключён на настоящий сертификат"
  systemctl disable --now ztlab-getcert.timer >/dev/null 2>&1
  exit 0
else
  echo "ОШИБКА: nginx не проходит проверку, сертификат не подключён"
  exit 1
fi
