// Тарифы и счётчик занятых мест.
//
// Тариф ограничивает число людей, работающих в приложении. Считаются
// все: и сотрудники лаборатории, и представители клиник — они вместе
// пользуются одними и теми же нарядами, поэтому делить лимит «на
// своих и чужих» было бы обходом через регистрацию клиники.
//
// Ограничение мягкое: перелимит не блокируется, а показывается
// предупреждением. Жёсткий стоп означал бы, что человек не сможет
// работать из-за того, что счётчик не совпал, и потеряет заказ.

// Основной тариф — до 5 человек, премиум — до 15.
const PLANS = {
  basic:   { key: 'basic',   title: 'Основной', max: 5 },
  premium: { key: 'premium', title: 'Премиум',  max: 15 },
};

function planFor(db, labId) {
  const row = db.prepare('SELECT license_plan FROM labs WHERE id = ?').get(labId);
  const key = row && row.license_plan && PLANS[row.license_plan]
    ? row.license_plan
    : 'basic';
  return PLANS[key];
}

/**
 * Сколько мест занято и сколько осталось.
 *
 * Сотрудники берутся из users, представители клиник — из clinic_contacts.
 * Контакт, которому позже выдали учётную запись, считается дважды, если
 * у него заполнен user_id, поэтому такие строки пропускаем: человек один.
 */
function usage(db, labId) {
  const staff = db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE lab_id = ? AND active = 1'
  ).get(labId).n;

  const contacts = db.prepare(`
    SELECT COUNT(*) AS n FROM clinic_contacts
    WHERE lab_id = ? AND active = 1 AND user_id IS NULL
  `).get(labId).n;

  const plan = planFor(db, labId);
  const used = staff + contacts;

  return {
    plan,
    staff,
    contacts,
    used,
    max: plan.max,
    free: Math.max(plan.max - used, 0),
    over: Math.max(used - plan.max, 0),
  };
}

function setPlan(db, labId, key) {
  if (!PLANS[key]) return false;
  db.prepare('UPDATE labs SET license_plan = ? WHERE id = ?').run(key, labId);
  return true;
}

/**
 * Предупреждение для показа под формой добавления сотрудника.
 * Возвращает null, пока место есть, — чтобы не пугать на ровном месте.
 */
function warningFor(usage, adding = 1) {
  if (usage.over > 0) {
    return `Мест в тарифе «${usage.plan.title}» уже больше, чем ${usage.max}: `
      + `сейчас ${usage.used}. Работать можно, но стоит перейти на премиум.`;
  }
  if (usage.used + adding > usage.max) {
    return `В тарифе «${usage.plan.title}» ${usage.max} мест, `
      + `занято ${usage.used}. Добавление выйдет за лимит — `
      + `для большего числа людей нужен премиум.`;
  }
  return null;
}

module.exports = { PLANS, planFor, usage, setPlan, warningFor };