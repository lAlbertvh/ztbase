// Схема и миграции базы ZT Lab.
//
// Файл вынесен отдельно от server.js: схема разрослась до шести
// связанных таблиц, и держать её в точке входа нечитаемо.
//
// Миграции идемпотентны — CREATE TABLE IF NOT EXISTS плюс addColSafe
// для колонок. Это позволяет накатывать файл на любую базу: и старую
// без нарядов, и новую пустую.

/**
 * Накатывает схему заказ-нарядов.
 * @param {import('better-sqlite3').Database} db
 */
function migrateOrders(db) {
  db.exec(`
    -- Наряд: шапка заказа. Номер уникален в пределах лаборатории,
    -- потому что два заказа одного клиента с одним номером — это
    -- ошибка заполнения, а не совпадение.
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL DEFAULT 1,
      order_number TEXT NOT NULL,
      customer TEXT,
      phone TEXT,
      email TEXT,
      patient TEXT,
      delivery_address TEXT,
      stage TEXT NOT NULL DEFAULT 'new',
      priority INTEGER NOT NULL DEFAULT 0,
      comment TEXT,
      taken_at TEXT,
      promised_at TEXT,
      issued_at TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Зубная формула и виды работ по каждому зубу.
    -- Один зуб может входить в несколько работ (коронка плюс
    -- мост через него), поэтому связь many-to-many, а не колонка.
    CREATE TABLE IF NOT EXISTS order_teeth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      tooth INTEGER NOT NULL,
      kind TEXT NOT NULL,
      material TEXT,
      color TEXT,
      note TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    -- Этап производства с датой и заметкой.
    -- Это и есть журнал: по наряду видно, кто и когда что делал.
    CREATE TABLE IF NOT EXISTS order_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      stage TEXT NOT NULL,
      note TEXT,
      user TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    -- Справочник материалов лаборатории. lab_id обязателен:
    -- набор материалов у разных лабораторий разный.
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT DEFAULT 'шт',
      note TEXT,
      active BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Материалы, выбранные в конкретный наряд.
    -- Ссылка на materials с ON DELETE SET NULL: если материал удаляют
    -- из справочника, он остаётся в истории наряда.
    CREATE TABLE IF NOT EXISTS order_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      material_id INTEGER,
      name TEXT NOT NULL,
      qty REAL DEFAULT 1,
      unit TEXT DEFAULT 'шт',
      note TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_lab_stage ON orders(lab_id, stage);
    CREATE INDEX IF NOT EXISTS idx_orders_lab_created ON orders(lab_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_teeth_order ON order_teeth(order_id);
    CREATE INDEX IF NOT EXISTS idx_stages_order ON order_stages(order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_materials_order ON order_materials(order_id);
    CREATE INDEX IF NOT EXISTS idx_materials_lab ON materials(lab_id, active);
  `);

  // Более поздние версии добавляли колонки к уже созданным таблицам.
  // IF NOT EXISTS этого не покрывает: таблица могла быть создана
  // более ранней версией схемы без нужной колонки.
  const addColSafe = (table, name, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  };

  addColSafe('orders', 'dentist_note', 'TEXT');
  addColSafe('orders', 'archived', 'INTEGER DEFAULT 0');
  // Что поступило с заказом и что требуется изготовить: набором ключей
  // через запятую. Отдельная таблица не нужна — это набор флагов
  // без собственных атрибутов, и по наряду они всегда нужны целиком.
  addColSafe('orders', 'incoming', 'TEXT');
  addColSafe('orders', 'delivery', 'TEXT');
  addColSafe('order_teeth', 'abutment', 'TEXT');
  addColSafe('order_teeth', 'flags', 'TEXT');
  addColSafe('order_stages', 'finished_at', 'TEXT');

  // Номера нарядов уникальны внутри лаборатории, а не глобально:
  // две разные лаборатории вправе использовать один и тот же номер.
  // Частичный уникальный индекс не ломает существующие дубликаты,
  // в отличие от UNIQUE в самой таблице.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_lab_number
    ON orders(lab_id, order_number) WHERE order_number <> ''
  `);
}

module.exports = { migrateOrders };
