// Подключение к SQLite, начальная схема и миграции.
//
// Отдельный модуль, потому что точка входа не должна занимать
// описанием таблиц: здесь их создание, добавление недостающих колонок
// и перенос данных из старой версии. Маршрутам нужен только готовый
// объект db.
//
// Все миграции идемпотентны: их вызов безопасен при каждом старте.
// Поэтому в приложении нет номера версии схемы и таблицы «применённые
// миграции» — состояние базы проверяется по факту наличия таблиц и
// колонок.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { migrateOrders } = require('./orders-schema');
const { migrateManipulations } = require('./manipulations-schema');
const { migrateConstructions } = require('./constructions-schema');
const { migrateSetup, setupPending } = require('./setup-schema');
const { migrateMail } = require('./mail-schema');

// Подключение к базе. WAL выбран сознательно: он не блокирует читателей
// при записи, а чтения страницы нарядов идут постоянно и не должны
// ждать загрузки файла.
function connect(dbDir) {
  const db = new Database(path.join(dbDir, 'exo.db'));
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      image_name TEXT,
      uploader TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      downloaded BOOLEAN DEFAULT 0,
      downloaded_by TEXT,
      downloaded_date TEXT,
      milled BOOLEAN DEFAULT 0,
      baked BOOLEAN DEFAULT 0,
      comment TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS titan_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_date TEXT NOT NULL,
      order_number TEXT NOT NULL,
      system_name TEXT NOT NULL,
      size REAL NOT NULL,
      has_hex BOOLEAN DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Разделение по лабораториям. lab_id есть в каждой таблице с данными,
  // поэтому заказ одной лаборатории физически не виден другой.
  // Значение по умолчанию 1 — чтобы старые данные остались рабочими.
  const addColSafe = (table, name, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      console.log(`Колонка ${table}.${name} добавлена`);
    }
  };
  addColSafe('files', 'lab_id', 'INTEGER DEFAULT 1');
  addColSafe('titan_orders', 'lab_id', 'INTEGER DEFAULT 1');
  addColSafe('users', 'lab_id', 'INTEGER DEFAULT 1');

  const fileCols = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
  const addCol = (name, def) => {
    if (!fileCols.includes(name)) {
      db.exec(`ALTER TABLE files ADD COLUMN ${name} ${def}`);
      console.log(`Колонка ${name} добавлена в таблицу files`);
    }
  };
  addCol('image_name', 'TEXT');
  addCol('milled', 'BOOLEAN DEFAULT 0');
  addCol('baked', 'BOOLEAN DEFAULT 0');
  addCol('comment', 'TEXT');

  // Пользователей больше не создаём автоматически: имена сотрудников
  // конкретной лаборатории не должны попадать в открытый репозиторий.
  // Первая учётная запись создаётся при регистрации лаборатории.

  // Пароль хранится только хэшем. Раньше пароля не было вовсе — на странице
  // входа был выбор имени из списка, и это неприемлемо для внешних лабораторий.
  addColSafe('users', 'password_hash', 'TEXT');
  addColSafe('users', 'role', "TEXT DEFAULT 'tech'");
  addColSafe('users', 'active', 'BOOLEAN DEFAULT 1');
  // Колонки объявляются до пересборки таблицы ниже: пересоздание копирует
  // только перечисленные колонки, и всё, чего в списке нет, теряется.
  // Специализацию и клинику объявляют и другие миграции — на чистой базе
  // они идут позже, но к этому моменту колонки уже должны существовать.
  addColSafe('users', 'specialization', 'TEXT');
  addColSafe('users', 'clinic_id', 'INTEGER');

  // Имя сотрудника уникально только внутри своей лаборатории.
  // Раньше name был UNIQUE на уровне всей таблицы, из-за чего вторая
  // лаборатория не могла завести сотрудника с тем же именем.
  // SQLite не умеет снимать UNIQUE с колонки, поэтому таблица пересоздаётся.
  const userIdx = db.prepare("PRAGMA index_list(users)").all();
  const hasLabNameUnique = userIdx.some(
    i => i.unique === 1 && /users.*lab_id.*name|users.*name.*lab_id/i.test(
      (db.prepare(`PRAGMA index_info('${i.name}')`).all().map(c => c.name).join(','))
    )
  );
  if (!hasLabNameUnique) {
    const dupe = db.prepare(`
      SELECT lab_id, name FROM users GROUP BY lab_id, name HAVING COUNT(*) > 1
    `).all();
    for (const d of dupe) {
      db.prepare('DELETE FROM users WHERE lab_id = ? AND name = ?').run(d.lab_id, d.name);
      console.log(`Удалён дубликат пользователя: ${d.name} (lab_id=${d.lab_id})`);
    }
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        lab_id INTEGER DEFAULT 1,
        password_hash TEXT,
        role TEXT DEFAULT 'tech',
        active BOOLEAN DEFAULT 1,
        specialization TEXT,
        clinic_id INTEGER,
        UNIQUE (lab_id, name)
      );
      INSERT INTO users_new (id, name, lab_id, password_hash, role, active, specialization, clinic_id)
        SELECT id, name, lab_id, password_hash, role, active, specialization, clinic_id FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('users: уникальность имени ограничена лабораторией (lab_id, name)');
  }

  // Схема заказ-наряда вынесена в отдельный модуль: она состоит из
  // пяти связанных таблиц и не должна занимать точку входа.
  migrateOrders(db);
  console.log('Схема заказ-нарядов готова');

  // Манипуляции: справочник, чек-лист наряда и журнал для зарплаты.
  // Вызывается после migrateOrders, потому что order_manipulations
  // ссылается внешним ключом на таблицу orders.
  migrateManipulations(db);
  console.log('Схема манипуляций готова');

  // Справочник конструкций: группы и позиции для выбора в наряде.
  // Идемпотентен и не зависит от порядка: недостающие таблицы
  // пропускает, а заполняется только при пустом справочнике.
  migrateConstructions(db);
  console.log('Схема конструкций готова');

  // Первичная настройка: мастер, клиники-партнёры и их представители.
  // Идемпотентна, добавляет недостающие колонки в labs.
  migrateSetup(db);
  console.log('Схема настройки готова');

  // Одноразовые ссылки для входа и восстановления пароля.
  migrateMail(db);
  console.log('Схема писем готова');

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    console.log('Пользователей нет — создайте лабораторию через /register');
  }

  // Первая лаборатория создаётся автоматически, чтобы приложение
  // сразу запускалось и не требовало ручной настройки.
  const labCount = db.prepare('SELECT COUNT(*) AS n FROM labs').get().n;
  if (labCount === 0) {
    db.prepare('INSERT INTO labs (slug, name) VALUES (?, ?)').run('lab1', 'Лаборатория 1');
    console.log('Создана лаборатория по умолчанию: lab1');
  }

  console.log('База данных SQLite проверена/создана');
}

// Перенос из старой версии, где всё лежало в files.db рядом с exo.db.
// Файл после переноса переименовывается, чтобы повторный старт не
// пытался перенести данные второй раз.
function migrateLegacyData(db, dbDir, hashPassword) {
  const legacyPath = path.join(dbDir, 'files.db');
  if (!fs.existsSync(legacyPath)) return;

  console.log('Найден старый файл files.db, переношу данные...');
  try {
    const legacy = new Database(legacyPath, { readonly: true });
    const legacyFiles = legacy.prepare('SELECT * FROM files').all();
    const legacyUsers = legacy.prepare('SELECT * FROM users').all();

    const insertFile = db.prepare(`INSERT OR IGNORE INTO files
      (id, original_name, stored_name, image_name, uploader, upload_date, downloaded, downloaded_by, downloaded_date, milled, baked, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of legacyFiles) {
      insertFile.run(
        f.id, f.original_name, f.stored_name, f.image_name || null,
        f.uploader, f.upload_date, f.downloaded ? 1 : 0, f.downloaded_by || null,
        f.downloaded_date || null, f.milled ? 1 : 0, f.baked ? 1 : 0, f.comment || null
      );
    }

    // Старые пользователи переносятся без паролей (в старой версии их не
    // было вовсе). Им выдаётся временный пароль из переменной окружения,
    // который нужно сменить при первом входе. Если переменная не задана,
    // переносим только имя и роль — учётку придётся создать заново.
    const tempPass = process.env.MIGRATION_TEMP_PASSWORD;
    if (tempPass) {
      const insertUser = db.prepare(
        'INSERT OR IGNORE INTO users (name, password_hash, role, active, lab_id) VALUES (?, ?, ?, 1, 1)'
      );
      const h = hashPassword(tempPass);
      for (const u of legacyUsers) {
        insertUser.run(u.name, h, 'tech');
      }
      console.log('Временный пароль для перенесённых пользователей: из MIGRATION_TEMP_PASSWORD');
    } else {
      console.log('MIGRATION_TEMP_PASSWORD не задан — пользователи перенесены без паролей, создайте их заново через /add-user');
    }

    legacy.close();
    console.log(`Миграция завершена: файлов — ${legacyFiles.length}, пользователей — ${legacyUsers.length}`);
    fs.renameSync(legacyPath, legacyPath + '.migrated');
    console.log('Старый файл переименован в files.db.migrated (можно удалить вручную)');
  } catch (err) {
    console.error('Ошибка миграции (пропускаю):', err.message);
  }
}

// Хелпер для запросов с API, каким пользовался прежний драйвер PostgreSQL:
// возвращает { rows }. Слой маршрутов написан под него, и переписывать
// сотни вызовов ради смены базы было бы дороже, чем держать обёртку.
function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const firstWord = sql.trim().split(/[\s(]/)[0].toUpperCase();
  if (firstWord === 'SELECT') {
    return { rows: stmt.all(...params) };
  }
  const info = stmt.run(...params);
  return { rows: [], changes: info.changes };
}

module.exports = {
  connect,
  initDb,
  migrateLegacyData,
  query,
  setupPending,
};