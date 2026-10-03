// Одноразовые ссылки на смену пароля.
//
// Ссылка — единственное, что уходит по почте вместо пароля. В базу
// кладём только SHA-256: сам пароль, его хэш при входе и что-либо,
// из чего его можно было бы подобрать, по почте не уходят никогда.

const crypto = require('crypto');

// Сутки — достаточно, чтобы человек заметил письмо и успел; дольше
// ссылка из переписки была бы живым паролем.
const TTL_HOURS = 24;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

/**
 * Создаёт ссылку для пользователя и возвращает её открытым текстом —
 * он уходит только в письмо, в базе остаётся хэш.
 */
function createReset(db, userId, ttlHours = TTL_HOURS) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  db.prepare("DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at <= ?")
    .run(now.toISOString());
  db.prepare(
    'INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(userId, hashToken(token), now.toISOString(), expiresAt.toISOString());

  return { token, expiresAt };
}

/**
 * Ищет действующую ссылку. Использованная и протухшая не подходят —
 * обе возвращают null, и вызывающий код не может их различить.
 */
function findValid(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token));
  if (!row || row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

/**
 * Помечает ссылку использованной и сообщает, удалось ли это.
 *
 * Проверка идёт одним UPDATE с условием used_at IS NULL: две одновременно
 * открытые вкладки не должны обе сработать, поэтому решает именно база,
 * а не предыдущая SELECT. Ссылка, которую кто-то уже использовал,
 * отзовётся второй раз — вернуть false и не дать войти.
 */
function consume(db, row) {
  const info = db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .run(new Date().toISOString(), row.id);
  return info.changes === 1;
}

module.exports = { TTL_HOURS, hashToken, createReset, findValid, consume };
