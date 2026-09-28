#!/usr/bin/env bash
# Настройка WireGuard на НОУТБУКЕ.
#
# Запуск (нужен sudo):
#   sudo ./setup-wireguard-laptop.sh <публичный_ключ_VPS>
#
# Ключ VPS напечатает setup-wireguard-vps.sh на стороне сервера,
# либо его можно посмотреть так:
#   ssh root@<ip-сервера> cat /etc/wireguard/public.key
set -euo pipefail

WG_IF=wg0
LAPTOP_IP="${LAPTOP_IP:-10.8.0.2}"
LAPTOP_PORT="${LAPTOP_PORT:-51821}"
VPS_PUBKEY="${1:-}"
VPS_IP="${VPS_IP:-157.22.175.141}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root: sudo $0"
[[ -n "$VPS_PUBKEY" ]] || fail "Не указан публичный ключ VPS.
Запуск: sudo $0 <публичный_ключ_VPS>"

# Свои ключи создаются один раз и сохраняются: при повторном запуске
# генерировать их заново нельзя, иначе туннель перестанет совпадать
# с записью на сервере.
install -d -m 700 /etc/wireguard
if [[ ! -f /etc/wireguard/laptop.key ]]; then
  log "Создаю ключи ноутбука"
  umask 077
  wg genkey > /etc/wireguard/laptop.key
  wg pubkey < /etc/wireguard/laptop.key > /etc/wireguard/laptop.pub
else
  log "Ключи ноутбука уже есть, использую их"
fi
chmod 600 /etc/wireguard/laptop.key
chmod 644 /etc/wireguard/laptop.pub

LAPTOP_PRIV=$(cat /etc/wireguard/laptop.key)
LAPTOP_PUB=$(cat /etc/wireguard/laptop.pub)

log "Пишу конфигурацию $WG_IF"
cat > "/etc/wireguard/${WG_IF}.conf" <<EOF
[Interface]
PrivateKey = ${LAPTOP_PRIV}
Address = ${LAPTOP_IP}/32
ListenPort = ${LAPTOP_PORT}

[Peer]
# VPS
PublicKey = ${VPS_PUBKEY}
Endpoint = ${VPS_IP}:51820
# Трафик только между ноутбуком и VPS. Обычный интернет идёт напрямую.
AllowedIPs = 10.8.0.0/24
# Ноутбук засыпает: без keepalive туннель не поднимется сразу
# при обращении к сайту, придётся ждать.
PersistentKeepalive = 25
EOF
chmod 600 "/etc/wireguard/${WG_IF}.conf"

# DNS через VPN не настраиваем намеренно: иначе VPN начнёт влиять
# на разрешение имён в обычном интернете.

log "Запускаю туннель"
systemctl enable --now "wg-quick@${WG_IF}"
sleep 3

log "Проверяю связь с VPS"
if ping -c 2 -W 3 10.8.0.1 >/dev/null 2>&1; then
  log "VPS 10.8.0.1 отвечает — туннель работает"
else
  log "ВНИМАНИЕ: VPS не отвечает. Проверьте ключи и правила на сервере:"
  log "  на сервере: wg show"
  log "  здесь:      systemctl status wg-quick@${WG_IF}"
fi

echo
echo "================= КЛЮЧ НОУТБУКА ================="
echo "Отправьте эту строку на сервер — без неё туннель не поднимется:"
echo
echo "${LAPTOP_PUB}"
echo
echo "================= ЧТО ДАЛЬШЕ ================="
echo "1. Скопируйте ключ выше и дайте его мне, я добавлю пира на VPS."
echo "2. В /etc/ztlab/ztlab.env впишите:"
echo "     HOST=${LAPTOP_IP}"
echo "3. Запустите приложение:  systemctl start ztlab"
echo "4. Проверка:  curl http://${LAPTOP_IP}:3000/health"
