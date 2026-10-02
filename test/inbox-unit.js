// Переписка: видимость нарядов и подсчёт непрочитанных.
//
// Проверка ходит прямо в сервис на настоящей схеме заказ-нарядов,
// потому что ошибка в порядке параметров SQL здесь неверно: запрос
// выполняется успешно и молча считает чужое. Именно это и ловит тест —
// не 500, а неверную выдачу.
//
// Запуск:  node test/inbox-unit.js

const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const INBOX = require(path.join(ROOT, 'src', 'services', 'inbox'));
const { migrateOrders } = require(path.join(ROOT, 'src', 'db', 'orders-schema'));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

function newDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  // orders-schema дописывает колонки в users, поэтому сама таблица
  // пользователей должна существовать до миграции. В бою её создаёт
  // setup-schema, который всегда идёт первым.
  db.exec(`
    CREATE TABLE clinics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      clinic_id INTEGER
    );
  `);
  migrateOrders(db);
  return db;
}

// Метка времени в прошлом: отметка «прочитано» должна быть новее
// сообщения, которое она закрывает.
function at(minutes) {
  return new Date(Date.now() - minutes * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

// Авторы сообщений разные намеренно: если все три написаны одним
// человеком, счётчики непрочитанных для него дают ноль и проверять
// видимость бессмысленно — счётчик всегда был бы нулевым.
function fixture() {
  const db = newDb();
  db.exec(`
    INSERT INTO clinics (id, name) VALUES (1, 'Клиника А'), (2, 'Клиника Б');

    INSERT INTO users (id, lab_id, name, role, active, clinic_id) VALUES
      (1, 1, 'Админ',  'admin',   1, NULL),
      (2, 1, 'ВрачА',  'dentist', 1, 1),
      (3, 1, 'ВрачБ',  'dentist', 1, 2),
      (4, 1, 'Техник', 'tech',    1, NULL);

    INSERT INTO orders (id, lab_id, order_number, clinic_id, created_by, created_at) VALUES
      (1, 1, 'Н-1', 1, 'ВрачА',  datetime('now','-3 hours')),
      (2, 1, 'Н-2', 2, 'ВрачБ',  datetime('now','-2 hours')),
      (3, 1, 'Н-3', 1, 'Техник', datetime('now','-1 hour'));

    INSERT INTO order_messages (id, order_id, lab_id, author_user_id, author_name, body, created_at) VALUES
      (1, 1, 1, 2, 'ВрачА',  'сообщение по наряду 1', datetime('now','-50 minutes')),
      (2, 2, 1, 3, 'ВрачБ',  'сообщение по наряду 2', datetime('now','-40 minutes')),
      (3, 3, 1, 4, 'Техник', 'сообщение по наряду 3', datetime('now','-30 minutes'));
  `);
  return db;
}

const scopeA = { name: 'ВрачА', clinicId: 1 };
const scopeB = { name: 'ВрачБ', clinicId: 2 };

console.log('\nИнбокс: видимость по ролям');

// --- Администратор видит всю лабораторию ---
{
  const db = fixture();
  const th = INBOX.threads(db, 1, 1, null);
  check('админ видит все три диалога', th.length === 3, `получено ${th.length}`);
  check('последним идёт самый свежий диалог',
    th.length === 3 && th[0].order_number === 'Н-3',
    th.length ? th[0].order_number : '—');
  check('админ видит чужое сообщение как непрочитанное',
    INBOX.unreadTotal(db, 1, 1, null) === 3,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  check('в ленте админа три сообщения', INBOX.recentUnread(db, 1, 1, null).length === 3);
  check('имя клиники подставляется', th.some(t => t.clinic_name === 'Клиника А'),
    th.map(t => t.clinic_name).join(','));
  db.close();
}

// --- Техник тоже видит всю лабораторию, но своё сообщение не считает ---
{
  const db = fixture();
  check('техник видит все три диалога', INBOX.threads(db, 1, 4, null).length === 3);
  check('техник не получает в непрочитанные своё сообщение',
    INBOX.unreadTotal(db, 1, 4, null) === 2,
    `получено ${INBOX.unreadTotal(db, 1, 4, null)}`);
  db.close();
}

// --- Врач видит свою клинику и наряды своей клиники от других ---
{
  const db = fixture();
  const thA = INBOX.threads(db, 1, 2, scopeA);
  const numsA = thA.map(t => t.order_number);
  check('врач А видит наряд своей клиники и наряд техника',
    numsA.length === 2 && numsA.includes('Н-1') && numsA.includes('Н-3'),
    numsA.join(','));
  check('врач А не видит чужую клинику', !numsA.includes('Н-2'), numsA.join(','));
  check('врач А не получает своё сообщение как непрочитанное',
    INBOX.unreadTotal(db, 1, 2, scopeA) === 1,
    `получено ${INBOX.unreadTotal(db, 1, 2, scopeA)}`);

  const thB = INBOX.threads(db, 1, 3, scopeB);
  check('врач Б видит только свой наряд',
    thB.length === 1 && thB[0].order_number === 'Н-2',
    thB.map(t => t.order_number).join(','));
  check('у врача Б непрочитанных нет — он и так автор',
    INBOX.unreadTotal(db, 1, 3, scopeB) === 0,
    `получено ${INBOX.unreadTotal(db, 1, 3, scopeB)}`);
  db.close();
}

// --- Врач без клиники видит только то, что завёл сам ---
{
  const db = fixture();
  db.prepare('UPDATE users SET clinic_id = NULL WHERE id = 2').run();
  const th = INBOX.threads(db, 1, 2, { name: 'ВрачА', clinicId: null });
  check('врач без клиники видит только свой наряд',
    th.length === 1 && th[0].order_number === 'Н-1',
    th.map(t => t.order_number).join(','));
  db.close();
}

// --- «Прочитать всё» не выходит за пределы видимости ---
{
  const db = fixture();
  INBOX.seenAll(db, 1, 2, at(0), scopeA);
  check('врач А после «прочитать всё» не видит непрочитанных',
    INBOX.unreadTotal(db, 1, 2, scopeA) === 0,
    `получено ${INBOX.unreadTotal(db, 1, 2, scopeA)}`);
  check('«прочитать всё» врача не закрывает чужую клинику',
    INBOX.unreadTotal(db, 1, 3, scopeB) === 0 && INBOX.unreadIn(db, 2, 2) === 1,
    `в чужом наряде отметка врача А: ${INBOX.unreadIn(db, 2, 2)}`);
  db.close();
}

console.log('\nИнбокс: непрочитанные');

// --- Свои сообщения не считаются непрочитанными ---
{
  const db = fixture();
  db.prepare(`INSERT INTO order_messages (id, order_id, lab_id, author_user_id, author_name, body)
              VALUES (4, 1, 1, 1, 'Админ', 'своё ещё')`).run();
  check('новое своё сообщение не попадает в непрочитанные',
    INBOX.unreadTotal(db, 1, 1, null) === 3,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  db.close();
}

// --- Отметка «прочитано» снимает счётчик ---
{
  const db = fixture();
  INBOX.markSeen(db, 1, 1, 1);
  check('прочитанный наряд даёт два непрочитанных',
    INBOX.unreadTotal(db, 1, 1, null) === 2,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  check('в ленте остаются два сообщения',
    INBOX.recentUnread(db, 1, 1, null).length === 2);
  check('в самом наряде счётчик обнулился', INBOX.unreadIn(db, 1, 1) === 0);
  db.close();
}

// --- Повторный вход не плодит строки отметки ---
{
  const db = fixture();
  INBOX.markSeen(db, 1, 1, 1);
  INBOX.markSeen(db, 1, 1, 1);
  const rows = db.prepare('SELECT COUNT(*) n FROM order_seen WHERE order_id = 1 AND user_id = 1').get().n;
  check('повторный вход не создаёт вторую отметку', rows === 1, `строк ${rows}`);
  db.close();
}

// --- Отметка одного наряда не влияет на другие ---
{
  const db = fixture();
  INBOX.markSeen(db, 1, 3, 1);
  const th = INBOX.threads(db, 1, 1, null);
  const t3 = th.find(t => t.order_number === 'Н-3');
  const t1 = th.find(t => t.order_number === 'Н-1');
  check('в прочитанном наряде непрочитанных нет', !!t3 && t3.unread === 0, t3 ? String(t3.unread) : 'нет наряда');
  check('в непрочитанном наряде счётчик остался', !!t1 && t1.unread === 1, t1 ? String(t1.unread) : 'нет наряда');
  db.close();
}

// --- Отметки разных пользователей не смешиваются ---
{
  const db = fixture();
  INBOX.markSeen(db, 1, 1, 1);
  check('у второго пользователя наряд остался непрочитанным',
    INBOX.unreadIn(db, 1, 4) === 1,
    `получено ${INBOX.unreadIn(db, 1, 4)}`);
  db.close();
}

// --- «Прочитать всё» ---
{
  const db = fixture();
  INBOX.seenAll(db, 1, 1, at(0));
  check('после «прочитать всё» непрочитанных нет',
    INBOX.unreadTotal(db, 1, 1, null) === 0,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  check('«прочитать всё» не стирает чужие отметки',
    INBOX.unreadIn(db, 1, 4) === 1,
    `получено ${INBOX.unreadIn(db, 1, 4)}`);
  db.close();
}

// --- Сообщение без автора приходит как непрочитанное ---
{
  const db = fixture();
  db.prepare(`INSERT INTO order_messages (id, order_id, lab_id, author_user_id, author_name, body)
              VALUES (9, 2, 1, NULL, 'Система', 'авто')`).run();
  check('сообщение без автора приходит как непрочитанное',
    INBOX.unreadTotal(db, 1, 1, null) === 4,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  db.close();
}

// --- Наряд без переписки в списке диалогов не появляется ---
{
  const db = fixture();
  db.prepare(`INSERT INTO orders (id, lab_id, order_number, created_by)
              VALUES (4, 1, 'Н-4', 'Техник')`).run();
  check('наряд без сообщений не попадает в диалоги',
    INBOX.threads(db, 1, 1, null).length === 3,
    `получено ${INBOX.threads(db, 1, 1, null).length}`);
  db.close();
}

// --- Чужая лаборатория не видна ---
{
  const db = fixture();
  db.exec(`
    INSERT INTO clinics (id, lab_id, name) VALUES (3, 2, 'Чужая');
    INSERT INTO orders (id, lab_id, order_number, clinic_id, created_by)
      VALUES (5, 2, 'Н-5', 3, 'Чужой');
    INSERT INTO order_messages (id, order_id, lab_id, author_name, body)
      VALUES (10, 5, 2, 'Чужой', 'чужое');
  `);
  check('сообщения чужой лаборатории не попадают в инбокс',
    INBOX.unreadTotal(db, 1, 1, null) === 3,
    `получено ${INBOX.unreadTotal(db, 1, 1, null)}`);
  check('диалог чужой лаборатории не показывается',
    INBOX.threads(db, 1, 1, null).length === 3);
  db.close();
}

// --- Ограничение выборки ---
{
  const db = fixture();
  check('limit ограничивает число диалогов', INBOX.threads(db, 1, 1, null, 2).length === 2);
  check('limit ограничивает ленту сообщений', INBOX.recentUnread(db, 1, 1, null, 1).length === 1);
  db.close();
}

// --- Отсутствие userId не должно ронять инбокс ---
{
  const db = fixture();
  let ok = true;
  try {
    INBOX.threads(db, 1, null, null);
    INBOX.unreadTotal(db, 1, null, null);
    INBOX.recentUnread(db, 1, null, null);
  } catch (e) { ok = false; console.log('    ' + e.message); }
  check('отсутствие userId не роняет инбокс', ok);
  db.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
if (failed.length) {
  failed.forEach(f => console.log('  ПРОВАЛЕНО: ' + f.name));
  process.exit(1);
}