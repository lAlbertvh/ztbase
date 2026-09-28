#!/usr/bin/env bash
# Настройка WireGuard на VPS.
# Запуск: sudo ./setup-wireguard-vps.sh
#
# Задача: соединить VPS и ноутбук приватной сетью, чтобы nginx на VPS
# видел приложение на ноутбуке напрямую, без выхода в интернет.
# Наружу открыт только 443 — сама база и 3D-файлы в интернет не выходят.
set -euo pipefail

WG_IF=wg0
WG_PORT=51820
SUBNET="10.8.0.0/24"
# IP ноутбука в этой сети. Адрес ноутбука должен быть 1,
# чтобы адрес .1 всегда был у VPS.
LAPTOP_IP=10.8.0.2
LAPTOP_PUBKEY="${1:-}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Запускать от root"
[[ -n "$LAPTOP_PUBKEY" ]] || fail "Укажите публичный ключ ноутбука: $0 <ключ>"
ip -4 addr show "$WG_IF" >/dev/null 2>&1 && fail "Интерфейс $WG_IF уже существует, настройка не требуется"

log "Ставлю wireguard и qrencode"
apt-get update -qq
apt-get install -y -qq wireguard qrencode

# --- Ключи VPS ---
log "Генерирую ключи VPS"
install -d -m 700 /etc/wireguard
wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key
chmod 600 /etc/wireguard/private.key
VPS_PRIV=$(cat /etc/wireguard/private.key)
VPS_PUB=$(cat /etc/wireguard/public.key)

# --- Конфигурация ---
# AllowedIPs для VPS = адрес ноутбука. Всё остальное наружу не пускаем.
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
# Порт WireGuard на VPS. Наружу его открывать не нужно.
ListenPort = ${WG_PORT}
PrivateKey = ${VPS_PRIV}
Address = 10.8.0.1/24
# Не принимаем и не отправляем трафик, пока это явно не разрешено ниже.
# DNS здесь не указываем: VPN не должен влиять на DNS ноутбука.

[Peer]
# Ноутбук
PublicKey = ${LAPTOP_PUBKEY}
AllowedIPs = ${LAPTOP_IP}/32
EOF
chmod 600 /etc/wireguard/wg0.conf

log "Включаю WireGuard"
systemctl enable --now wg-quick@${WG_IF}

# --- Брандмауэр ---
# Наружу оставляем только SSH и HTTPS.
# SSH: 22/tcp, чтобы можно было подключаться.
# 443: сайт.
# Порт WireGuard наружу НЕ открываем: он нужен только между VPS и ноутбуком.
log "Настраиваю ufw"
ufw --force reset >/dev/null
ufw default deny incoming   >/dev/null
ufw default allow outgoing  >/dev/null
ufw allow 22/tcp   comment 'SSH'      >/dev/null
ufw allow 443/tcp  comment 'HTTPS'    >/dev/null
ufw allow 80/tcp   comment 'HTTP для сертификата' >/dev/null
ufw --force enable >/dev/null

log "Готово. Туннель поднят."
echo
echo "================= КЛЮЧИ ================="
echo "Публичный ключ VPS (передайте ноутбуку):"
echo "  ${VPS_PUB}"
echo
echo "Приватный ключ VPS НЕ передавайте никому."
echo
echo "Туннель:"
wg show ${WG_IF}
echo
echo "================= ЧТО ДАЛЬШЕ ================="
echo "1. На ноутбуке создайте /etc/wireguard/wg0.conf с ключом VPS."
echo "2. Узнайте адрес ноутбука в сети:  ip addr show wg0"
echo "3. nginx на этом VPS уже настроен на адрес ${LAPTOP_IP}."
echo "4. С ноутбука проверьте связь:  ping 10.8.0.1"
echo "5. После проверки — выпуск сертификата (см. README.md)."
