// Манипуляции: справочник, чек-лист наряда, журнал и расчёт зарплаты.
//
// Лаборатория изоляция соблюдается везде: lab_id есть в условии каждого
// запроса, поэтому чужие манипуляции и чужие журналы не читаются, даже
// если знать идентификатор.

const { defaultsForKinds, BY_KIND } = require('./manipulations-defaults');

const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- Справочник ----------

function listCatalog(db, labId, { includeInactive = true } = {}) {
  const where = includeInactive ? '' : ' AND active = 1';
  return db.prepare(
    `SELECT * FROM manipulations WHERE lab_id = ?${where} ORDER BY sort, name`
  ).all(labId);
}

function getCatalogItem(db, labId, id) {
  return db.prepare('SELECT * FROM manipulations WHERE lab_id = ? AND id = ?').get(labId, id);
}

function createCatalogItem(db, labId, data) {
  const code = String(data.code || '').trim().toUpperCase();
  const name = String(data.name || '').trim();
  if (!code) return { error: 'Укажите код манипуляции' };
  if (code.length > 24) return { error: 'Код слишком длинный' };
  if (!name) return { error: 'Укажите название манипуляции' };
  if (name.length > 200) return { error: 'Название слишком длинное' };

  const price = Number(data.price);
  if (!Number.isFinite(price) || price < 0) return { error: 'Цена должна быть числом не меньше нуля' };

  const dup = db.prepare('SELECT id FROM manipulations WHERE lab_id = ? AND code = ?').get(labId, code);
  if (dup) return { error: 'Манипуляция с таким кодом уже есть' };

  const info = db.prepare(`
    INSERT INTO manipulations (lab_id, code, name, work_kind, price, active, sort, note)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    labId, code, name, data.work_kind || null, price,
    data.active === false || data.active === '0' ? 0 : 1,
    Number(data.sort) || 0, data.note || null
  );
  return { id: info.lastInsertRowid };
}

function updateCatalogItem(db, labId, id, data) {
  const item = getCatalogItem(db, labId, id);
  if (!item) return { error: 'Манипуляция не найдена' };

  const name = String(data.name || '').trim();
  if (!name) return { error: 'Укажите название манипуляции' };
  if (name.length > 200) return { error: 'Название слишком длинное' };

  const price = Number(data.price);
  if (!Number.isFinite(price) || price < 0) return { error: 'Цена должна быть числом не меньше нуля' };

  // Код неизменяем после создания: он уже напечатан на бланках и в
  // отчётах, и его смена ломала бы чек-листы в нарядах, созданных ранее.
  db.prepare(`
    UPDATE manipulations SET name = ?, work_kind = ?, price = ?, active = ?, sort = ?, note = ?
    WHERE lab_id = ? AND id = ?
  `).run(
    name, data.work_kind || null, price,
    data.active === false || data.active === '0' ? 0 : 1,
    Number(data.sort) || 0, data.note || null, labId, id
  );
  return { id };
}

/** Переключение активности: в новые наряды перестаёт попадать, в старых остаётся. */
function toggleCatalogActive(db, labId, id) {
  const info = db.prepare(
    'UPDATE manipulations SET active = 1 - active WHERE lab_id = ? AND id = ?'
  ).run(labId, id);
  return info.changes > 0;
}

/**
 * Заполняет справочник шаблонами при первом обращении.
 * Идемпотентно: если запись с таким кодом уже есть, она не трогается,
 * поэтому правки ставок администратором не затираются.
 */
/**
 * Добавляет в справочник отсутствующие шаблоны.
 *
 * Раньше проверка шла по общему числу строк: стоило лаборатории
 * завести свою первую манипуляцию, и шаблоны больше не добавлялись.
 * Теперь сверяем по кодам, поэтому недостающие всегда доезжают.
 */
function seedDefaults(db, labId) {
  const defaults = defaultsForKinds(Object.keys(BY_KIND));
  const ins = db.prepare(`
    INSERT OR IGNORE INTO manipulations (lab_id, code, name, work_kind, price, active, sort)
    VALUES (?,?,?,?,?,1,?)
  `);

  // Нумерация по sort: добавленные позже позиции уходят в конец,
  // чтобы не переставлять уже привычный порядок у лаборатории.
  const start = db.prepare(
    'SELECT COALESCE(MAX(sort), -1) AS m FROM manipulations WHERE lab_id = ?'
  ).get(labId).m + 1;

  const tx = db.transaction(() => {
    let n = 0;
    defaults.forEach((m, i) => {
      ins.run(labId, m.code, m.name, m.work_kind, Number(m.price) || 0, start + i);
      n += 1;
    });
    return n;
  });
  return tx();
}

// ---------- Чек-лист наряда ----------

function listOrderManipulations(db, labId, orderId) {
  return db.prepare(`
    SELECT * FROM order_manipulations
    WHERE lab_id = ? AND order_id = ?
    ORDER BY done, id
  `).all(labId, orderId);
}

/**
 * Добавляет в наряд недостающие манипуляции из справочника.
 *
 * Уже добавленные не трогаются: если техник отметил выполнение, а вид
 * работы в наряде поменялся, его отметка должна остаться.
 * Возвращает число добавленных позиций.
 */
function addCatalogToOrder(db, labId, orderId, kinds) {
  // Список берём из справочника самой лаборатории, а не из шаблонов:
  // так в наряд попадают манипуляции, которые администратор завёл
  // сам, с её названиями и ценами. Выключенные позиции пропускаем —
  // в новом наряде их быть не должно.
  const list = (kinds || []).filter((k) => k);
  const marks = list.length ? list.map(() => '?').join(',') : "''";

  const catalog = db.prepare(`
    SELECT id, code, name, price FROM manipulations
    WHERE lab_id = ? AND active = 1
      AND (work_kind IS NULL OR work_kind IN (${marks}))
    ORDER BY sort, id
  `).all(labId, ...list);

  if (!catalog.length) return 0;

  const have = new Set(
    db.prepare('SELECT code FROM order_manipulations WHERE lab_id = ? AND order_id = ?')
      .all(labId, orderId).map((r) => r.code)
  );

  const ins = db.prepare(`
    INSERT INTO order_manipulations (order_id, lab_id, manipulation_id, code, name, price)
    VALUES (?,?,?,?,?,?)
  `);

  let added = 0;
  for (const c of catalog) {
    if (have.has(c.code)) continue;
    ins.run(orderId, labId, c.id, c.code, c.name, c.price);
    added += 1;
  }
  return added;
}

/** Виды работ наряда — по зубам: work_kind хранится именно там. */
function orderWorkKinds(db, labId, orderId) {
  return db.prepare(
    "SELECT DISTINCT kind FROM order_teeth WHERE lab_id = ? AND order_id = ? AND kind <> ''"
  ).all(labId, orderId).map((r) => r.kind);
}

/**
 * Отметка манипуляции. Пишет и в чек-лист, и в журнал: журнал нужен для
 * расчёта зарплаты и не должен зависеть от того, откроют наряд позже.
 */
function setManipulationDone(db, labId, orderId, manipId, done, user) {
  const row = db.prepare(
    'SELECT * FROM order_manipulations WHERE lab_id = ? AND order_id = ? AND id = ?'
  ).get(labId, orderId, manipId);
  if (!row) return { error: 'Манипуляция не найдена' };

  // Повторное нажатие на ту же отметку не плодит записи в журнале.
  if (Number(row.done) === (done ? 1 : 0)) return { ok: true, unchanged: true };

  const when = done ? nowStr() : null;
  db.prepare(`
    UPDATE order_manipulations SET done = ?, done_at = ?, done_by = ? WHERE id = ?
  `).run(done ? 1 : 0, when, done ? user : null, row.id);

  const order = db.prepare(
    'SELECT order_number FROM orders WHERE id = ? AND lab_id = ?'
  ).get(orderId, labId);
  const kind = orderWorkKinds(db, labId, orderId).join(',');

  // При снятии отметки запоминаем, чью именно работу снимают.
  // Иначе вычет ушёл бы тому, кто исправляет, а не тому, кто делал.
  const target = done ? null : (row.done_by || null);

  db.prepare(`
    INSERT INTO manipulation_log
      (order_id, lab_id, order_number, work_kind, code, name, price,
       user, target_user, action, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    orderId, labId, order?.order_number || null, kind || null,
    row.code, row.name, row.price, user || null, target,
    done ? 'done' : 'undone', nowStr()
  );

  return { ok: true, total: orderManipulationCounts(db, labId, orderId) };
}

function orderManipulationCounts(db, labId, orderId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS total, SUM(done) AS done FROM order_manipulations
    WHERE lab_id = ? AND order_id = ?
  `).get(labId, orderId);
  return { total: r.total || 0, done: r.done || 0 };
}

// ---------- Отчёт для зарплаты ----------

/**
 * Свод по технику за период: сколько манипуляций выполнено и на какую
 * сумму. Считается по журналу, поэтому наряд можно закрыть и даже
 * удалить — расчёт не изменится.
 *
 * Отменённые отметки (action = 'undone') вычитаются: иначе снятая
 * отметка осталась бы в зарплате навсегда.
 */
function reportByUser(db, labId, { dateFrom = '', dateTo = '' } = {}) {
  const where = ['lab_id = ?'];
  const params = [labId];
  if (dateFrom) { where.push('created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
  if (dateTo) { where.push('created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
  const cond = where.join(' AND ');

  // Засчитываем работу тому, кто её выполнил: у отметки author,
  // у снятой отметки — target_user, то есть автор той самой работы.
  // Иначе снятие чужой отметки уменьшало бы заработок проверяющего.
  const detail = db.prepare(`
    SELECT CASE WHEN action = 'done' THEN user ELSE target_user END AS who,
           code, name, price,
           SUM(CASE WHEN action = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN action = 'undone' THEN 1 ELSE 0 END) AS undone
    FROM manipulation_log
    WHERE ${cond} AND (user IS NOT NULL OR target_user IS NOT NULL)
    GROUP BY who, code, name, price
    ORDER BY who, name, price
  `).all(...params);

  // Цена входит в группировку: одна и та же манипуляция может стоить
  // по-разному в разных нарядах, и усреднять такие суммы нельзя.
  const grouped = new Map();
  for (const d of detail) {
    const net = (d.done || 0) - (d.undone || 0);
    if (net <= 0) continue;
    const key = `${d.who} ${d.code} ${d.price}`;
    if (!grouped.has(key)) {
      grouped.set(key, { who: d.who, code: d.code, name: d.name, price: d.price || 0, done: 0 });
    }
    grouped.get(key).done += net;
  }

  const byUser = [];
  for (const item of grouped.values()) {
    let row = byUser.find((u) => u.user === item.who);
    if (!row) {
      row = { user: item.who, operations: 0, items: [], total: 0 };
      byUser.push(row);
    }
    row.items.push({
      code: item.code,
      name: item.name,
      done: item.done,
      price: item.price,
      sum: item.done * item.price,
    });
    row.operations += item.done;
    row.total += item.done * item.price;
  }
  byUser.sort((a, b) => a.user.localeCompare(b.user, 'ru'));

  return {
    byUser,
    grandTotal: byUser.reduce((s, u) => s + u.total, 0),
    grandOperations: byUser.reduce((s, u) => s + u.operations, 0),
  };
}

/** Построчный выгруз по периоду — то, что отдают бухгалтеру. */
function reportRows(db, labId, opts) {
  return reportByUser(db, labId, opts).byUser.flatMap((u) =>
    u.items.map((i) => ({
      user: u.user, code: i.code, name: i.name,
      count: i.done, price: i.price, sum: i.sum,
    }))
  );
}

module.exports = {
  listCatalog, getCatalogItem, createCatalogItem, updateCatalogItem,
  toggleCatalogActive, seedDefaults,
  listOrderManipulations, addCatalogToOrder, orderWorkKinds,
  setManipulationDone, orderManipulationCounts,
  reportByUser, reportRows,
};
