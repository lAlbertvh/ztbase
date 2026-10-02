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
  function parseOrderForm(body, opts = {}) {
    const canSetPrices = opts.canSetPrices !== false;
    // Этапы и отметки сверяются с настройками лаборатории, а не с
    // константами: иначе этап, добавленный администратором, не прошёл бы
    // проверку, а скрытый — попал бы в наряд из подделанной формы.
    const stageKeys = opts.stageKeys || STAGE_KEYS;
    const flagKeys = opts.flagKeys || new Set(R.FRAME_FLAGS.map(o => o.key));
    const orderNumber = str(body.order_number);
  if (!orderNumber) return { ok: false, error: 'Укажите номер наряда' };
  if (orderNumber.length > 60) return { ok: false, error: 'Номер наряда слишком длинный' };

  const stage = str(body.stage) || 'new';
  if (!stageKeys.has(stage)) return { ok: false, error: 'Неизвестный этап работы' };

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
      flags: parseKeys(body.flags, flagKeys),
      incoming: parseKeys(body.incoming, new Set(R.INCOMING_OPTIONS.map(o => o.key))),
      delivery: parseKeys(body.delivery, new Set(R.DELIVERY_OPTIONS.map(o => o.key))),
      materials: parseMaterials(body),
        constructions: parseConstructions(body, canSetPrices),
        // Клиника наряда. Врачу её назначает сервер (opts.clinicId по его
        // учётной записи), и значение из формы игнорируется — иначе врач
        // вписал бы наряд в чужую клинику одной строкой в HTML.
        clinic_id: opts.clinicId != null ? Number(opts.clinicId) || null : null,
        // Скидку нельзя вписать в наряд без права на неё: иначе любой,
        // кто может создать наряд, снизил бы цену клинике до нуля.
        discount: opts.canDiscount === false ? 0 : parseDiscount(body.discount),
    },
  };
}

// Конструкции приходят выбранными из справочника: массив id и
// параллельные массивы количества, материала и примечания — так же,
// как материалы, чтобы форма не плодила имена полей.
//
// Название и цена берутся из справочника на сервере, а не из формы:
// иначе в наряд можно было бы вписать любую цену прямо в HTML, и
// стоимость заказа перестала бы считаться из прайса.
  function parseConstructions(body, allowCustomPrice = true) {
    const ids = body['construction_id'];
  const qty = body['construction_qty'];
  const material = body['construction_material'];
  const note = body['construction_note'];
  const custom = body['construction_custom'];
  const customPrice = body['construction_custom_price'];
  const customTech = body['construction_custom_price_tech'];

  const count = Math.max(
    Array.isArray(ids) ? ids.length : (ids ? 1 : 0),
    Array.isArray(custom) ? custom.length : (custom ? 1 : 0),
  );

  const out = [];
  for (let i = 0; i < count; i++) {
    const rawId = Array.isArray(ids) ? ids[i] : ids;
    const id = parseInt(rawId, 10);
    const own = str(Array.isArray(custom) ? custom[i] : custom).slice(0, 200);

    // Позиция без id и без своего названия — пустая строка, её не
    // сохраняем: форма не должна оставлять мусор от удалённых строк.
    if (!(Number.isInteger(id) && id > 0) && !own) continue;

      const n = Number(Array.isArray(qty) ? qty[i] : 1);
      const p = Number(Array.isArray(customPrice) ? customPrice[i] : customPrice);
      const pt = Number(Array.isArray(customTech) ? customTech[i] : customTech);

      out.push({
        construction_id: Number.isInteger(id) && id > 0 ? id : null,
        // Своя конструкция — это нормальный сценарий: клиника заказывает
        // то, чего нет в прайсе, и в учёте это должно остаться такой же
        // строкой, как позиция из справочника, иначе суммы и отчёт по
        // изготовленному её теряют.
        title: own || null,
        // Цены своей конструкции принимаются только от администратора.
        // Врач и техник описывают работу, но назначают цену владелец
        // версии: иначе цену можно было бы подделать прямо в HTML.
        price: allowCustomPrice && Number.isFinite(p) && p >= 0 ? p : null,
        price_tech: allowCustomPrice && Number.isFinite(pt) && pt >= 0 ? pt : null,
      qty: Number.isFinite(n) && n > 0 ? n : 1,
      material: str(Array.isArray(material) ? material[i] : material).slice(0, 120),
      note: str(Array.isArray(note) ? note[i] : note).slice(0, 300),
    });
  }
  return out;
}

/**
 * Скидка в процентах. Значение ограничено диапазоном 0–100: отрицательная
 * скидка превращалась бы в надбавку, а больше сотни — в отрицательную
 * сумму счёта, и клиника увидела бы долг вместо скидки.
 */
function parseDiscount(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
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
  const constructions = db.prepare(
    'SELECT * FROM order_constructions WHERE order_id = ? AND lab_id = ? ORDER BY id'
  ).all(id, labId);

  return {
    ...order, teeth, stages, materials, constructions,
    // Название клиники подтягиваем здесь, а не в разметке запросом: карточка
    // наряда показывается лаборатории, которой нужно видеть, чья это работа,
    // и подстановка названия одной выборкой дешевле лишнего обращения.
    clinic_name: order.clinic_id
      ? (db.prepare('SELECT name FROM clinics WHERE id = ? AND lab_id = ?')
        .get(order.clinic_id, labId) || {}).name || null
      : null,
    total: constructionsTotal(constructions, order.discount),
  };
}

/**
 * Итоги по наряду — три разные суммы, потому что видят их разные люди.
 *
 * client — что платит клиника: цена для врача минус скидка.
 * tech — во сколько обходится работа лаборатории: цена для техника.
 * Скидка на tech не влияет намеренно: скидка клинике даётся из
 * маржи лаборатории, и урезать из неё зарплату техника было бы
 * ошибкой, которую потом никто не найдёт.
 *
 * Позиции без цены не считаются нулём молча — они попадают в
 * missingClient / missingTech, иначе наряд выглядел бы дешёвым
 * из-за неполного прайса.
 */
function constructionsTotal(constructions, discount = 0) {
  const d = Math.min(Math.max(Number(discount) || 0, 0), 100);
  let client = 0;
  let tech = 0;
  let missingClient = 0;
  let missingTech = 0;

  for (const c of constructions) {
    const qty = Number(c.qty) || 0;
    if (c.price === null || c.price === undefined) missingClient++;
    else client += c.price * qty;
    if (c.price_tech === null || c.price_tech === undefined) missingTech++;
    else tech += c.price_tech * qty;
  }

  const round = v => Math.round(v * 100) / 100;
  return {
    client: round(client),
    // Итог для врача — с учётом скидки.
    clientTotal: round(client * (100 - d) / 100),
    discount: d,
    tech: round(tech),
    missingClient,
    missingTech,
    // Итог без скидки нужен, чтобы показать, сколько сэкономила клиника.
    saved: round(client * d / 100),
  };
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
  // Врач клиники видит наряды всей своей клиники, а не только свои.
  // Условие добавляется ДО выборки: иначе счётчик показывал бы чужие
  // наряды, а страницы выходили пустыми.
  //
  // Свои наряды остаются видны всегда, даже когда клиника не привязана:
  // иначе врач, заведший наряд до привязки к клинике, потерял бы к нему
  // доступ и не смог бы ничего исправить.
  if (filters.clinicOf) {
    const who = filters.clinicOf;
    if (who.clinicId) {
      where.push('(clinic_id = ? OR created_by = ?)');
      params.push(who.clinicId, who.name);
    } else {
      where.push('created_by = ?');
      params.push(who.name);
    }
  }

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const rows = db.prepare(`
    SELECT o.*,
           (SELECT COUNT(*) FROM order_teeth t WHERE t.order_id = o.id AND t.lab_id = o.lab_id) AS teeth_count,
           (SELECT GROUP_CONCAT(t2.tooth, ' ') FROM order_teeth t2
             WHERE t2.order_id = o.id AND t2.lab_id = o.lab_id ORDER BY t2.tooth) AS teeth_list,
           (SELECT GROUP_CONCAT(DISTINCT kind) FROM order_teeth t WHERE t.order_id = o.id AND t.lab_id = o.lab_id) AS kinds,
             (SELECT cl.name FROM clinics cl WHERE cl.id = o.clinic_id AND cl.lab_id = o.lab_id) AS clinic_name
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
              incoming = ?, delivery = ?, discount = ?, clinic_id = ?, updated_at = ?
            WHERE id = ? AND lab_id = ?
          `).run(
            data.order_number, data.customer, data.phone, data.email,
            data.patient, data.delivery_address, data.stage, data.priority,
            data.comment, data.dentist_note, data.taken_at, data.promised_at,
            (data.incoming || []).join(','), (data.delivery || []).join(','),
            data.discount, data.clinic_id, now, orderId, labId,
          );
      if (res.changes === 0) return { id: null, error: 'Наряд не найден' };
    } else {
      const dup = db.prepare('SELECT id FROM orders WHERE lab_id = ? AND order_number = ?').get(labId, data.order_number);
      if (dup) return { id: null, error: 'Наряд с таким номером уже есть' };

      const info = db.prepare(`
        INSERT INTO orders
            (lab_id, order_number, customer, phone, email, patient, delivery_address,
               stage, priority, comment, dentist_note, taken_at, promised_at, incoming, delivery,
               discount, clinic_id, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            labId, data.order_number, data.customer, data.phone, data.email,
            data.patient, data.delivery_address, data.stage, data.priority,
            data.comment, data.dentist_note, data.taken_at, data.promised_at,
            (data.incoming || []).join(','), (data.delivery || []).join(','),
            data.discount, data.clinic_id, user || null, now, now,
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

    // Конструкции наряда. Для позиции из справочника форма присылает
    // только id, поэтому название и цена копируются из справочника —
    // подменить цену в HTML нельзя. Своя конструкция (вписали руками)
    // сохраняется как есть: id остаётся пустым, а название и цена
    // берутся из наряда, иначе позиция была бы потеряна.
    db.prepare('DELETE FROM order_constructions WHERE order_id = ? AND lab_id = ?').run(orderId, labId);
    if (data.constructions && data.constructions.length) {
      const insCon = db.prepare(`
        INSERT INTO order_constructions
          (order_id, lab_id, construction_id, code, title, price, price_tech, qty, material, note)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `);
        // Ищем позицию по id И по своей лаборатории: подставив в форму
        // чужой construction_id, можно было бы вписать в наряд позицию
        // другой лаборатории вместе с её названием и ценой.
        const selCon = db.prepare(
          'SELECT code, title, price, price_tech FROM constructions WHERE id = ? AND lab_id = ?'
        );
      for (const c of data.constructions) {
        if (c.construction_id) {
            const ref = selCon.get(c.construction_id, labId);
          // Ссылку могли удалить из справочника, пока наряд правили.
          // Если позиция пришла с id, но в справочнике её нет, берём
          // название из формы, иначе потеряли бы строку наряда.
          if (!ref && !c.title) continue;
          insCon.run(orderId, labId, c.construction_id,
            ref ? ref.code : null, ref ? ref.title : c.title,
            ref ? ref.price : c.price, ref ? ref.price_tech : c.price_tech,
            c.qty, c.material || null, c.note || null);
        } else {
          insCon.run(orderId, labId, null, null, c.title, c.price, c.price_tech,
            c.qty, c.material || null, c.note || null);
        }
      }
    }

    // Первый этап пишется только при создании: при редактировании
    // журнал уже есть, и повторная запись «новый» затирала бы историю.
    if (!data.id) {
      addStage(db, labId, orderId, data.stage, 'Наряд создан', user);
    }

    // Чек-лист манипуляций. Заполняется в той же транзакции, что и сам
    // наряд: пустой наряд без списка работ выглядел бы готовым, а
    // технику было бы нечего отмечать. Уже добавленные манипуляции не
    // трогаются, поэтому правка вида работы не стирает отметки.
    // Вид работы может быть не выбран: тогда в наряд попадут общие
    // шаги приёма и сдачи, а специфические добавит администратор
    // из справочника.
    const M = require('./manipulations');
    M.seedDefaults(db, labId);
    M.addCatalogToOrder(db, labId, orderId, [data.work_kind]);

    return { id: orderId };
  });

  return tx();
}

/**
 * Добавляет запись в журнал этапов. Так как «Взято в работу»
 * фиксирует дату начала, она же ставится в orders.taken_at.
 *
 * stageKeys — множество активных этапов лаборатории. Список этапов
 * настраивается администратором, поэтому проверка идёт по нему, а не
 * по константе из dental-reference: иначе добавленный этап отвергался бы.
 */
function addStage(db, labId, orderId, stage, note, user, stageKeys) {
  if (!(stageKeys || STAGE_KEYS).has(stage)) return null;
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
// Сводка по этапам. Врачу показываем только его область видимости —
// иначе счётчик выдал бы чужую клинику: на виде списка три наряда,
// а в шапке «в работе: 12».
//
// clinicOf принимает ту же форму, что и filters.clinicOf у listOrders:
// { name, clinicId }. Одна форма на оба запроса — иначе придётся помнить
// для каждого свой формат, и рано или поздно передадим объект туда,
// где ждут строку.
function stageSummary(db, labId, opts, stageKeys) {
  const who = opts && opts.clinicOf;
  let rows;
  if (who && who.clinicId) {
    rows = db.prepare(`
      SELECT stage, COUNT(*) AS n FROM orders
      WHERE lab_id = ? AND (clinic_id = ? OR created_by = ?)
      GROUP BY stage
    `).all(labId, who.clinicId, who.name);
  } else if (who) {
    // Врач без клиники: только его собственные наряды.
    rows = db.prepare('SELECT stage, COUNT(*) AS n FROM orders WHERE lab_id = ? AND created_by = ? GROUP BY stage')
      .all(labId, who.name);
  } else {
    rows = db.prepare('SELECT stage, COUNT(*) AS n FROM orders WHERE lab_id = ? GROUP BY stage').all(labId);
  }
  const map = Object.fromEntries(rows.map(r => [r.stage, r.n]));
  return Object.fromEntries([...(stageKeys || STAGE_KEYS)].map(k => [k, map[k] || 0]));
}

  /** Удаляет наряд вместе со всеми связанными записями. */
  function deleteOrder(db, labId, id) {
    return db.prepare('DELETE FROM orders WHERE id = ? AND lab_id = ?').run(id, labId).changes > 0;
  }

  // ---- Переписка внутри наряда -----------------------------------------
  //
  // Обсуждение идёт внутри заказа, а не в общем чате: врач пишет про
  // конкретного пациента, техник отвечает про конкретную конструкцию, и
  // через месяц это читается вместе с нарядом, а не в ленте.

  /** Последние сообщения наряда: свежие сверху, для ленты на странице. */
  function listMessages(db, labId, orderId, limit = 200) {
    return db.prepare(`
      SELECT id, author_user_id, author_name, author_role, body, proposal_codes, applied_at, created_at
      FROM order_messages
      WHERE order_id = ? AND lab_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(orderId, labId, limit).reverse();
  }

  /**
   * Новое сообщение.
   *
   * proposal — коды конструкций из справочника, о которых договорились в
   * этом сообщении. Хранятся только те, что реально есть в справочнике
   * лаборатории: иначе под чужой лаборатории можно было бы подсунуть
   * чужой артикул и получить наряд с чужой позицией.
   */
  function addMessage(db, labId, orderId, author, body, proposal = []) {
    const text = str(body).slice(0, 4000);
    if (!text) return { error: 'Пустое сообщение не отправить' };

    const codes = [];
    if (Array.isArray(proposal)) {
      for (const raw of proposal) {
        const code = str(raw.code || raw).slice(0, 24);
        if (code && !codes.includes(code)) codes.push(code);
      }
    }

    // Проверяем принадлежность кода справочнику этой лаборатории.
    const valid = [];
    const q = db.prepare('SELECT code FROM constructions WHERE lab_id = ? AND code = ?');
    for (const code of codes.slice(0, 30)) {
      if (q.get(labId, code)) valid.push(code);
    }

    const info = db.prepare(`
      INSERT INTO order_messages
        (order_id, lab_id, author_user_id, author_name, author_role, body, proposal_codes)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      orderId, labId,
      author && author.id ? Number(author.id) : null,
      str(author && author.name).slice(0, 60) || null,
      str(author && author.role).slice(0, 20) || null,
      text,
      valid.length ? valid.join(',') : null
    );
    return { id: info.lastInsertRowid, proposal: valid };
  }

  /**
   * Собирает наряд из договорённостей.
   *
   * Позиции добавляются, уже существующие не дублируются: врач мог бы
   * нажать кнопку второй раз и получить вдвое больше работы в счёте.
   * Цены берутся из справочника лаборатории, а не из сообщения.
   */
  function applyProposal(db, labId, orderId, messageId) {
    const order = getOrder(db, labId, orderId);
    if (!order) return { error: 'Наряд не найден' };

    const msg = db.prepare(
      'SELECT * FROM order_messages WHERE id = ? AND order_id = ? AND lab_id = ?'
    ).get(messageId, orderId, labId);
    if (!msg) return { error: 'Сообщение не найдено' };
    if (!msg.proposal_codes) return { error: 'В сообщении нет согласованных конструкций' };

    const codes = msg.proposal_codes.split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return { error: 'В сообщении нет согласованных конструкций' };

    const existing = new Set(
      db.prepare('SELECT code FROM order_constructions WHERE order_id = ? AND lab_id = ?')
        .all(orderId, labId).map(r => r.code).filter(Boolean)
    );

    // code и id берём вместе: подставлять в construction_id нужно
    // первичный ключ, иначе связь со справочником окажется мусорной.
    const sel = db.prepare('SELECT id, code, title, price, price_tech FROM constructions WHERE lab_id = ? AND code = ?');
    const ins = db.prepare(`
      INSERT INTO order_constructions
        (order_id, lab_id, construction_id, code, title, price, price_tech, qty, material, note)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    const added = [];
    const run = db.transaction(() => {
      for (const code of codes) {
        if (existing.has(code)) continue;
        const item = sel.get(labId, code);
        if (!item) continue;
        ins.run(orderId, labId, item.id,
          item.code, item.title, item.price, item.price_tech,
          1, null, `из переписки: ${msg.author_name || ''}`.trim());
        existing.add(code);
        added.push(item.title);
      }
      db.prepare('UPDATE order_messages SET applied_at = datetime(\'now\') WHERE id = ?')
        .run(messageId);
    });
    run();

    return { added, messageId };
  }

  module.exports = {
    parseOrderForm, parseTeeth, getOrder, listOrders,
    saveOrder, addStage, stageSummary, deleteOrder, constructionsTotal,
    listMessages, addMessage, applyProposal,
  };
