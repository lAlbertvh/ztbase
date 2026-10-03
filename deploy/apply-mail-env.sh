#!/usr/bin/env bash
# Вносит SMTP-настройки в боевой конфигурационный файл.
#
# Зачем так сложно: пароль от почтового ящика — секрет, и он не должен
# ни попадать в git, ни быть написан в командной строке, где его видно
# в истории оболочки. Поэтому секрет живёт в отдельном файле, доступном
# только root, а этот скрипт переносит его в /etc/ztlab/ztlab.env.
#
# Как применить:
#   sudo nano /root/ztlab-smtp.env      # заполнить пять строк
#   sudo bash deploy/apply-mail-env.sh
#
# Скрипт ничего не печатает из секретов: в выводе только имена ключей и
# «задано / не задано».

set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-/root/ztlab-smtp.env}"
ENV_FILE="${ENV_FILE:-/etc/ztlab/ztlab.env}"
SERVICE="${SERVICE:-ztlab}"

KEYS=(SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM)

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Нет файла $SECRETS_FILE" >&2
  echo "Создайте его, заполните SMTP_* и повторите." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Нет файла $ENV_FILE" >&2
  exit 1
fi

# Значение достаём без eval: содержимое файла — это данные, а не код,
# иначе строка вида `$(rm -rf ...)` выполнилась бы при разборе.
read_secret() {
  local key="$1" value
  value="$(grep -E "^${key}=" "$SECRETS_FILE" | tail -n 1 | cut -d= -f2- || true)"
  printf '%s' "$value"
}

missing=()
values=()
for key in "${KEYS[@]}"; do
  value="$(read_secret "$key")"
  if [[ -z "$value" ]]; then
    missing+=("$key")
    continue
  fi
  # Кавычки в значении systemd не любит, а в пароле ящика их не бывает.
  # Всё равно убираем: файл должен остаться разбираемым.
  values+=("${key}=${value//\"/}")
done

if (( ${#missing[@]} > 0 )); then
  echo "Не заполнены ключи: ${missing[*]}" >&2
  exit 1
fi

# Права выставляем до записи: после создания временного файла с
# секретами он не должен ни на секунду оказаться доступным группе.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

# Старые строки SMTP_* выбрасываем, чтобы смена пароля не оставила
# прежний в файле. Остальное содержимое сохраняем как есть.
grep -vE '^[[:space:]]*SMTP_[A-Z_]*=' "$ENV_FILE" > "$tmp" || true
{
  echo ""
  echo "# ------ Письма ----"
  echo "# Добавлено скриптом deploy/apply-mail-env.sh."
  printf '%s\n' "${values[@]}"
} >> "$tmp"

# Пишем в существующий файл, а не создаём новый: права и владелец у
# него уже правильные, и секрет ни на секунду не появляется в файле,
# доступном группе. Группу берём у самого файла, а не пишем её
# названием — скрипт не сломается, если группа называется иначе.
env_group="$(stat -c '%G' "$ENV_FILE")"
cat "$tmp" > "$ENV_FILE"
chown "root:$env_group" "$ENV_FILE"
chmod 640 "$ENV_FILE"
echo "Записано в $ENV_FILE: ${KEYS[*]}"

systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo "Сервис запущен."
else
  echo "Сервис не запустился:" >&2
  systemctl status "$SERVICE" --no-pager | tail -n 10 >&2
  exit 1
fi

# Файл с секретами удаляем: в боевом конфиге значения уже есть, а
# хранить их в двух местах — значит забыть обновить одно из них.
rm -f "$SECRETS_FILE"
echo "Файл с секретами $SECRETS_FILE удалён."
echo "При смене пароля ящика заполните $SECRETS_FILE заново и повторите скрипт."
echo "Проверить отправку без настоящего письма: MAIL_DRY_RUN=1 — см. deploy/README.md."
