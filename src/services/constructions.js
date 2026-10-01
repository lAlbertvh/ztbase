// Справочник конструкций: группы, позиции, выбор в наряде.
//
// Группы общие для всех лабораторий — это классификация продукта.
// Позиции и цены принадлежат лаборатории: lab_id обязателен во всех
// запросах, иначе администратор одной лаборатории правил бы цены,
// которые тут же увидели бы остальные.
//
// Цена может быть пустой: прайс наполняется постепенно. Поэтому null —
// допустимое значение, а не ошибка, иначе справочник нельзя было бы
// завести до проставления цен.

/** Группы вместе с числом активных позиций лаборатории — для редактора. */
function listGroups(db, labId) {
  return db.prepare(`
    SELECT g.id, g.code, g.title, g.sort,
           (SELECT COUNT(*) FROM constructions c
             WHERE c.group_id = g.id AND c.active = 1 AND c.lab_id = ?) AS items
    FROM construction_groups g
    ORDER BY g.sort, g.title
  `).all(labId);
}

/** Позиции группы лаборатории. Секции — подзаголовки в списке. */
function listConstructions(db, labId, groupId, { includeInactive = true } = {}) {
  return db.prepare(`
    SELECT * FROM constructions
    WHERE lab_id = ? AND group_id = ? ${includeInactive ? '' : 'AND active = 1'}
    ORDER BY section, sort, code
  `).all(labId, groupId);
}

/** Вся структура разом: группы, внутри разделы, внутри позиции. */
function listTree(db, labId, { includeInactive = true } = {}) {
  return listGroups(db, labId).map(g => ({
    ...g,
    sections: listSections(db, labId, g.id, { includeInactive }).map(s => ({
      ...s,
      items: db.prepare(`
        SELECT id, code, title, price, price_tech, term, sort, active
        FROM constructions
        WHERE lab_id = ? AND group_id = ? AND section IS ?
          ${includeInactive ? '' : 'AND active = 1'}
        ORDER BY sort, code
      `).all(labId, g.id, s.section),
    })),
  }));
}

function listSections(db, labId, groupId, { includeInactive = true } = {}) {
  return db.prepare(`
    SELECT section,
           COUNT(*) AS items,
           MIN(sort) AS first_sort
    FROM constructions
    WHERE lab_id = ? AND group_id = ? ${includeInactive ? '' : 'AND active = 1'}
    GROUP BY section
    ORDER BY first_sort, section
  `).all(labId, groupId);
}

/** Позиция лаборатории. Чужая позиция не находится — как её и нет. */
function getConstruction(db, labId, id) {
  return db.prepare(`
    SELECT c.*, g.title AS group_title, g.code AS group_code
    FROM constructions c JOIN construction_groups g ON g.id = c.group_id
    WHERE c.id = ? AND c.lab_id = ?
  `).get(id, labId);
}

/**
 * Структура для выпадающего списка в наряде.
 * Только активные позиции лаборатории: в наряд не должно попасть то,
 * что администратор отключил.
 */
function forOrderSelect(db, labId) {
  const rows = db.prepare(`
    SELECT c.id, c.code, c.title, c.price, c.price_tech, c.term, c.section,
           g.id AS group_id, g.code AS group_code, g.title AS group_title, g.sort AS group_sort
    FROM constructions c JOIN construction_groups g ON g.id = c.group_id
    WHERE c.active = 1 AND c.lab_id = ?
    ORDER BY g.sort, g.title, c.section, c.sort, c.code
  `).all(labId);

  const groups = [];
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group_id)) {
      const g = { id: r.group_id, code: r.group_code, title: r.group_title, items: [] };
      byGroup.set(r.group_id, g);
      groups.push(g);
    }
    byGroup.get(r.group_id).items.push({
      id: r.id, code: r.code, title: r.title,
      price: r.price, price_tech: r.price_tech, term: r.term, section: r.section,
    });
  }
  return groups;
}

/** Позиция лаборатории по коду — для заполнения наряда из переписки. */
function findByCodes(db, labId, codes) {
  const list = (Array.isArray(codes) ? codes : [codes])
    .map(c => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!list.length) return [];
  const found = new Map();
  const q = db.prepare('SELECT * FROM constructions WHERE lab_id = ? AND code = ?');
  for (const code of list) {
    const row = q.get(labId, code);
    if (row) found.set(row.code, row);
  }
  // Порядок сообщения сохраняем: договорённости обсуждались по порядку,
  // и наряд должен совпадать с разговором.
  return list.map(code => found.get(code)).filter(Boolean);
}

function createConstruction(db, labId, data) {
  const code = String(data.code || '').trim();
  const title = String(data.title || '').trim();
  if (!code) return { error: 'Укажите код позиции' };
  if (!title) return { error: 'Укажите название конструкции' };
  if (title.length > 300) return { error: 'Название слишком длинное' };

  const groupId = Number(data.group_id);
  if (!Number.isInteger(groupId) || groupId <= 0) return { error: 'Выберите группу' };
  if (!db.prepare('SELECT 1 FROM construction_groups WHERE id = ?').get(groupId)) {
    return { error: 'Группа не найдена' };
  }

  // Две цены: для врача и себестоимость для техника. Любая может быть
  // пустой — позиция есть, цена ещё не загружена. Непустая должна быть
  // числом: иначе в наряде посчиталось бы «NaN ₽».
  const client = parseMoney(data.price, 'Цена для врача');
  if (client.error) return { error: client.error };
  const tech = parseMoney(data.price_tech, 'Стоимость для техника');
  if (tech.error) return { error: tech.error };

  if (db.prepare('SELECT 1 FROM constructions WHERE lab_id = ? AND code = ?').get(labId, code)) {
    return { error: 'Позиция с таким кодом уже есть' };
  }

  const info = db.prepare(`
    INSERT INTO constructions
      (lab_id, group_id, section, code, title, price, price_tech, term, sort, active)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    labId, groupId,
    String(data.section || '').trim() || null,
    code, title, client.value, tech.value,
    String(data.term || '').trim() || null,
    Number(data.sort) || 0,
    data.active === false || data.active === '0' || data.active === undefined ? 1 : 0
  );
  return { id: info.lastInsertRowid };
}

/**
 * Разбирает сумму из формы. Пустая строка — это отсутствие цены, а не
 * ноль: ноль в наряде означал бы «работа бесплатно» и молча попал бы
 * в итог.
 */
function parseMoney(raw, label) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null };
  const value = Number(s.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${label}: сумма должна быть числом не меньше нуля` };
  }
  return { value };
}

function updateConstruction(db, labId, id, data) {
  const item = getConstruction(db, labId, id);
  if (!item) return { error: 'Позиция не найдена' };

  const title = String(data.title || '').trim();
  if (!title) return { error: 'Укажите название конструкции' };
  if (title.length > 300) return { error: 'Название слишком длинное' };

  const client = parseMoney(data.price, 'Цена для врача');
  if (client.error) return { error: client.error };
  const tech = parseMoney(data.price_tech, 'Стоимость для техника');
  if (tech.error) return { error: tech.error };

  // Код неизменяем: он же ключ импорта и привязки к нарядам. Смена
  // кода задним числом отвязала бы уже созданные наряды от прайса.
  db.prepare(`
    UPDATE constructions
    SET title = ?, section = ?, price = ?, price_tech = ?, term = ?, sort = ?, active = ?
    WHERE id = ? AND lab_id = ?
  `).run(
    title,
    String(data.section || '').trim() || null,
    client.value, tech.value,
    String(data.term || '').trim() || null,
    Number(data.sort) || 0,
    data.active === false || data.active === '0' || data.active === undefined ? 1 : 0,
    id, labId
  );
  return { id };
}

function toggleActive(db, labId, id) {
  db.prepare('UPDATE constructions SET active = 1 - active WHERE id = ? AND lab_id = ?').run(id, labId);
}

  /**
   * Удаление позиции. Сначала проверяем, не использована ли она: код
   * привязан к печатным бланкам и нарядам, и молчаливое удаление
   * оставило бы в истории нарядов ссылку в никуда.
   *
   * Проверяем order_constructions, а не order_teeth: состав наряда хранится
   * именно там. Сверка с order_teeth всегда давала ноль, и позиция,
   * вписанная в десяток нарядов, удалялась без единого предупреждения.
   */
  function deleteConstruction(db, labId, id) {
    const used = db.prepare(`
      SELECT COUNT(*) AS n FROM order_constructions
      WHERE lab_id = ? AND (
        construction_id = ?
        OR code = (SELECT code FROM constructions WHERE id = ? AND lab_id = ?)
      )
    `).get(labId, id, id, labId);
    if (used.n > 0) {
      return { error: `Позиция используется в ${used.n} наряд(ах). Отключите её, но не удаляйте.` };
    }
    db.prepare('DELETE FROM constructions WHERE id = ? AND lab_id = ?').run(id, labId);
    return {};
  }

function createGroup(db, data) {
  const code = String(data.code || '').trim();
  const title = String(data.title || '').trim();
  if (!code) return { error: 'Укажите код группы' };
  if (!title) return { error: 'Укажите название группы' };
  if (db.prepare('SELECT 1 FROM construction_groups WHERE code = ?').get(code)) {
    return { error: 'Группа с таким кодом уже есть' };
  }
  const info = db.prepare(
    'INSERT INTO construction_groups (code, title, sort) VALUES (?,?,?)'
  ).run(code, title, Number(data.sort) || 0);
  return { id: info.lastInsertRowid };
}

/**
 * Наполняет справочник лаборатории значениями по умолчанию.
 *
 * Группы общие и заводятся один раз. Позиции копируются каждой
 * лаборатории отдельно: администратор правит свой прайс и не влияет на
 * чужой. Идемпотентно — повторный вызов ничего не меняет, иначе правки
 * из админки затирались бы при каждом открытии наряда.
 */
function seed(db, labId) {
  const { GROUPS, SECTIONS } = require('./constructions-defaults');

  const ensureGroups = db.transaction(() => {
    const insGroup = db.prepare(
      'INSERT OR IGNORE INTO construction_groups (code, title, sort) VALUES (?,?,?)'
    );
    for (const g of GROUPS) insGroup.run(g.code, g.title, g.sort);
  });
  ensureGroups();

    const exists = db.prepare('SELECT COUNT(*) AS n FROM constructions WHERE lab_id = ?').get(labId).n;
    if (exists > 0) {
      // Справочник уже заполнен: новых позиций из обновлённого прайса
      // не добавляем, но названия досинхронизировать надо — иначе уже
      // заведённая лаборатория навсегда останется со старой редакцией.
      const synced = syncTitles(db, labId, SECTIONS);
      return { seeded: false, synced };
    }
  
    const idByCode = new Map(
      db.prepare('SELECT id, code FROM construction_groups').all().map(g => [g.code, g.id])
    );
    const insItem = db.prepare(`
      INSERT INTO constructions
        (lab_id, group_id, section, code, title, sort, active)
      VALUES (?,?,?,?,?,?,1)
    `);
  
    const run = db.transaction(() => {
      let sort = 0;
      for (const [sectionCode, sectionTitle, groupCode, items] of SECTIONS) {
        const groupId = idByCode.get(groupCode);
        if (!groupId) continue;
        const sectionTitleFull = `${sectionCode} — ${sectionTitle}`;
        for (const [code, title] of items) {
          insItem.run(labId, groupId, sectionTitleFull, code, title, sort++);
        }
      }
    });
    run();
  
    markSynced(db, labId);
    return { seeded: true, items: SECTIONS.reduce((n, s) => n + s[3].length, 0) };
  }

  // Ревизия стандартного прайса, применённая к лаборатории.
  //
  // Синхронизация названий идёт один раз на ревизию: иначе seed(),
  // который вызывается при каждом открытии наряда, затирал бы правки
  // администратора собственными формулировками.
  const SYNC_KEY = 'constructions_defaults_rev';
  const SYNC_REV = '2026-10-01-tirebar';

  function markSynced(db, labId) {
    // lab_settings создаётся миграцией мастера настройки, которая идёт
    // после миграции конструкций. На старте пустого сервера таблицы ещё
    // нет — тогда считаем, что синхронизация не нужна.
    const ready = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lab_settings'"
    ).get();
    if (!ready) return;
    db.prepare(`
      INSERT INTO lab_settings (lab_id, key, value) VALUES (?,?,?)
      ON CONFLICT(lab_id, key) DO UPDATE SET value = excluded.value
    `).run(labId, SYNC_KEY, SYNC_REV);
  }

  function syncTitles(db, labId, SECTIONS) {
    const ready = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lab_settings'"
    ).get();
    if (!ready) return 0;
    const done = db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
      .get(labId, SYNC_KEY);
    if (done && done.value === SYNC_REV) return 0;

    // Обновляем только позиции без цены: назначенную цену администратор
    // проставлял руками, и такие позиции трогать нельзя. Переименованные
    // без цены позиции тоже останутся как есть — но это лучше, чем
    // тихо вернуть администратору чужое название.
    const titles = new Map();
    for (const [, , , items] of SECTIONS) {
      for (const [code, title] of items) titles.set(code, title);
    }
    const sel = db.prepare(
      'SELECT id, title FROM constructions WHERE lab_id = ? AND code = ? AND price IS NULL'
    );
    const upd = db.prepare('UPDATE constructions SET title = ? WHERE id = ?');
    let synced = 0;
    const run = db.transaction(() => {
      for (const [code, title] of titles) {
        const row = sel.get(labId, code);
        if (!row || row.title === title) continue;
        upd.run(title, row.id);
        synced++;
      }
      markSynced(db, labId);
    });
    run();
    return synced;
  }

  /**
   * Позиции для отметки договорённостей в переписке.
   *
   * Отдельный метод, а не forOrderSelect: подсказка автодополнения в форме
   * наряда и список «что мы сейчас обсуждаем» — разные задачи. Здесь нужен
   * весь активный справочник лаборатории по разделам: врач отмечает
   * позиции в сообщении, а наряд собирается уже из отмеченного.
   */
  function listForChat(db, labId) {
    return listTree(db, labId, { includeInactive: false });
  }

  module.exports = {
    listGroups, listSections, listConstructions, listTree, listForChat,
    getConstruction, forOrderSelect, findByCodes,
    createConstruction, updateConstruction, toggleActive, deleteConstruction,
    createGroup, seed,
  };
