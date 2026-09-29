// Работа с заказ-нарядами: валидация, чтение, запись.
//
// Здесь нет ни HTTP, ни EJS — только операции над данными и разбором
// входных форм. Благодаря этому правила валидации не расходятся между
// маршрутами, а сам модуль можно вызывать из фоновых задач.
//
// Правило номер один: lab_id берётся из сессии и подставляется в
// каждый запрос. Лаборатория из тела запроса не принимается никогда,
// иначе наряд одной лаборатории можно было бы прочитать чужой.

const R = require('./dental-reference');

const STAGE_KEYS = new Set(R.STAGES.map(s => s.key));
const WORK_KEYS = new Set(R.WORK_KINDS.map(w => w.kind));

// Значение из multipart-формы может быть строкой, массивом или undefined.
// Приводим к строке и обрезаем: в БД не должно быть хвостовых пробелов.
const str = (v) => (v === undefined || v === null ? '' : (Array.isArray(v) ? v[0] : String(v))).trim();

// Зубы приходят как "18", "18,17", "18 17 16". Собираем в массив чисел,
// отбрасывая мусор: иначе один символ в поле ломает весь наряд.
// Допустимые номера зубов постоянного прикуса: 11-18, 21-28, 31-38,
// 41-48. Простая проверка «от 11 до 48» не годится — она пропустила бы
// 19, 20, 29, 30, 39 и 40, которых в формуле нет.
const PERMANENT_TEETH = new Set(R.QUADRANTS.flatMap(q => q.teeth));

function parseTeeth(value) {
  const out = [];
  for (const part of String(value || '').split(/[\s,;]+/)) {
    const n = parseInt(part, 10);
    if (Number.isInteger(n) && PERMANENT_TEETH.has(n)) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Список ключей из checkbox-группы. Пропускаем только известные ключи,
// чтобы клиент не записал в БД произвольные строки.
function parseKeys(value, allowed) {
  const raw = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  return raw.map(v => str(v)).filter(v => allowed.has(v));
}

/**
 * Разбирает и проверяет форму наряда.
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
function parseOrderForm(body) {
  const orderNumber = str(body.order_number);
  if (!orderNumber) return { ok: false, error: 'Укажите номер наряда' };
  if (orderNumber.length > 60) return { ok: false, error: 'Номер наряда слишком длинный' };

  const stage = str(body.stage) || 'new';
  if (!STAGE_KEYS.has(stage)) return { ok: false, error: 'Неизвестный этап работы' };

  const teethRaw = parseTeeth(body.teeth);
  if (teethRaw.length === 0) return { ok: false, error: 'Укажите хотя бы один зуб в зубной формуле' };

  // Вид работ выбирается для набора зубов. Если вид не задан, берём
  // первый из формы: иначе зуб сохранился бы без типа и не попал
  // бы в печатный бланк.
  const kind = str(body.work_kind);
  if (kind && !WORK_KEYS.has(kind)) return { ok: false, error: 'Неизвестный вид работы' };
  const workKind = kind || 'other';

  return {
    ok: true,
    data: {
      order_number: orderNumber,
      customer: str(body.customer).slice(0, 200),
      phone: str(body.phone).slice(0, 60),
      email: str(body.email).slice(0, 120),
      patient: str(body.patient).slice(0, 200),
      delivery_address: str(body.delivery_address).slice(0, 300),
      stage,
      priority: str(body.priority) === '1' ? 1 : 0,
      comment: str(body.comment).slice(0, 4000),
      dentist_note: str(body.dentist_note).slice(0, 4000),
      taken_at: str(body.taken_at) || null,
      promised_at: str(body.promised_at) || null,
      teeth: teethRaw,
      work_kind: workKind,
      material: str(body.material).slice(0, 120),
      color: str(body.color).slice(0, 40),
      tooth_note: str(body.tooth_note).slice(0, 1000),
      abutment: parseKeys(body.abutment, new Set(R.ABUTMENT_OPTIONS.map(o => o.key))),
      flags: parseKeys(body.flags, new Set(R.FRAME_FLAGS.map(o => o.key))),
      incoming: parseKeys(body.incoming, new Set(R.INCOMING_OPTIONS.map(o => o.key))),
      delivery: parseKeys(body.delivery, new Set(R.DELIVERY_OPTIONS.map(o => o.key))),
      materials: parseMaterials(body),
    },
  };
}

// Материалы приходят по именам. Техник может выбрать из справочника
// или вписать своё имя — поэтому name обязателен, а material_id
// заполняется, только если значение реально есть в справочнике.
function parseMaterials(body) {
  const names = body['material_name'];
  const qty = body['material_qty'];
  const units = body['material_unit'];
  const notes = body['material_note'];
  const ids = body['material_id'];

  const asArr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const n = asArr(names), q = asArr(qty), u = asArr(units);
  const nt = asArr(notes), idArr = asArr(ids);
  const out = [];

  for (let i = 0; i < n.length; i++) {
    const name = str(n[i]).slice(0, 120);
    if (!name) continue;
    const parsedQty = parseFloat(String(q[i] ?? '1').replace(',', '.'));
    out.push({
      material_id: Number.isInteger(parseInt(idArr[i], 10)) ? parseInt(idArr[i], 10) : null,
      name,
      qty: Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1,
      unit: str(u[i]).slice(0, 20) || 'шт',
      note: str(nt[i]).slice(0, 300),
    });
    if (out.length >= 60) break; // защита от absurdного размера формы
  }
  return out;
}

/** Собирает наряд со всеми связями для одного просмотра. */
function getOrder(db, labId, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND lab_id = ?').get(id, labId);
  if (!order) return null;

  const teeth = db.prepare('SELECT * FROM order_teeth WHERE order_id = ? AND lab_id = ? ORDER BY tooth').all(id, labId);
  const stages = db.prepare('SELECT * FROM order_stages WHERE order_id = ? AND lab_id = ? ORDER BY created_at DESC, id DESC').all(id, labId);
  const materials = db.prepare('SELECT * FROM order_materials WHERE order_id = ? AND lab_id = ? ORDER BY id').all(id, labId);

  return { ...order, teeth, stages, materials };
}

/**
 * Список нарядов с фильтрами. lab_id всегда первый условие.
 */
function listOrders(db, labId, filters = {}) {
  const where = ['lab_id = ?'];
  const params = [labId];

  if (filters.stage) {
    where.push('stage = ?');
    params.push(filters.stage);
  }
  if (filters.search) {
    // Ищем по номеру, заказчику и пациенту разом: на практике ищут
    // по тому, что на руках у клиента, а не по номеру наряда.
    where.push('(order_number LIKE ? OR customer LIKE ? OR patient LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.date_from) {
    where.push('date(created_at) >= date(?)');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push('date(created_at) <= date(?)');
    params.push(filters.date_to);
  }
  // Фильтр по владельцу обязателен до LIMIT: если отсечь стоматолога
  // уже после выборки, он получит чужие наряды вместо своих.
  if (filters.owner) {
    where.push('created_by = ?');
    params.push(filters.owner);
  }

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const rows = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*) FROM order_teeth t WHERE t.order_id = o.id AND t.lab_id = o.lab_id) AS teeth_count,
           (SELECT GROUP_CONCAT(t2.tooth, ' ') FROM order_teeth t2
             WHERE t2.order_id = o.id AND t2.lab_id = o.lab_id ORDER BY t2.tooth) AS teeth_list,
           (SELECT GROUP_CONCAT(DISTINCT kind) FROM order_teeth t WHERE t.order_id = o.id AND t.lab_id = o.lab_id) AS kinds
    FROM orders o
    WHERE ${where.join(' AND ')}
    ORDER BY o.priority DESC, datetime(o.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where.join(' AND ')}`).get(...params).n;
  return { rows, total, limit, offset };
}

/**
 * Сохраняет наряд целиком: шапку, зубы и материалы.
 * Зубы и материалы перезаписываются, а не дополняются — иначе
 * повторное сохранение формы накапливало бы дубликаты.
 */
function saveOrder(db, labId, data, user) {
  const tx = db.transaction(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    let orderId = data.id ? Number(data.id) : null;
    if (orderId) {
      // Проверяем занятость номера до UPDATE и исключаем сам наряд:
      // без этой проверки занятый номер ронял бы запрос ошибкой
      // уникального индекса SQLite, и сотрудник видел бы 500 вместо
      // понятного сообщения о дубликате.
      const dupEdit = db.prepare(
        'SELECT id FROM orders WHERE lab_id = ? AND order_number = ? AND id <> ?'
      ).get(labId, data.order_number, orderId);
      if (dupEdit) return { id: null, error: 'Наряд с таким номером уже есть' };

      // UPDATE с lab_id в условии: наряд чужой лаборатории нельзя
      // изменить, даже если знать его id.
      const res = db.prepare(`
        UPDATE orders SET
          order_number = ?, customer = ?, phone = ?, email = ?,
          patient = ?, delivery_address = ?, stage = ?, priority = ?,
          comment = ?, dentist_note = ?, taken_at = ?, promised_at = ?,
          incoming = ?, delivery = ?, updated_at = ?
        WHERE id = ? AND lab_id = ?
      `).run(
        data.order_number, data.customer, data.phone, data.email,
        data.patient, data.delivery_address, data.stage, data.priority,
        data.comment, data.dentist_note, data.taken_at, data.promised_at,
        (data.incoming || []).join(','), (data.delivery || []).join(','),
        now, orderId, labId,
      );
      if (res.changes === 0) return { id: null, error: 'Наряд не найден' };
    } else {
      const dup = db.prepare('SELECT id FROM orders WHERE lab_id = ? AND order_number = ?').get(labId, data.order_number);
      if (dup) return { id: null, error: 'Наряд с таким номером уже есть' };

      const info = db.prepare(`
        INSERT INTO orders
          (lab_id, order_number, customer, phone, email, patient, delivery_address,
           stage, priority, comment, dentist_note, taken_at, promised_at, incoming, delivery,
           created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        labId, data.order_number, data.customer, data.phone, data.email,
        data.patient, data.delivery_address, data.stage, data.priority,
        data.comment, data.dentist_note, data.taken_at, data.promised_at,
        (data.incoming || []).join(','), (data.delivery || []).join(','),
        user || null, now, now,
      );
      orderId = info.lastInsertRowid;
    }

    // Зубы и материалы заменяем целиком.
    db.prepare('DELETE FROM order_teeth WHERE order_id = ? AND lab_id = ?').run(orderId, labId);
    const insTooth = db.prepare(`
      INSERT INTO order_teeth (order_id, lab_id, tooth, kind, material, color, note, abutment, flags)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const t of data.teeth) {
      insTooth.run(orderId, labId, t, data.work_kind, data.material, data.color,
        data.tooth_note, data.abutment.join(','), data.flags.join(','));
    }

    db.prepare('DELETE FROM order_materials WHERE order_id = ? AND lab_id = ?').run(orderId, labId);
    const insMat = db.prepare(`
      INSERT INTO order_materials (order_id, lab_id, material_id, name, qty, unit, note)
      VALUES (?,?,?,?,?,?,?)
    `);
    for (const m of data.materials) {
      insMat.run(orderId, labId, m.material_id, m.name, m.qty, m.unit, m.note);
    }

    // Первый этап пишется только при создании: при редактировании
    // журнал уже есть, и повторная запись «новый» затирала бы историю.
    if (!data.id) {
      addStage(db, labId, orderId, data.stage, 'Наряд создан', user);
    }
    return { id: orderId };
  });

  return tx();
}

/**
 * Добавляет запись в журнал этапов. Так как «Взято в работу»
 * фиксирует дату начала, она же ставится в orders.taken_at.
 */
function addStage(db, labId, orderId, stage, note, user) {
  if (!STAGE_KEYS.has(stage)) return null;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare(`
    INSERT INTO order_stages (order_id, lab_id, stage, note, user, created_at, finished_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(orderId, labId, stage, note || null, user || null, now, now);

  db.prepare('UPDATE orders SET stage = ?, updated_at = ? WHERE id = ? AND lab_id = ?')
    .run(stage, now, orderId, labId);

  if (stage === 'taken' && !db.prepare('SELECT taken_at FROM orders WHERE id = ? AND lab_id = ?').get(orderId, labId)?.taken_at) {
    db.prepare('UPDATE orders SET taken_at = ? WHERE id = ? AND lab_id = ?').run(now, orderId, labId);
  }
  if (stage === 'issued') {
    db.prepare('UPDATE orders SET issued_at = ? WHERE id = ? AND lab_id = ?').run(now, orderId, labId);
  }
  return info.lastInsertRowid;
}

/** Сводка по лаборатории: сколько заказов на каждом этапе. */
function stageSummary(db, labId) {
  const rows = db.prepare('SELECT stage, COUNT(*) AS n FROM orders WHERE lab_id = ? GROUP BY stage').all(labId);
  const map = Object.fromEntries(rows.map(r => [r.stage, r.n]));
  return Object.fromEntries(R.STAGES.map(s => [s.key, map[s.key] || 0]));
}

/** Удаляет наряд вместе со всеми связанными записями. */
function deleteOrder(db, labId, id) {
  return db.prepare('DELETE FROM orders WHERE id = ? AND lab_id = ?').run(id, labId).changes > 0;
}

module.exports = {
  parseOrderForm, parseTeeth, getOrder, listOrders,
  saveOrder, addStage, stageSummary, deleteOrder,
};
