// Специализации сотрудников.
//
// Роль отвечает на вопрос «что ему можно делать в системе», специализация —
// «что именно он изготавливает». Смешивать их в одной колонке нельзя:
// роль влияет на права (техник не откроет прайс), а специализация только
// подсказывает, кого назначать на работу и кому показывать заказы.
//
// Списки живут здесь, а не в разметке: их одинаково используют мастер
// настройки, админка сотрудников и фильтр нарядов. Прав на «бухгалтер»
// или «склад» у роли admin нет — это не разные степени доступа, а разные
// должности, поэтому отдельной ролью их делать незачем.

/** Специализации по ролям: ключ роли → [ключ, название]. */
const BY_ROLE = {
  admin: [
    ['administrator', 'Администратор'],
    ['director', 'Директор'],
    ['accountant', 'Бухгалтер'],
    ['warehouse', 'Склад'],
  ],
  dentist: [
    ['therapist', 'Стоматолог-терапевт'],
    ['prosthodontist', 'Стоматолог-ортопед'],
    ['surgeon', 'Стоматолог-хирург'],
    ['orthodontist', 'Стоматолог-ортодонт'],
  ],
  tech: [
    ['removable', 'Съёмные протезы'],
    ['metal', 'Металлисты'],
    ['cadcam', 'CAD/CAM'],
    ['gypsum', 'Гипсовщики'],
    ['milling', 'Фрезеровщики'],
    ['ceramist', 'Керамисты'],
  ],
};

/** Названия ролей для интерфейса. */
const ROLE_LABELS = {
  admin: 'Администрация',
  dentist: 'Врач',
  tech: 'Техник',
  other: 'Другое',
};

function forRole(role) {
  return BY_ROLE[role] || [];
}

function isValid(role, key) {
  return forRole(role).some(([k]) => k === key);
}

function label(role, key) {
  const found = forRole(role).find(([k]) => k === key);
  return found ? found[1] : '';
}

/**
 * Ключ специализации из формы.
 *
 * Пустое и неизвестное значение — это null, а не первый в списке: иначе
 * новый сотрудник молча получил бы чужую специализацию и попал в чужие
 * отчёты по зарплате.
 */
function fromForm(role, raw) {
  const key = String(raw == null ? '' : raw).trim();
  return isValid(role, key) ? key : null;
}

/** Специализация сотрудника вместе с названием — для подписей и фильтров. */
function describe(role, key) {
  if (!key) return '';
  return label(role, key) || key;
}

module.exports = { BY_ROLE, ROLE_LABELS, forRole, isValid, label, fromForm, describe };
