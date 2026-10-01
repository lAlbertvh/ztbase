#!/usr/bin/env bash
# Наполнение лаборатории демонстрационными данными.
#
#   sudo ./deploy/seed-demo-lab.sh              # посмотреть, что будет
#   sudo ./deploy/seed-demo-lab.sh --apply      # выполнить
#   sudo ./deploy/seed-demo-lab.sh --lab-id 2 --apply
#
# Скрипт НИКОГДА не трогает существующие наряды. Если в целевой
# лаборатории уже есть заказы, он останавливается и ничего не меняет.
# Перед записью делается резервная копия базы.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ztlab}"
LAB_ID=1
APPLY=0
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --lab-id) LAB_ID="$2"; shift 2 ;;
        --apply) APPLY=1; shift ;;
        --force) FORCE=1; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
    esac
done

if [ ! -d "$APP_DIR" ]; then
    echo "Каталог приложения не найден: $APP_DIR" >&2
    echo "Задайте путь: APP_DIR=/путь/к/коду ./deploy/seed-demo-lab.sh" >&2
    exit 1
fi

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "Не найден node. better-sqlite3 требует Node 22." >&2
    exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "22" ]; then
    echo "Нужен Node 22, а найден $("$NODE_BIN" -v)" >&2
    exit 1
fi

# Каталог с данными берём из .env приложения, иначе из стандартного места.
if [ -n "${DB_PATH:-}" ]; then
    :  # путь задан явно, берём его
elif [ -f "$APP_DIR/.env" ]; then
    DB_DIR="$(sed -n 's/^DB_DIR=//p' "$APP_DIR/.env" | tail -1 | tr -d '"'"'"'')"
    [ -n "$DB_DIR" ] || DB_DIR="unknown"
    DB_PATH="$DB_DIR/exo.db"
else
    DB_PATH="/var/lib/ztlab/database/exo.db"
fi

if [ ! -f "$DB_PATH" ]; then
    echo "База не найдена: $DB_PATH" >&2
    exit 1
fi

echo "==> Приложение: $APP_DIR"
echo "==> База:       $DB_PATH"
echo "==> Лаборатория: $LAB_ID"
echo "==> Режим:      $([ "$APPLY" -eq 1 ] && echo 'ЗАПИСЬ' || echo 'только просмотр')"

if [ "$APPLY" -eq 1 ]; then
    BACKUP_DIR="${BACKUP_DIR:-/var/backups/ztlab}"
    mkdir -p "$BACKUP_DIR"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    BACKUP="$BACKUP_DIR/exo-before-demo-$STAMP.db"
    cp -a "$DB_PATH" "$BACKUP"
    # WAL и SHM копируем рядом, иначе бэкап может оказаться неполным.
    [ -f "$DB_PATH-wal" ] && cp -a "$DB_PATH-wal" "$BACKUP-wal" || true
    [ -f "$DB_PATH-shm" ] && cp -a "$DB_PATH-shm" "$BACKUP-shm" || true
    echo "==> Резервная копия: $BACKUP"
fi

cd "$APP_DIR"

APP_DIR="$APP_DIR" DB_PATH="$DB_PATH" LAB_ID="$LAB_ID" \
APPLY="$APPLY" FORCE="$FORCE" NODE_BIN="$NODE_BIN" \
"$NODE_BIN" - <<'NODE'
const path = require('path');
const Database = require(path.join(process.env.APP_DIR, 'node_modules', 'better-sqlite3'));

const db = new Database(process.env.DB_PATH, { readonly: process.env.APPLY !== '1' });
const labId = Number(process.env.LAB_ID);
const apply = process.env.APPLY === '1';
const force = process.env.FORCE === '1';

const lab = db.prepare('SELECT id, name, slug FROM labs WHERE id = ?').get(labId);
if (!lab) {
    console.error(`Лаборатория ${labId} не найдена.`);
    console.error('Доступные:');
    for (const l of db.prepare('SELECT id, name FROM labs ORDER BY id').all()) {
        console.error(`  ${l.id}  ${l.name}`);
    }
    process.exit(1);
}
console.log(`\n==> Лаборатория: «${lab.name}» (${lab.slug})`);

const existing = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE lab_id = ?').get(labId).n;
if (existing > 0 && !force) {
    console.error(`\nОСТАНОВ: в лаборатории уже ${existing} нарядов.`);
    console.error('Скрипт не трогает существующие данные. Сначала посмотрите базу,');
    console.error('либо запустите с --force, если понимаете, что делаете.');
    process.exit(1);
}

const catalog = db.prepare(
    'SELECT id, code, name, price FROM manipulations WHERE lab_id = ? AND active = 1 ORDER BY sort, id'
).all(labId);

if (catalog.length === 0) {
    console.error(`\nВ лаборатории ${labId} пустой справочник манипуляций.`);
    console.error('Сначала заполните справочник, иначе наряды будут без чек-листов.');
    process.exit(1);
}
console.log(`==> Справочник манипуляций: ${catalog.length} позиций`);

// Демо-персонал. Имена подставляются в общий справочник пользователей,
// поэтому проверяем, чтобы не задеть чужую лабораторию.
const TEAM = [
    { name: 'Мария Соколова', role: 'tech' },
    { name: 'Дмитрий Орлов', role: 'tech' },
    { name: 'Анна Ветрова', role: 'admin' },
];

const inThisLab = new Set(
    db.prepare('SELECT name FROM users WHERE lab_id = ?').all(labId).map(r => r.name)
);
const inOtherLabs = new Set(
    db.prepare('SELECT name FROM users WHERE lab_id <> ?').all(labId).map(r => r.name)
);

for (const member of TEAM) {
    if (inOtherLabs.has(member.name)) {
        console.error(`\nОСТАНОВ: имя «${member.name}» уже занято в другой лаборатории.`);
        console.error('Переименуйте демо-персонал в этом скрипте.');
        process.exit(1);
    }
    if (inThisLab.has(member.name)) {
        console.log(`  · ${member.name} уже есть, пропускаю`);
    }
}

const ORDERS = [
    {
        number: 'Д-24-0114', customer: 'Клиника «Дентал плюс»', patient: 'Ковалёв А.П.',
        stage: 'work', kind: 'zirconia_crown',
        taken: '2026-09-14', promised: '2026-09-19',
        teeth: [{ tooth: 16, kind: 'zirconia_crown', material: 'Диоксид циркония', color: 'A2' },
                { tooth: 15, kind: 'zirconia_crown', material: 'Диоксид циркония', color: 'A2' }],
        doneRatio: 0.7, tech: 'Мария Соколова',
    },
    {
        number: 'Д-24-0115', customer: 'Стоматология «Белая линия»', patient: 'Степанова Н.В.',
        stage: 'ready', kind: 'implant_bridge',
        taken: '2026-09-10', promised: '2026-09-17',
        teeth: [{ tooth: 36, kind: 'implant_bridge', material: 'Циркониевый каркас', color: 'A3' },
                { tooth: 37, kind: 'implant_bridge', material: 'Циркониевый каркас', color: 'A3' },
                { tooth: 38, kind: 'implant_bridge', material: 'Циркониевый каркас', color: 'A3' }],
        doneRatio: 1.0, tech: 'Дмитрий Орлов',
    },
    {
        number: 'Д-24-0116', customer: 'Клиника «Астра»', patient: 'Игнатьев П.С.',
        stage: 'new', kind: 'veneer',
        taken: '2026-09-18', promised: '2026-09-24',
        teeth: [{ tooth: 11, kind: 'veneer', material: 'E.max', color: 'A1' },
                { tooth: 12, kind: 'veneer', material: 'E.max', color: 'A1' }],
        doneRatio: 0.15, tech: 'Мария Соколова',
    },
];

const STAGES = ['new', 'scan', 'frame', 'work', 'ready', 'issued'];
const MANIP_ACTIONS = ['done'];

function pickCatalog(seed) {
    // Берём разные позиции справочника, чтобы чек-листы не были
    // одинаковыми у всех нарядов.
    const out = [];
    for (let i = 0; i < 5; i++) {
        out.push(catalog[(seed * 3 + i) % catalog.length]);
    }
    return out;
}

if (apply) {
    db.exec('BEGIN');
}

try {
    // Пользователи
    for (const member of TEAM) {
        if (!apply) continue;
        if (inThisLab.has(member.name)) continue;
        db.prepare(
            'INSERT INTO users (name, lab_id, role, active) VALUES (?, ?, ?, 1)'
        ).run(member.name, labId, member.role);
        console.log(`  + сотрудник: ${member.name} (${member.role})`);
    }

    let totalDone = 0;
    let totalEarned = 0;

    for (const [index, spec] of ORDERS.entries()) {
        if (apply) {
            const info = db.prepare(`
                INSERT INTO orders (lab_id, order_number, customer, patient, stage, priority,
                                    taken_at, promised_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(labId, spec.number, spec.customer, spec.patient, spec.stage,
                   spec.stage === 'new' ? 1 : 0, spec.taken, spec.promised,
                   'Анна Ветрова');
            const orderId = info.lastInsertRowid;

            for (const t of spec.teeth) {
                db.prepare(`
                    INSERT INTO order_teeth (order_id, lab_id, tooth, kind, material, color)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(orderId, labId, t.tooth, t.kind, t.material, t.color);
            }

            // История этапов до текущего.
            const upto = STAGES.indexOf(spec.stage);
            for (let s = 0; s <= upto; s++) {
                db.prepare(
                    'INSERT INTO order_stages (order_id, lab_id, stage, user) VALUES (?, ?, ?, ?)'
                ).run(orderId, labId, STAGES[s], s === 0 ? 'Анна Ветрова' : spec.tech);
            }

            // Чек-лист манипуляций: часть выполнена, часть ждёт.
            const items = pickCatalog(index);
            const doneCount = Math.max(1, Math.round(items.length * spec.doneRatio));
            items.forEach((m, i) => {
                const done = i < doneCount ? 1 : 0;
                db.prepare(`
                    INSERT INTO order_manipulations
                        (order_id, lab_id, manipulation_id, code, name, price, done, done_at, done_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(orderId, labId, m.id, m.code, m.name, m.price, done,
                        done ? `${spec.taken} 12:00:00` : null,
                        done ? spec.tech : null);

                // Журнал нужен для расчёта зарплаты: из него берётся
                // история «отметил / снял отметку», а не текущее состояние.
                if (done) {
                    db.prepare(`
                        INSERT INTO manipulation_log
                            (order_id, lab_id, order_number, work_kind, code, name, price, user, action, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)
                    `).run(orderId, labId, spec.number, spec.kind, m.code, m.name,
                            m.price, spec.tech, `${spec.taken} 12:00:00`);
                    totalDone++;
                    totalEarned += m.price;
                }
            });
            console.log(`  + наряд ${spec.number} · ${spec.customer} · этап «${spec.stage}»`);
        } else {
            const items = pickCatalog(index);
            const doneCount = Math.max(1, Math.round(items.length * spec.doneRatio));
            let sum = 0;
            items.slice(0, doneCount).forEach(m => { sum += m.price; });
            totalDone += doneCount;
            totalEarned += sum;
            console.log(`  · наряд ${spec.number} · этап «${spec.stage}» · выполнено ${doneCount} из ${items.length} · ${sum} ₽`);
        }
    }

    if (apply) {
        db.exec('COMMIT');
        console.log(`\n==> Записано. Нарядов: ${ORDERS.length}, отметок: ${totalDone}`);
    } else {
        console.log(`\n==> Прогон. Нарядов: ${ORDERS.length}, отметок: ${totalDone}`);
        console.log(`==> К расчёту зарплаты: ${totalEarned.toFixed(0)} ₽`);
        console.log('\nЭто был пробный прогон, база не изменялась.');
        console.log('Для записи запустите с --apply.');
    }
} catch (err) {
    if (apply) {
        try { db.exec('ROLLBACK'); } catch (_) { /* транзакция уже свёрнута */ }
        console.error('\nОШИБКА, изменения отменены:', err.message);
    } else {
        console.error('\nОШИБКА на пробном прогоне:', err.message);
    }
    process.exit(1);
}
NODE

echo
echo "==> Готово."
