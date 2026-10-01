// Схема справочника конструкций.
//
// Заведена отдельно от нарядов: конструкция — это то, что заказывают
// (коронка, мост, элайнер), и она переиспользуется нарядами, в отчётах
// и в переписке с врачом. Раньше конструкций в базе не было вовсе —
// вместо них шёл плоский список work_kind в коде, где «Съёмная»
  // стояла рядом с «Коронка», хотя первое это группа, а второе позиция.
//
  // Группы справочника общие для всех лабораторий: это классификация
  // продукта («Каппы», «Бюгельные протезы»), и она одинакова везде.
  // А вот позиции и цены — данные конкретной лаборатории, поэтому
  // constructions несёт lab_id и наполняется отдельно для каждой.

/**
 * Накатывает схему справочника конструкций.
 * @param {import('better-sqlite3').Database} db
 */
function migrateConstructions(db) {
  db.exec(`
    -- Группы верхнего уровня: строки будущей таблицы-редактора.
    CREATE TABLE IF NOT EXISTS construction_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0
    );

    -- Конструкция — позиция, которую выбирают в наряде.
    -- section: подраздел прайса («Бюгельные протезы», «Каппы»).
    -- Он нужен, чтобы в выпадающем списке позиции шли группами, а не
    -- одной простынёй на двести строк.
      CREATE TABLE IF NOT EXISTS constructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lab_id INTEGER NOT NULL DEFAULT 1,
        group_id INTEGER NOT NULL REFERENCES construction_groups(id),
        section TEXT,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        price REAL,
        term TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_constructions_group
        ON constructions(group_id, active, sort);
      CREATE INDEX IF NOT EXISTS idx_constructions_lab
        ON constructions(lab_id, active);
    `);

  // Роли: одна колонка role осталась для совместимости с текущей
  // проверкой прав, новая specialization хранит узкую специализацию
  // (керамист, фрезеровщик, ортодонт). Плоский список из пятнадцати
  // значений в role нечитаем, а права по нему не считаются.
  const addColSafe = (table, name, def) => {
    // Таблицы users создаются в другой миграции. Проверка на её
    // существование нужна, чтобы порядок применения миграций не был
    // значим: иначе на пустой базе накатывание падает с «no such table».
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    if (!exists) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  };

  // Номер телефона нужен для SMS-уведомлений и для связи с клиникой.
    addColSafe('users', 'phone', 'TEXT');
    addColSafe('users', 'specialization', 'TEXT');
    addColSafe('users', 'clinic_id', 'INTEGER');

    // Две цены вместо одной.
    //
    // price — сколько платит клиника (видит врач).
    // price_tech — сколько работы стоит лаборатории, то есть что
    // получает техник за изготовление (видит техник).
    //
    // Считать одно из другого нельзя: скидка клинике не должна съедать
    // зарплату техника, а себестоимость у разных позиций не в проценте
    // от цены. Старая колонка price остаётся ценой для врача, поэтому
    // переносить данные не нужно.
      addColSafe('constructions', 'price_tech', 'REAL');

      // Справочник и цены принадлежат лаборатории.
      //
      // Раньше справочник был общим: администратор одной лаборатории
      // правил цены, и их тут же видели все остальные. Для прайса это
      // недопустимо — цена и состав услуг у лабораторий свои.
      //
      // Группы остаются общими: это классификация продукта («Каппы»,
      // «Бюгельные протезы»), а не данные клиента. Данные — позиции
      // внутри них, и вот они копируются каждой лаборатории отдельно.
      addColSafe('constructions', 'lab_id', 'INTEGER NOT NULL DEFAULT 1');

      // Код уникален внутри лаборатории, а не глобально: тот же
      // артикул вправе продавать и другая лаборатория, и вторая копия
      // справочника не должна ей мешать.
      db.exec('DROP INDEX IF EXISTS idx_constructions_code');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_constructions_lab_code
          ON constructions(lab_id, code)
      `);
    }
  
module.exports = { migrateConstructions };