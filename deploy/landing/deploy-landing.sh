#!/usr/bin/env bash
# Загрузка статического лендинга на VPS и переключение nginx.
#
#   bash deploy/landing/deploy-landing.sh
#
# Скрипт кладёт файлы в /var/www/ztbase.ru на VPS, проверяет конфиг
# nginx и перезагружает его. Применять можно повторно: он ничего
# не удаляет, а только обновляет файлы лендинга.

set -euo pipefail

VPS_IP="${VPS_IP:-157.22.175.141}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR=/var/www/ztbase.ru
# Каталог данных приложения: там лежит site.json, который правится
# через /admin/content. Значение — то же, что CONTENT_DIR в ztlab.env.
CONTENT_DIR="${CONTENT_DIR:-/var/lib/ztlab/content}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
# Промежуточные файлы с уже подставленными контактами. Готовые
# страницы не кладутся в репозиторий: иначе телефон вернётся в историю
# и перестанет обновляться из админки.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Проверяю наличие файлов лендинга"
for f in index.html robots.txt sitemap.xml; do
    if [ ! -f "$LOCAL_DIR/$f" ]; then
        echo "  НЕТ ФАЙЛА: $f — остановился" >&2
        exit 1
    fi
done
echo "  файлы на месте"

echo "==> Создаю каталог на VPS"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$VPS_IP" \
    "mkdir -p '$REMOTE_DIR' && echo '  каталог $REMOTE_DIR готов'"

# Контакты для лендинга берём с VPS, а не из репозитория: site.json в
# каталоге данных — это тот файл, который правится через /admin/content.
# Если взять репозиторную копию, правка телефона в админке снова не
# влияла бы на сайт.
echo "==> Забираю site.json с VPS"
SITE_JSON="$WORK/site.json"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$VPS_IP" \
    "cat '$CONTENT_DIR/site.json'" > "$SITE_JSON"
if ! grep -q '"contacts"' "$SITE_JSON"; then
    echo "  ОШИБКА: на VPS нет раздела contacts в $CONTENT_DIR/site.json" >&2
    echo "  Откройте /admin/content, заполните контакты и сохраните." >&2
    exit 1
fi
echo "  contacts получены"

echo "==> Подставляю контакты"
rendered=()
for f in index.html; do
    node "$LOCAL_DIR/render.js" "$SITE_JSON" "$LOCAL_DIR/$f" "$WORK/$f"
    rendered+=("$f")
done
if [ -d "$LOCAL_DIR/legal" ]; then
    for f in "$LOCAL_DIR"/legal/*.html; do
        [ -e "$f" ] || continue
        node "$LOCAL_DIR/render.js" "$SITE_JSON" "$f" "$WORK/legal/$(basename "$f")"
        rendered+=("legal/$(basename "$f")")
    done
fi

echo "==> Копирую файлы"
for f in index.html robots.txt sitemap.xml; do
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -q \
        "$WORK/$f" "$SSH_USER@$VPS_IP:$REMOTE_DIR/$f"
    echo "  $f"
done
if [ -d "$LOCAL_DIR/legal" ]; then
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -q -r \
        "$WORK/legal/." "$SSH_USER@$VPS_IP:$REMOTE_DIR/"
    echo "  legal/ (${rendered[@]#legal/})"
fi

echo "==> Копирую иконки"
if [ -d "$LOCAL_DIR/../../public/icons" ]; then
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$VPS_IP" \
        "mkdir -p '$REMOTE_DIR/icons'"
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -q -r \
        "$LOCAL_DIR/../../public/icons/." "$SSH_USER@$VPS_IP:$REMOTE_DIR/icons/"
    echo "  icons/"
else
    echo "  каталог public/icons не найден — пропускаю"
fi

echo "==> Права и проверка"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$VPS_IP" \
    "chown -R www-data:www-data '$REMOTE_DIR' && \
     find '$REMOTE_DIR' -type d -exec chmod 755 {} + && \
     find '$REMOTE_DIR' -type f -exec chmod 644 {} + && \
     nginx -t && systemctl reload nginx && echo '  nginx перезагружен'"

echo "==> Готово. Проверка:"
echo "    ssh -i $SSH_KEY $SSH_USER@$VPS_IP 'curl -s -o /dev/null -w \"%{http_code}\" https://ztbase.ru/'"
