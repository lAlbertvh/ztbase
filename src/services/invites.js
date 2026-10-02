// Одноразовые коды для входа нового сотрудника в лабораторию.
//
// Задача: администратор должен добавить человека в лабораторию, не
// зная его пароля и не обмениваясь паролем в чате. Для этого он
// выдаёт код, сотрудник приходит на /join, вводит имя, код и свой
// пароль.
//
// Почему одноразовый и со сроком жизни: код — это пароль, только
// короткий. Если он бессрочный и многоразовый, его можно перехватить
// и войти позже. Поэтому код живёт неделю и гасится первым же
// использованием.
//
// Код проверяется по хэшу, а не в открытом виде: иначе любой, кто
// получит доступ к файлу базы, смог бы войти в лабораторию. Сравнение
// идёт по всем активным кодам лаборатории, но самих лабораторий
// перебор не затрагивает — код выбирается администратором и
// проверяется только внутри своей лаборатории.

const crypto = require('crypto');

// Алфавит без похожих символов: 0/O и 1/l/I в коде, который
// диктуют по телефону, путают чаще всего.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_DAYS = 7;
const MAX_ATTEMPTS = 10;

const hash = (code) => crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');

function generate(len = 8) {
  // crypto.randomInt без модуля: Math.random() для кода входа
  // недостаточно предсказуем.
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const expiresAt = (days = CODE_TTL_DAYS) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

/** Нормализация того, что ввёл человек: пробелы и регистр не важны. */
function normalize(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

/**
 * Выдать код.
 *
 * @returns {{code: string, expires_at: string} | {error: string}}
 */
function create(db, labId, opts = {}) {
  const role = opts.role === 'admin' ? 'admin' : 'tech';
  const note = String(opts.note || '').trim().slice(0, 200);
  const ttl = Number(opts.days) > 0 ? Math.min(Number(opts.days), 30) : CODE_TTL_DAYS;

  // Пять попыток сгенерировать уникальный код: при длине 8 из 32
  // символов столкновение практически невозможно, но проверить всё же
  // дешевле, чем разбираться с ошибкой уникальности.
  for (let i = 0; i < 5; i++) {
    const code = generate();
    try {
      db.prepare(`
        INSERT INTO invite_codes (lab_id, role, specialization, note, code_hash, created_by, expires_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(labId, role, opts.specialization || null, note || null, hash(code),
             opts.createdBy || null, expiresAt(ttl));
      return { code, expires_at: expiresAt(ttl) };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) return { error: 'Не удалось создать код' };
    }
  }
  return { error: 'Не удалось создать код, попробуйте ещё раз' };
}

/** Коды лаборатории: живые и уже использованные. */
function list(db, labId) {
  return db.prepare(`
    SELECT id, role, specialization, note, expires_at, used_at, used_name, created_at
    FROM invite_codes WHERE lab_id = ? ORDER BY used_at IS NOT NULL, created_at DESC
  `).all(labId);
}

/**
 * Код по строке, без указания лаборатории.
 *
 * Нужен для /join: человек приходит по ссылке и лабораторию не знает —
 * выбирать её в форме нельзя, иначе можно было бы вписать чужую.
 *
 * Искать можно, потому что перебор бессмыслен: код длиной 8 знаков из
 * 32-символьного алфавита даёт около 10^12 комбинаций, а хранится
 * только хэш. Проверка идёт по хэшу, поэтому совпадение находится
 * индексом, а не перебором строк.
 *
 * @returns {{ok: true, code: object} | {ok: false, error: string}}
 */
function resolveAny(db, raw) {
  const norm = normalize(raw);
  if (norm.length < 6) return { ok: false, error: 'Код введён не полностью' };

  const row = db.prepare(`
    SELECT * FROM invite_codes
    WHERE code_hash = ? AND used_at IS NULL
  `).get(hash(norm));

  if (!row) return { ok: false, error: 'Код не найден или уже использован' };
  if (row.expires_at && row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    return { ok: false, error: 'Срок действия кода истёк. Попросите администратора выдать новый.' };
  }
  return { ok: true, code: row };
}

/**
 * Код по строке внутри известной лаборатории.
 *
 * @returns {{ok: true, code: object} | {ok: false, error: string}}
 */
function resolve(db, labId, raw) {
  const norm = normalize(raw);
  if (norm.length < 6) return { ok: false, error: 'Код введён не полностью' };

  // Ищем по хэшу: в базе лежит только он, открытых кодов нет.
  const row = db.prepare(`
    SELECT * FROM invite_codes
    WHERE lab_id = ? AND code_hash = ? AND used_at IS NULL
  `).get(labId, hash(norm));

  if (!row) return { ok: false, error: 'Код не найден или уже использован' };
  if (row.expires_at && row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    return { ok: false, error: 'Срок действия кода истёк. Попросите администратора выдать новый.' };
  }
  return { ok: true, code: row };
}

/** Погасить код, создав сотрудника. Обе операции — в одной транзакции. */
function redeem(db, labId, raw, user) {
  const found = resolve(db, labId, raw);
  if (!found.ok) return found;

  const code = found.code;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE name = ? AND lab_id = ?')
      .get(user.name, labId);
    if (existing) {
      return { error: 'Пользователь с таким именем уже есть в лаборатории' };
    }
    const info = db.prepare(`
      INSERT INTO users (name, password_hash, role, specialization, active, lab_id)
      VALUES (?,?,?,?,1,?)
    `).run(user.name, user.passwordHash, code.role, code.specialization, labId);

    db.prepare(`
      UPDATE invite_codes SET used_at = ?, used_by = ?, used_name = ? WHERE id = ?
    `).run(now, info.lastInsertRowid, user.name, code.id);

    return { userId: info.lastInsertRowid, role: code.role };
  });
  return run();
}

module.exports = { create, list, resolve, resolveAny, redeem, normalize, generate, CODE_TTL_DAYS, MAX_ATTEMPTS };
