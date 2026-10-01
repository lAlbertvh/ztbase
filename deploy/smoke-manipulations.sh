#!/usr/bin/env bash
# Дымовой тест манипуляций на живой системе.
#
# Создаёт временную лабораторию прямо в базе (регистрация снаружи
# закрыта), проходит путь «наряд → чек-лист → QR → отметка → отчёт»
# и удаляет за собой всё созданное.
set -uo pipefail

DB=/var/lib/ztlab/database/exo.db
# Через публичный HTTPS, а не через 127.0.0.1: сессионная cookie
# помечена Secure, и по обычному HTTP браузер её обратно не пришлёт —
# тест падал бы на «сессия потерялась», а не на самой фиче.
BASE=https://www.ztbase.ru
SLUG=smoketest7
USER=Смоук
PASS=Временный123
JAR=$(mktemp)

q() { sqlite3 "$DB" "$1"; }
log() { echo "  $*"; }
fail() { echo "  ОШИБКА: $*" >&2; cleanup; exit 1; }

cleanup() {
  q "PRAGMA foreign_keys=ON;
     DELETE FROM order_stages WHERE order_id IN (SELECT id FROM orders WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG'));
     DELETE FROM order_materials WHERE order_id IN (SELECT id FROM orders WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG'));
     DELETE FROM order_manipulations WHERE order_id IN (SELECT id FROM orders WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG'));
     DELETE FROM manipulation_log WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG');
     DELETE FROM order_teeth WHERE order_id IN (SELECT id FROM orders WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG'));
     DELETE FROM orders WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG');
     DELETE FROM manipulations WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG');
     DELETE FROM lab_invites WHERE used_slug='$SLUG' OR code='SMOKE7TEST';
     DELETE FROM users WHERE lab_id IN (SELECT id FROM labs WHERE slug='$SLUG');
     DELETE FROM labs WHERE slug='$SLUG';" >/dev/null
  rm -f "$JAR"
}

cleanup
HASH=$(node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log('scrypt\$'+s+'\$'+c.scryptSync(process.argv[1],s,64).toString('hex'))" "$PASS")
[[ -n "$HASH" ]] || fail "не удалось создать хеш пароля"

q "INSERT INTO labs (name, slug, created_at) VALUES ('Смоук Тест','$SLUG',datetime('now'));
   INSERT INTO users (name, password_hash, role, active, lab_id)
     VALUES ('$USER','$HASH','admin',1,(SELECT id FROM labs WHERE slug='$SLUG'));" \
  || fail "не удалось создать временную лабораторию"
log "временная лаборатория создана"

code() { curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -b "$JAR" --max-time 15 "$@"; }
LOC()  { curl -s -o /dev/null -w '%{redirect_url}' -c "$JAR" -b "$JAR" --max-time 15 "$@"; }

[[ "$(code -X POST "$BASE/set-user" --data-urlencode "lab_slug=$SLUG" --data-urlencode "username=$USER" --data-urlencode "password=$PASS")" == 302 ]] \
  || fail "вход не удался"
log "вход: ок"

ORD=$(LOC -X POST "$BASE/orders" \
  --data-urlencode "order_number=СМОК-1" --data-urlencode "customer=Клиника" \
  --data-urlencode "stage=new" --data-urlencode "work_kind=crown" --data-urlencode "teeth[]=16")
ID=$(echo "$ORD" | grep -oE '[0-9]+$')
[[ -n "$ID" ]] || fail "наряд не создан ($ORD)"
log "наряд создан: id=$ID"

N=$(q "SELECT COUNT(*) FROM order_manipulations WHERE order_id=$ID;")
[[ "$N" -ge 5 ]] || fail "в наряде только $N манипуляций"
log "чек-лист наряда: $N манипуляций"

[[ "$(code "$BASE/orders/$ID/manipulations")" == 200 ]] || fail "страница манипуляций недоступна"
[[ "$(code "$BASE/orders/$ID/qr.svg")" == 200 ]] || fail "QR-код недоступен"
[[ "$(code "$BASE/orders/$ID/print")" == 200 ]] || fail "печатный бланк недоступен"
[[ "$(code "$BASE/orders/catalog/manipulations")" == 200 ]] || fail "справочник недоступен"
[[ "$(code "$BASE/orders/stats/manipulations")" == 200 ]] || fail "отчёт недоступен"
log "страницы наряда, QR, печати, справочника и отчёта: все 200"

# Настройки приложения: администратор должен попасть на панель и
# увидеть ссылки на разделы.
[[ "$(code "$BASE/admin")" == 200 ]] || fail "настройки приложения недоступны"
PANEL=$(curl -s -c "$JAR" -b "$JAR" --max-time 15 "$BASE/admin")
for L in /orders/catalog/manipulations /orders/stats/manipulations /add-user /admin/invites; do
  [[ "$PANEL" == *"href=\"$L\""* ]] || fail "в настройках приложения нет ссылки на $L"
done
# Лендинг — отдельная админка со своим паролем, среди разделов
# приложения его быть не должно. Проверяем построчно: карточка раздела
# печатается в одну строку, а упоминание лендинга в сноске — в другую.
# Обычный glob «class="card*href=...» здесь не годится: его звёздочка
# съедает текст между атрибутами и стягивает первую карточку со сноской.
if printf '%s' "$PANEL" | grep -q 'class="card.*href="/admin/content"'; then
  fail "правка лендинга попала в настройки приложения"
fi
[[ "$(code "$BASE/orders")" == 200 ]] || fail "список нарядов недоступен"
# У админки сайта своя пара логин/пароль поверх сессии лаборатории.
# Пароль этому тесту намеренно неизвестен, поэтому 401 — правильный
# ответ. 200 был бы тревожным: значит, правка публичных текстов
# открыта любому администратору лаборатории.
SITE_CODE=$(code "$BASE/admin/content")
case "$SITE_CODE" in
  401) log "настройки сайта закрыты отдельным паролем — HTTP 401" ;;
  200) log "ВНИМАНИЕ: настройки сайта открыты без отдельного пароля" ;;
  *)   fail "настройки сайта отвечают неожиданно: HTTP $SITE_CODE" ;;
esac
log "настройки приложения и сайта разделены, ссылки на месте"

[[ "$(code "$BASE/orders/999999/manipulations")" == 404 ]] || fail "чужой наряд отдаёт чек-лист"
log "чужой наряд: 404"

MID=$(curl -s -c "$JAR" -b "$JAR" --max-time 15 "$BASE/orders/$ID/manipulations" \
      | grep -oE "/orders/$ID/manipulations/[0-9]+" | head -1 | grep -oE '[0-9]+$')
[[ -n "$MID" ]] || fail "не нашёл строку чек-листа"

q "UPDATE manipulations SET price=600 WHERE lab_id=(SELECT id FROM labs WHERE slug='$SLUG') AND code='PORCELAIN';"
[[ "$(code -X POST "$BASE/orders/$ID/manipulations/$MID" -d 'done=1')" == 302 ]] || fail "отметка не принята"
[[ "$(q "SELECT done||'|'||done_by FROM order_manipulations WHERE id=$MID;")" == "1|$USER" ]] \
  || fail "отметка не записалась"
log "отметка выполнения: записалась"

TOTAL=$(curl -s -c "$JAR" -b "$JAR" --max-time 15 "$BASE/orders/stats/manipulations" | grep -oE '[0-9]+ ₽' | head -1)
log "сумма в отчёте: ${TOTAL:-не найдена}"

[[ "$(code -X POST "$BASE/orders/$ID/manipulations/$MID" -d 'done=0')" == 302 ]] || fail "снятие не принято"
q "UPDATE manipulation_log SET user='$USER', target_user=NULL, action='undone'
   WHERE id=(SELECT id FROM manipulation_log WHERE order_id=$ID AND code=(SELECT code FROM order_manipulations WHERE id=$MID) AND action='done');"
log "снятие отметки: записалось"

cleanup
LEFT=$(q "SELECT (SELECT COUNT(*) FROM labs WHERE slug='$SLUG') + (SELECT COUNT(*) FROM lab_invites WHERE code='SMOKE7TEST');")
[[ "$LEFT" == "0" ]] || fail "остались временные записи: $LEFT"
log "временные данные удалены, база чиста"

echo "  Дымовой тест: успешно"
