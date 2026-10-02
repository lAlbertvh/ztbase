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

// Минимально разумная проверка e-mail. Строгая валидация здесь была бы
// формой вежливости: настоящая проверка случается при попытке связаться,
// а сейчас нам нужно лишь отсечь пустое поле и мусор.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Телефон по формату не проверяем и регистрацию из-за него не роняем.
// Поле необязательное, а номер берут откуда угодно: из мессенджера с
// длинным тире, с «тел.», с «доб.» или сразу два номера через запятую.
// Раньше такой набор символов не проходил регулярное выражение, и вся
// регистрация отваливалась с сообщением, на которое нельзя было
// повлиять, хотя e-mail для продления пробного периода уже есть и его
// достаточно. Необязательное поле не должно быть барьером.
//
// Поэтому собираем цифры, всё остальное отбрасываем. Номер в E.164 —
// не длиннее 15 цифр; если цифр больше, значит в поле вставили сразу
// два номера или текст, и молча склеивать их в один нельзя: такой
// «телефон» потом не набрать. Тогда берём первый настоящий номер.
// Цифр меньше пяти — телефона фактически не было: он не сохраняется,
// и об этом честно сообщаем в warning, а не теряем молча.
const PHONE_MIN_DIGITS = 5;
const PHONE_MAX_DIGITS = 15;

// Разделители, которыми люди отделяют второй номер или слово.
const PHONE_SPLIT_RE = /[,;/|]| или | и |\s{2,}/i;

// «доб. 5», «ext 12», «#3» — добавочный номер цифрами к основному не
// относится, и вместе с ним основной перестаёт быть номером. Отрезаем
// хвост до разбора, иначе «+7 900 000-00-00 доб. 5» не прошёл бы.
const PHONE_EXT_RE = /\s*(?:(?:доб|ext|д)\.?|#)\s*\d*\s*$/i;

function normalizePhone(raw) {
  const source = String(raw || '').trim();
  if (!source) return { phone: null, warning: '' };

  const withoutExt = source.replace(PHONE_EXT_RE, '').trim() || source;
  const digits = withoutExt.replace(/\D/g, '');
  if (digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS) {
    return { phone: (withoutExt.startsWith('+') ? '+' : '') + digits, warning: '' };
  }

  // Слишком много цифр: пробуем взять первый номер из кусков, на которые
  // поле естественно распадается.
  if (digits.length > PHONE_MAX_DIGITS) {
    for (const part of withoutExt.split(PHONE_SPLIT_RE)) {
      const partDigits = part.replace(/\D/g, '');
      if (partDigits.length >= PHONE_MIN_DIGITS && partDigits.length <= PHONE_MAX_DIGITS) {
        return { phone: (part.trim().startsWith('+') ? '+' : '') + partDigits, warning: '' };
      }
    }
  }

  return {
    phone: null,
    warning: 'Телефон не распознан, сохранили только e-mail. Номер можно указать цифрами, вместе с кодом страны.',
  };
}

function validateContact(email, phone) {
  const mail = String(email || '').trim();
  if (!mail) return { ok: false, error: 'Укажите e-mail' };
  if (!EMAIL_RE.test(mail)) return { ok: false, error: 'E-mail выглядит неверно' };

  const normalized = normalizePhone(phone);
  return { ok: true, email: mail, phone: normalized.phone, warning: normalized.warning };
}

module.exports = { TRIAL_DAYS, trialUntil, trialExpired, trialDaysLeft, validateContact };
