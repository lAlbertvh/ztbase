// Хэширование и проверка паролей.
//
// scrypt из стандартной библиотеки Node: не нужно тянуть bcrypt, и он
// устойчив к перебору. Формат хранения: scrypt$<соль>$<хэш>.
//
// Соль случайная на каждый пароль, поэтому два сотрудника с одинаковым
// паролем дают разные строки в базе. Сравнение — timingSafeEqual,
// чтобы по времени ответа нельзя было подбирать хэш побайтно.

const crypto = require('crypto');

const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Строка другого формата (например, пустая или от другой версии)
// возвращает false, а не роняет проверку входа.
module.exports = { hashPassword, verifyPassword };