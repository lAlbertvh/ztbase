// Миграции для манипуляций — то, что техник реально делает с нарядом.
//
// Задача: у каждого наряда должен быть готовый список манипуляций, техник
// отмечает выполненные с телефона по QR-коду, а администратор видит
// отдельный журнал по каждому технику, чтобы зарплата считалась прозрачно.
//
// Справочник отделён от наряда намеренно: цены и названия меняются во
// времени, но в уже сделанном наряде они должны остаться теми, что были
// на момент выполнения. Поэтому в order_manipulations название и цена
// копируются из справочника, а не читаются из него ссылкой.

/**
 * Идемпотентная миграция: CREATE TABLE IF NOT EXISTS плюс addColSafe.
 * Безопасна для запуска при каждом старте — ничего не пересоздаёт.
 */
function migrateManipulations(db) {
  db.exec(`
    -- Справочник манипуляций лаборатории.
    -- work_kind = NULL означает «подходит для любого вида работы».
    -- code — короткий код для бланка и разговора, не путается при печати.
    CREATE TABLE IF NOT EXISTS manipulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL DEFAULT 1,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      work_kind TEXT,
      price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (lab_id, code)
    );

    -- Манипуляции конкретного наряда. Это рабочий чек-лист: снимок
    -- справочника на момент создания наряда плюс отметки выполнения.
    CREATE TABLE IF NOT EXISTS order_manipulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      manipulation_id INTEGER,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      done_by TEXT,
      note TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    -- Неизменяемый журнал для расчёта зарплаты.
    --
    -- Отдельная таблица, а не чтение order_manipulations, потому что:
    --   1) нужна история «отметил и снял отметку», а не текущее состояние;
    --   2) наряд могут удалить — расчёт зарплаты не должен от него зависеть;
    --   3) журнал нельзя случайно испортить правкой наряда.
    -- action: 'done' — выполнено, 'undone' — отметку сняли.
    CREATE TABLE IF NOT EXISTS manipulation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      order_number TEXT,
      work_kind TEXT,
      code TEXT,
      name TEXT,
      price REAL NOT NULL DEFAULT 0,
      user TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_manipulations_lab
      ON manipulations(lab_id, active, sort);
    CREATE INDEX IF NOT EXISTS idx_order_manipulations_order
      ON order_manipulations(order_id, done);
    CREATE INDEX IF NOT EXISTS idx_manipulation_log_lab_user
      ON manipulation_log(lab_id, user, created_at);
    CREATE INDEX IF NOT EXISTS idx_manipulation_log_order
      ON manipulation_log(order_id);
  `);

  // Поздние версии могли добавлять колонки к уже созданной таблице.
  const addColSafe = (table, name, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  };

  addColSafe('order_manipulations', 'note', 'TEXT');
  addColSafe('manipulations', 'note', 'TEXT');
  // Автор отметки, которую сняли. Без этого вычитать снятую работу
  // пришлось бы у того, кто её снял, а не у того, кто её выполнил:
  // администратор, исправляя ошибку техника, уменьшал бы свой же заработок.
  addColSafe('manipulation_log', 'target_user', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_manipulation_log_lab_target
      ON manipulation_log(lab_id, target_user, created_at);
  `);
}

module.exports = { migrateManipulations };
