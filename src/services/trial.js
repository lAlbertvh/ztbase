// Пробный период лаборатории.
//
// Каждая зарегистрированная лаборатория получает неделю бесплатной
// работы. После срока приложение перестаёт работать и показывает экран
// продления — с данными, нарядами и перепиской на месте.
//
// Почему не «меняем пароль»
// --------------------------
// Смена пароля выглядит снаружи как «я что-то забыл», и человек не
// понимает, куда обращаться. Экран продления объясняет причину и ведёт
// к оплате. Правило для бизнеса то же: работа после срока невозможна,
// а данные целы и готовы вернуться после оплаты.
//
// Срок хранится в labs.trial_until. Считается он в UTC, потому что сервер
// может стоять в любой таймзоне, а срок не должен «сдвинуться» вместе с ней.

const TRIAL_DAYS = 7;

/** Срок пробного периода: семь суток с момента регистрации. */
function trialUntil(days = TRIAL_DAYS) {
  const until = new Date(Date.now() + days * 86400000);
  return until.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Пробный период закончился?
 *
 * Платная лаборатория (trial_paid = 1) никогда не блокируется, даже если
 * срок прошёл: человек оплатил, и «срок истёк» не должен отключить его
 * работу на следующей неделе.
 */
function trialExpired(db, labId) {
  const row = db.prepare('SELECT trial_until, trial_paid FROM labs WHERE id = ?').get(labId);
  if (!row) return false;
  if (row.trial_paid) return false;
  // NULL — лаборатория без пробного срока. Блокировать нечего: у таких
  // лабораторий срок не заводился, и заблокировать их наугад опаснее, чем
  // пропустить проверку.
  if (!row.trial_until) return false;
  return Date.parse(row.trial_until) <= Date.now();
}

/** Сколько дней осталось; отрицательное значение — просрочка. */
function trialDaysLeft(db, labId) {
  const row = db.prepare('SELECT trial_until FROM labs WHERE id = ?').get(labId);
  if (!row || !row.trial_until) return null;
  const ms = Date.parse(row.trial_until) - Date.now();
  return Math.ceil(ms / 86400000);
}

// Минимально разумная проверка контакта. Строгая валидация телефона и
// e-mail здесь была бы формой вежливости: настоящая проверка случается при
// попытке связаться, а сейчас нам нужно лишь отсечь пустое поле и мусор.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\d][\d\s()+-]{8,24}$/;

function validateContact(email, phone) {
  const mail = String(email || '').trim();
  const tel = String(phone || '').trim();
  if (!mail) return { ok: false, error: 'Укажите e-mail' };
  if (!EMAIL_RE.test(mail)) return { ok: false, error: 'E-mail выглядит неверно' };
  if (tel && !PHONE_RE.test(tel)) return { ok: false, error: 'Телефон выглядит неверно' };
  return { ok: true, email: mail, phone: tel || null };
}

module.exports = { TRIAL_DAYS, trialUntil, trialExpired, trialDaysLeft, validateContact };
