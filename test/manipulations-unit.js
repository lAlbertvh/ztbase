/**
 * Расчёт зарплаты по манипуляциям — проверка без HTTP.
 *
 * Здесь нет сервера и нет браузера: только база в памяти и сам сервис.
 * Так дешевле проверить арифметику журнала, где легче всего ошибиться
 * в вычетах, и не тянуть для этого полный прогон приложения.
 */

const path = require('path');
const Database = require('better-sqlite3');
const M = require(path.join(__dirname, '..', 'src', 'services', 'manipulations'));
const O = require(path.join(__dirname, '..', 'src', 'services', 'orders'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`   ${ok ? 'OK  ' : 'СБОЙ'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, lab_id INTEGER, order_number TEXT);
    CREATE TABLE order_teeth (id INTEGER PRIMARY KEY, lab_id INTEGER,
                              order_id INTEGER, kind TEXT);
  `);
  // Схему манипуляций берём настоящей миграцией, а не переписываем
  // руками: ручная копия однажды разошлась с кодом (не хватало колонки
  // note), и проверка падала на ошибке «такой таблицы нет».
  require(path.join(__dirname, '..', 'src', 'db', 'manipulations-schema'))
    .migrateManipulations(db);
  return db;
}

// Заводит наряд с одной манипуляцией указанной цены.
function addOrder(db, labId, code, price) {
  const oid = db.prepare('INSERT INTO orders (lab_id, order_number) VALUES (?,?)')
    .run(labId, `${code}-${labId}`).lastInsertRowid;
  db.prepare('INSERT INTO order_teeth (lab_id, order_id, kind) VALUES (?,?,?)')
    .run(labId, oid, 'crown');
  const mid = db.prepare(
    'INSERT INTO order_manipulations (order_id, lab_id, code, name, price, done) VALUES (?,?,?,?,?,0)'
  ).run(oid, labId, code, code, price).lastInsertRowid;
  return { oid, mid };
}

const db = makeDb();

// --- Сумма по выполненной работе ------------------------------------
{
  const { oid, mid } = addOrder(db, 1, 'A', 500);
  M.setManipulationDone(db, 1, oid, mid, true, 'Техник');
  const r = M.reportByUser(db, 1, {});
  check('одна отметка даёт свою сумму', r.grandTotal === 500, `получено ${r.grandTotal}`);
  check('счётчик манипуляций совпадает', r.grandOperations === 1, `получено ${r.grandOperations}`);
}

// --- Снятие отметки уменьшает работу автора, а не проверяющего ---------
{
  const { oid, mid } = addOrder(db, 1, 'B', 300);
  M.setManipulationDone(db, 1, oid, mid, true, 'Техник');
  M.setManipulationDone(db, 1, oid, mid, false, 'Админ');
  const r = M.reportByUser(db, 1, {});
  const tech = r.byUser.find((u) => u.user === 'Техник');
  const admin = r.byUser.find((u) => u.user === 'Админ');
  const b = tech.items.find((i) => i.code === 'B');
  check('снятая работа убрана у техника', !b || b.done === 0, JSON.stringify(b));
  check('админ не получил чужую работу в плюс', !admin || admin.total === 0,
    JSON.stringify(admin));
  check('сумма уменьшилась на цену', r.grandTotal === 500, `получено ${r.grandTotal}`);
}

// --- Повторная отметка возвращает работу ------------------------------
{
  const { oid, mid } = addOrder(db, 1, 'B', 300);
  const done = db.prepare('SELECT id FROM order_manipulations WHERE code = ? AND order_id = ?')
    .get('B', oid);
  M.setManipulationDone(db, 1, oid, done.id, true, 'Техник');
  const r = M.reportByUser(db, 1, {});
  const tech = r.byUser.find((u) => u.user === 'Техник');
  const b = tech.items.find((i) => i.code === 'B');
  check('после повторной отметки работа вернулась', b && b.done === 1, JSON.stringify(b));
  check('сумма снова 800', r.grandTotal === 800, `получено ${r.grandTotal}`);
}

// --- Одна манипуляция по разным ценам считается отдельно ---------------
{
  const { oid: o1, mid: m1 } = addOrder(db, 1, 'C', 700);
  const { oid: o2, mid: m2 } = addOrder(db, 1, 'C', 1000);
  M.setManipulationDone(db, 1, o1, m1, true, 'Техник');
  M.setManipulationDone(db, 1, o2, m2, true, 'Техник');
  const r = M.reportByUser(db, 1, {});
  const tech = r.byUser.find((u) => u.user === 'Техник');
  const rows = tech.items.filter((i) => i.code === 'C');
  check('разные цены не смешаны в одну строку', rows.length === 2, JSON.stringify(rows));
  check('сумма по обеим ценам верна', r.grandTotal === 800 + 700 + 1000, `получено ${r.grandTotal}`);
}

// --- Лаборатории не видят друг друга -----------------------------------
{
  const { oid, mid } = addOrder(db, 2, 'D', 999);
  M.setManipulationDone(db, 2, oid, mid, true, 'Чужой');
  const mine = M.reportByUser(db, 1, {});
  const theirs = M.reportByUser(db, 2, {});
  check('чужая работа не попала в мой расчёт', mine.grandTotal === 2500, `получено ${mine.grandTotal}`);
  check('в чужом расчёте только своя работа', theirs.grandTotal === 999, `получено ${theirs.grandTotal}`);
}

// --- Фильтр по периоду --------------------------------------------------
{
  const all = M.reportByUser(db, 1, {});
  const future = M.reportByUser(db, 1, { dateFrom: '2099-01-01' });
  const empty = M.reportByUser(db, 1, { dateFrom: '', dateTo: '2000-01-01' });
  check('период с будущим даёт пусто', future.grandOperations === 0, `${future.grandOperations}`);
  check('прошедший период даёт пусто', empty.grandOperations === 0, `${empty.grandOperations}`);
  check('без периода видно всё', all.grandOperations === 4, `${all.grandOperations}`);
}

// --- Подстановка в наряд из справочника ---------------------------------
{
  const ins = db.prepare(
    'INSERT INTO manipulations (lab_id, code, name, work_kind, price, active, sort) VALUES (?,?,?,?,?,?,?)'
  );
  ins.run(3, 'GENERIC', 'Приём', null, 0, 1, 0);
  ins.run(3, 'CROWN', 'Коронка', 'crown', 700, 1, 1);
  ins.run(3, 'OFF', 'Выключенная', null, 0, 0, 2);

  const oid = db.prepare('INSERT INTO orders (lab_id, order_number) VALUES (3,?)').run('Н-1').lastInsertRowid;
  const added = M.addCatalogToOrder(db, 3, oid, ['crown']);
  const codes = db.prepare('SELECT code FROM order_manipulations WHERE order_id = ? ORDER BY id')
    .all(oid).map((r) => r.code);

  check('в наряд попал общий шаг и шаг по виду работы',
    codes.includes('GENERIC') && codes.includes('CROWN'), codes.join(', '));
  check('выключенная манипуляция не попала в наряд', !codes.includes('OFF'), codes.join(', '));
  check('цена взята из справочника',
    db.prepare('SELECT price FROM order_manipulations WHERE code = ?').get('CROWN').price === 700);
  check('повторный вызов не дублирует', M.addCatalogToOrder(db, 3, oid, ['crown']) === 0);
  check('за один вызов добавлено две позиции', added === 2, `${added}`);
}

// --- Без вида работы добавляются только общие шаги ----------------------
{
  const oid = db.prepare('INSERT INTO orders (lab_id, order_number) VALUES (3,?)').run('Н-2').lastInsertRowid;
  M.addCatalogToOrder(db, 3, oid, []);
  const codes = db.prepare('SELECT code FROM order_manipulations WHERE order_id = ?')
    .all(oid).map((r) => r.code);
  check('без вида работы только общие шаги',
    codes.length === 1 && codes[0] === 'GENERIC', codes.join(', '));
}

// --- Шаблоны не дублируются --------------------------------------------
{
  const lab = 4;
  M.seedDefaults(db, lab);
  const after = db.prepare('SELECT COUNT(*) n FROM manipulations WHERE lab_id = ?').get(lab).n;
  M.seedDefaults(db, lab);
  const again = db.prepare('SELECT COUNT(*) n FROM manipulations WHERE lab_id = ?').get(lab).n;
  const dupes = db.prepare(
    'SELECT COUNT(*) n FROM (SELECT code FROM manipulations WHERE lab_id = ? GROUP BY code HAVING COUNT(*) > 1)'
  ).get(lab).n;
  check('повторный шаблон не создаёт дублей', after === again && dupes === 0, `${after} → ${again}`);
}

// --- Тестовые ставки из шаблона ----------------------------------------
{
  const lab = 5;
  M.seedDefaults(db, lab);
  const prices = db.prepare('SELECT price FROM manipulations WHERE lab_id = ?').all(lab).map((r) => r.price);
  const allInRange = prices.length > 0 && prices.every((p) => p >= 150 && p <= 500);
  check('все стартовые цены в диапазоне 150–500',
    allInRange, `мин ${Math.min(...prices)}, макс ${Math.max(...prices)}, позиций ${prices.length}`);
}

  // --- Итоги по конструкциям: две цены и скидка -------------------------
  // Проверяем без БД: constructionsTotal чистая функция, а ошибка в ней
  // тихо превращается в «дешёвый наряд», который клиника принимает.
  {
    const t = O.constructionsTotal;
    const r1 = t([{ price: 1000, price_tech: 500, qty: 1 }]);
    check('две цены считаются раздельно',
      r1.client === 1000 && r1.tech === 500, JSON.stringify(r1));

    const r2 = t([{ price: 1000, price_tech: 500, qty: 2 }]);
    check('количество умножает обе цены',
      r2.client === 2000 && r2.tech === 1000, JSON.stringify(r2));

    const r3 = t([{ price: 1000, price_tech: 500, qty: 1 }], 20);
    check('скидка уменьшает итог для врача',
      r3.clientTotal === 800 && r3.saved === 200, JSON.stringify(r3));

    const r4 = t([{ price: 1000, price_tech: 500, qty: 1 }], 20);
    check('скидка не уменьшает себестоимость',
      r4.tech === 500, JSON.stringify(r4));

    const r5 = t([{ price: null, price_tech: null, qty: 1 }]);
    check('позиция без цены не становится нулём',
      r5.missingClient === 1 && r5.missingTech === 1 && r5.client === 0,
      JSON.stringify(r5));

    const r6 = t([{ price: 1000, price_tech: null, qty: 1 }]);
    check('нет техцены — нет списания по себестоимости',
      r6.missingTech === 1 && r6.missingClient === 0 && r6.tech === 0,
      JSON.stringify(r6));

    // 130% не должны превратить счёт в долг.
    const r7 = t([{ price: 1000, price_tech: 500, qty: 1 }], 130);
    check('скидка больше 100 обрезается',
      r7.discount === 100 && r7.clientTotal === 0, JSON.stringify(r7));

    const r8 = t([{ price: 1000, price_tech: 500, qty: 1 }], -50);
    check('отрицательная скидка не превращается в надбавку',
      r8.discount === 0 && r8.clientTotal === 1000, JSON.stringify(r8));

    // Раздельный учёт: цена для врача и себестоимость не должны смешиваться.
    const r9 = t([
      { price: 3000, price_tech: 1200, qty: 1 },
      { price: 500, price_tech: 200, qty: 3 },
    ], 10);
    check('сумма по смешанному списку верна',
      r9.client === 4500 && r9.tech === 1800 && r9.clientTotal === 4050,
      JSON.stringify(r9));

    const base = { order_number: 'ПР-1', teeth: '16' };
    const parsed = O.parseOrderForm({ ...base, discount: '20,5' });
    check('запятая в скидке из формы разбирается как точка',
      parsed.ok && parsed.data.discount === 20.5, JSON.stringify(parsed.data && parsed.data.discount));

    const blank = O.parseOrderForm({ ...base, discount: '' });
    check('пустая скидка — ноль, а не null',
      blank.ok && blank.data.discount === 0, String(blank.data && blank.data.discount));

    const junk = O.parseOrderForm({ ...base, discount: 'abc' });
    check('мусор в скидке не ломает наряд',
      junk.ok && junk.data.discount === 0, JSON.stringify(junk.ok ? junk.data.discount : junk.error));

    const own = O.parseOrderForm({
      ...base,
      construction_custom: ['Своя работа'],
      construction_custom_price: ['4000'],
      construction_custom_price_tech: ['1500'],
      construction_qty: ['2'],
    });
    const c = own.ok ? own.data.constructions[0] : null;
    check('своя конструкция хранит обе цены',
      c && c.price === 4000 && c.price_tech === 1500, JSON.stringify(c));
  }

  // --- Обязательные манипуляции: подсветка, не блокировка ----------------
//
// Пользователь выбрал вариант «только подсветить»: неотмеченные
// обязательные видны в чек-листе, но наряд можно выпустить. Проверяем
// именно это — раньше обязательности не было вовсе.
{
  // Своя лаборатория: у остальных блоков в справочнике уже есть позиции,
  // и счётчик пропусков считал бы их вместе с проверяемыми.
  const lab = 40;
  M.createCatalogItem(db, lab, { code: 'MUST', name: 'Обязательный шаг', price: 100 });
  M.createCatalogItem(db, lab, { code: 'MAYBE', name: 'Необязательный шаг', price: 100, required: false });

  const { oid } = addOrder(db, lab, 'A', 500);
  db.prepare("INSERT INTO order_teeth (order_id, lab_id, kind) VALUES (?, ?, 'crown')").run(oid, lab);
  M.addCatalogToOrder(db, lab, oid, ['crown']);

  const items = M.listOrderManipulations(db, lab, oid);
  const must = items.find((i) => i.code === 'MUST');
  const maybe = items.find((i) => i.code === 'MAYBE');
  check('в наряд попала обязательная позиция', !!must, 'нет MUST');
  check('в наряд попала необязательная позиция', !!maybe, 'нет MAYBE');
  check('признак обязательности скопирован в наряд',
    must && maybe && must.required === 1 && maybe.required === 0,
    `must=${must?.required} maybe=${maybe?.required}`);

  const counts = M.orderManipulationCounts(db, lab, oid);
  // Обязательных в наряде две: позиция из addOrder и MUST. MAYBE в счёт
  // не входит — иначе подсветка показывала бы необязательную работу
  // как пропущенную, и её пришлось бы отмечать из-под руки.
  const requiredTotal = items.filter((i) => i.required === 1).length;
  check('неотмеченные обязательные посчитаны',
    counts.missingRequired === requiredTotal,
    `получено ${counts.missingRequired}, обязательных ${requiredTotal}`);
  check('необязательная в пропуски не попала',
    !items.filter((i) => i.required === 1).some((i) => i.code === 'MAYBE'),
    'MAYBE посчитан как обязательный');
  check('пропуск виден, но не мешает считать всего',
    counts.total === items.length, `total=${counts.total} items=${items.length}`);

  // Снятие обязательности в справочнике не должно менять уже созданный
  // наряд: условия работы фиксируются на момент поступления заказа.
  M.updateCatalogItem(db, lab, must.manipulation_id,
    { name: must.name, price: 100, required: false });
  const after = M.listOrderManipulations(db, lab, oid).find((i) => i.code === 'MUST');
  check('правка справочника не меняет прошлый наряд', after.required === 1,
    `получено ${after.required}`);

  // Отмечаем все обязательные — только тогда пропусков не остаётся.
  for (const i of items.filter((x) => x.required === 1)) {
    M.setManipulationDone(db, lab, oid, i.id, true, 'Техник');
  }
  check('после отметки пропусков не осталось',
    M.orderManipulationCounts(db, lab, oid).missingRequired === 0);
}

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
  process.exit(failed.length ? 1 : 0);
