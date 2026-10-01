// Стартовый набор манипуляций по видам работ.
//
// Цены — ТЕСТОВЫЕ, в диапазоне 150–500 ₽. Они нужны, чтобы отчёт по
// зарплате сразу считал суммы, а не показывал нули. Это не расчётные
// ставки лаборатории: администратор должен заменить их в справочнике
// под свои условия. Новые лаборатории получают эти же числа, пока
// своих ставок нет.
//
// kind = null означает «шаг нужен почти всегда». Такие шаги попадают
// в любой наряд независимо от вида работы.

const GENERIC = [
  { code: 'INTAKE', name: 'Приём и проверка заказа', kind: null, price: 150 },
  { code: 'CAST', name: 'Изготовление рабочей модели', kind: null, price: 250 },
  { code: 'SCAN', name: 'Сканирование модели', kind: null, price: 200 },
  { code: 'PREP', name: 'Подготовка файла к работе', kind: null, price: 200 },
  { code: 'QC', name: 'Контроль качества', kind: null, price: 150 },
  { code: 'PACK', name: 'Упаковка и передача клиенту', kind: null, price: 150 },
];

// Шаги, специфичные для вида работы. Совпадают по kind с WORK_KINDS
// в dental-reference.js.
const BY_KIND = {
  crown: [
    { code: 'FRAME_PREP', name: 'Моделирование каркаса коронки', price: 350 },
    { code: 'FRAME_MILL', name: 'Фрезерование каркаса', price: 400 },
    { code: 'FRAME_FIT', name: 'Примерка каркаса в рот', price: 250 },
    { code: 'FRAME_BAKE', name: 'Обжиг каркаса', price: 300 },
    { code: 'PORCELAIN', name: 'Наложение и обжиг керамики', price: 500 },
  ],
  bridge: [
    { code: 'BRIDGE_DESIGN', name: 'Моделирование мостовидного протеза', price: 450 },
    { code: 'BRIDGE_MILL', name: 'Фрезерование каркаса', price: 450 },
    { code: 'BRIDGE_FIT', name: 'Примерка каркаса в рот', price: 250 },
    { code: 'BRIDGE_BAKE', name: 'Обжиг каркаса', price: 300 },
    { code: 'BRIDGE_PORCELAIN', name: 'Наложение и обжиг керамики', price: 500 },
  ],
  removable: [
    { code: 'REM_TRACING', name: 'Получение слепка/скана', price: 200 },
    { code: 'REM_WAX', name: 'Моделирование воском', price: 350 },
    { code: 'REM_POUR', name: 'Заливка и разливка', price: 300 },
    { code: 'REM_FIT', name: 'Примерка и коррекция', price: 250 },
  ],
  fixed: [
    { code: 'FIX_DESIGN', name: 'Моделирование конструкции', price: 350 },
    { code: 'FIX_MILL', name: 'Фрезерование', price: 400 },
    { code: 'FIX_FIT', name: 'Примерка в рот', price: 250 },
  ],
  implant: [
    { code: 'IMPL_SCANBITE', name: 'Сканирование абатмента', price: 200 },
    { code: 'IMPL_DESIGN', name: 'Проектирование конструкции', price: 450 },
    { code: 'IMPL_MILL', name: 'Фрезерование', price: 450 },
    { code: 'IMPL_FIT', name: 'Установка и примерка', price: 300 },
  ],
  abutment: [
    { code: 'ABUT_SCAN', name: 'Сканирование', price: 200 },
    { code: 'ABUT_MILL', name: 'Фрезерование абатмента', price: 400 },
    { code: 'ABUT_FIT', name: 'Примерка', price: 250 },
  ],
  model_gypsum: [
    { code: 'GYPSUM_POUR', name: 'Разливка гипсом', price: 250 },
    { code: 'GYPSUM_TRIM', name: 'Обработка и шлифовка модели', price: 250 },
  ],
  model_print: [
    { code: 'PRINT_PREP', name: 'Подготовка модели к печати', price: 200 },
    { code: 'PRINT_RUN', name: '3D-печать', price: 400 },
    { code: 'PRINT_POST', name: 'Постобработка модели', price: 250 },
  ],
  screw: [
    { code: 'SCREW_MILL', name: 'Фрезерование винта', price: 350 },
    { code: 'SCREW_FIT', name: 'Примерка винта', price: 250 },
  ],
  titan_base: [
    { code: 'TITAN_SCAN', name: 'Сканирование', price: 200 },
    { code: 'TITAN_MILL', name: 'Фрезерование титанового основания', price: 450 },
    { code: 'TITAN_FIT', name: 'Примерка', price: 250 },
  ],
  other: [
    { code: 'OTHER_WORK', name: 'Выполнение работы', price: 300 },
  ],
};

/**
 * Полный список манипуляций для набора видов работ наряда.
 * Дубликаты по code схлопываются: если шаг подходит и общий, и
 * специфичный, в чек-листе он должен быть один раз.
 */
function defaultsForKinds(kinds) {
  const out = [];
  const seen = new Set();
  const add = (m, kind) => {
    if (seen.has(m.code)) return;
    seen.add(m.code);
    out.push({ code: m.code, name: m.name, work_kind: kind, price: m.price });
  };

  for (const m of GENERIC) add(m, null);
  for (const k of kinds || []) {
    for (const m of BY_KIND[k] || []) add(m, k);
  }
  return out;
}

module.exports = { GENERIC, BY_KIND, defaultsForKinds };
