// Переписка: непрочитанные и общий список диалогов.
//
// Раньше сообщения жили только внутри наряда и не показывали, прочитаны
// ли они. Человек не мог понять, где ждут ответа, и открывал наряды по
// очереди. Здесь две вещи: отметка «до какого момента пользователь
// читал наряд» и список диалогов по всем нарядам лаборатории.
//
// Отметка хранится на пользователя, а не на сообщении: у наряда
// несколько читателей, и у каждого своё. Сообщение считается
// непрочитанным, если оно создано позже отметки и написано не тем же
// пользователем.

const str = (v) => (v == null ? '' : String(v)).trim();

/** Отметка «я прочитал переписку по этому наряду до сих пор». */
function markSeen(db, labId, orderId, userId) {
  if (!userId) return;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    INSERT INTO order_seen (order_id, user_id, last_seen_at) VALUES (?,?,?)
    ON CONFLICT(order_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(orderId, userId, now);
}

/** Граница непрочитанного для пользователя в наряде. */
function seenAt(db, orderId, userId) {
  if (!userId) return '';
  const row = db.prepare('SELECT last_seen_at FROM order_seen WHERE order_id = ? AND user_id = ?')
    .get(orderId, userId);
  return row && row.last_seen_at ? row.last_seen_at : '';
}

/** Сколько непрочитанных сообщений в наряде и где начинается лента. */
function unreadIn(db, orderId, userId) {
  const after = seenAt(db, orderId, userId);
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM order_messages
    WHERE order_id = ?
      AND (author_user_id IS NULL OR author_user_id <> ?)
      AND created_at > ?
  `).get(orderId, userId || -1, after);
  return row ? row.n : 0;
}

// Ограничение видимости нарядов собирается здесь, а не в маршрутах:
// во всех трёх запросах ниже WHERE с этими плейсхолдерами стоит в самом
// конце, поэтому условие и его параметры всегда идут последними.
function scopeClause(scope) {
  if (!scope) return { where: '', params: [] };
  if (scope.clinicId) {
    return {
      where: 'AND (o.clinic_id = ? OR o.created_by = ?)',
      params: [scope.clinicId, scope.name],
    };
  }
  return { where: 'AND o.created_by = ?', params: [scope.name] };
}

/** Общее число непрочитанных по нарядам, которые человек имеет право видеть. */
function unreadTotal(db, labId, userId, scope) {
  // scope повторяет правило maySee из маршрутов: клиника для врача,
  // иначе он увидел бы в инбоксе чужую переписку.
  const s = scopeClause(scope);
  const uid = userId || -1;

  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM order_messages m
    JOIN orders o ON o.id = m.order_id AND o.lab_id = m.lab_id
    WHERE m.lab_id = ?
      AND (m.author_user_id IS NULL OR m.author_user_id <> ?)
      AND m.created_at > COALESCE((
        SELECT last_seen_at FROM order_seen
        WHERE order_id = m.order_id AND user_id = ?
      ), '')
      ${s.where}
  `).get(labId, uid, uid, ...s.params);
  return row ? row.n : 0;
}

/**
 * Список диалогов: последнее сообщение по каждому наряду, где есть
 * переписка. Сортировка по времени последнего сообщения, а не по дате
 * наряда: активная переписка всегда должна быть сверху.
 */
function threads(db, labId, userId, scope, limit = 100) {
  // Плейсхолдеры идут сначала в подзапросах SELECT, потом lab_id,
  // потом ограничение видимости и в конце LIMIT — порядок параметров
  // обязан повторять этот текст, иначе значения уезжают не туда.
  const s = scopeClause(scope);
  const uid = userId || -1;

  return db.prepare(`
    SELECT o.id, o.order_number, o.stage, o.customer, o.patient,
           -- Наряд хранит только clinic_id, поэтому имя клиники берём
           -- подзапросом с проверкой lab_id: иначе клиники соседних
           -- лабораторий с одинаковым id смешались бы.
           (SELECT cl.name FROM clinics cl
             WHERE cl.id = o.clinic_id AND cl.lab_id = o.lab_id) AS clinic_name,
           o.archived,
           last.body     AS last_body,
           last.author_name AS last_author,
           last.author_user_id AS last_author_id,
           last.created_at   AS last_at,
           (SELECT COUNT(*) FROM order_messages m2 WHERE m2.order_id = o.id) AS total,
           (SELECT COUNT(*) FROM order_messages m3
             WHERE m3.order_id = o.id
               AND (m3.author_user_id IS NULL OR m3.author_user_id <> ?)
               AND m3.created_at > COALESCE((
                 SELECT last_seen_at FROM order_seen
                 WHERE order_id = o.id AND user_id = ?
               ), '')) AS unread
    FROM orders o
    JOIN order_messages last ON last.id = (
      SELECT id FROM order_messages WHERE order_id = o.id ORDER BY id DESC LIMIT 1
    )
    WHERE o.lab_id = ? AND EXISTS (
      SELECT 1 FROM order_messages m WHERE m.order_id = o.id
    ) ${s.where}
    ORDER BY last.created_at DESC, o.id DESC
    LIMIT ?
  `).all(uid, uid, labId, ...s.params, limit);
}

/** Непрочитанные сообщения со всех нарядов — то, что человек видит в инбоксе. */
function recentUnread(db, labId, userId, scope, limit = 50) {
  const s = scopeClause(scope);
  const uid = userId || -1;

  return db.prepare(`
    SELECT m.id, m.order_id, m.author_name, m.author_user_id, m.body, m.created_at,
           o.order_number, o.customer,
           (SELECT cl.name FROM clinics cl
             WHERE cl.id = o.clinic_id AND cl.lab_id = o.lab_id) AS clinic_name
    FROM order_messages m
    JOIN orders o ON o.id = m.order_id AND o.lab_id = m.lab_id
    WHERE m.lab_id = ?
      AND (m.author_user_id IS NULL OR m.author_user_id <> ?)
      AND m.created_at > COALESCE((
        SELECT last_seen_at FROM order_seen
        WHERE order_id = m.order_id AND user_id = ?
      ), '') ${s.where}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(labId, uid, uid, ...s.params, limit);
}

/**
 * Пометить прочитанным все наряды, которые человек видит.
 *
 * Ограничение видимости здесь обязательно: врач, нажавший
 * «прочитать всё», не должен помечать переписку чужих клиник. Иначе
 * в истории наряда появилась бы отметка, будто он читал наряд, к
 * которому даже не имеет доступа.
 */
function seenAll(db, labId, userId, now, scope) {
  if (!userId || !now) return;
  const s = scopeClause(scope);
  db.prepare(`
    INSERT INTO order_seen (order_id, user_id, last_seen_at)
    SELECT o.id, ?, ?
    FROM orders o
    WHERE o.lab_id = ? ${s.where}
    ON CONFLICT(order_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(userId, now, labId, ...s.params);
}

module.exports = {
  markSeen, seenAt, unreadIn, unreadTotal, threads, recentUnread, seenAll,
  str,
};
