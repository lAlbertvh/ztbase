// Схема первичной настройки: мастер при первом запуске.
//
// Заведена отдельным модулем, потому что описывает не работу с
// заказами, а состояние самой установки: кто владелец, на каком тарифе,
// какие клиники-партнёры подключены и что уже заполнено при настройке.
// В server.js её по той же причине не держим — файл вызывается один раз
// при старте, миграции идемпотентны.

/**
 * Клиники-партнёры и их представители.
 *
 * Клиника здесь — внешний заказчик (стоматология), а не сотрудник
 * лаборатории: её представители не входят в список работников, но
 * занимают место в тарифе наравне с ними, поэтому считаются вместе.
 */
function migrateSetup(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_settings (
      lab_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (lab_id, key)
    );

    CREATE TABLE IF NOT EXISTS clinics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      contact TEXT,
      note TEXT,
      active BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clinics_lab ON clinics(lab_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clinics_lab_name ON clinics(lab_id, name);

    CREATE TABLE IF NOT EXISTS clinic_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL,
      clinic_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      contact TEXT,
      active BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_clinic_contacts_clinic
      ON clinic_contacts(clinic_id, active);

    -- Одноразовые коды для входа нового сотрудника в лабораторию.
    --
    -- Администратор не знает пароль будущего сотрудника и не должен
    -- его придумывать за него: код выдаётся на бумаге или в мессенджере,
    -- сотрудник сам приходит на /join, вводит имя, код и свой пароль.
    -- Код действует только внутри выдавшей его лаборатории, поэтому
    -- подделать его из другой лаборатории нельзя, а перебрать — ещё и
    -- медленно: код одноразовый и с коротким сроком жизни.
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_id INTEGER NOT NULL,
      -- Роль и специализация заранее задаёт администратор: сотрудник
      -- не выбирает себе права, он их получает вместе с кодом.
      role TEXT NOT NULL DEFAULT 'tech',
      specialization TEXT,
      note TEXT,
      code_hash TEXT NOT NULL,
      created_by INTEGER,
      -- Срок жизни кода. По умолчанию неделя: код живёт ровно столько,
      -- сколько нужно, чтобы передать его человеку, и не дольше.
      expires_at TEXT,
      used_at TEXT,
      used_by INTEGER,
      used_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invite_codes_lab
      ON invite_codes(lab_id, used_at, expires_at);

    -- Настройки интерфейса лаборатории: этапы заказа и отметки по
    -- работе. Раньше оба списка были зашиты в код, и добавить этап
    -- «Сканирование» или отметку «Антагонист» можно было только
    -- правкой файла с последующим деплоем.
    CREATE TABLE IF NOT EXISTS lab_options (
      lab_id INTEGER NOT NULL,
      kind TEXT NOT NULL,      -- 'stage' | 'frame_flag'
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (lab_id, kind, key)
    );
    CREATE INDEX IF NOT EXISTS idx_lab_options ON lab_options(lab_id, kind, active, sort);
  `);

  // Контакт клиники может позже получить учётную запись. Ссылка нужна,
  // чтобы не считать одного человека дважды в тарифе.
  const contactCols = db.prepare('PRAGMA table_info(clinic_contacts)').all().map(c => c.name);
  if (!contactCols.includes('user_id')) {
    db.exec('ALTER TABLE clinic_contacts ADD COLUMN user_id INTEGER');
  }

  // Состояние установки держим на самой лаборатории: мастер должен
  // переживать перезапуск, а отдельная таблица ради четырёх колонок
  // усложнила бы бэкап и перенос.
  const addColSafe = (table, name, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  };
  // 0 — мастер не начат, 1 — начат, 2 — пройден.
  addColSafe('labs', 'setup_done', 'BOOLEAN DEFAULT 0');
  addColSafe('labs', 'setup_step', 'INTEGER DEFAULT 0');
  addColSafe('labs', 'license_plan', "TEXT DEFAULT 'basic'");
  addColSafe('labs', 'owner_name', 'TEXT');
  addColSafe('labs', 'contact', 'TEXT');

  // Пробный период. labs.trial_until — до какого момента лаборатория
  // работает бесплатно (UTC, ISO). NULL у платных лабораторий: срок
  // закончился или его никогда не было, и тогда trial_expired() решает
  // по факту оплаты, а не по этой колонке.
  //
  // Контакты хранятся рядом с лабораторией, а не в users: по e-mail и
  // телефону мы пишем человеку о продлении, и он не обязан быть
  // сотрудником или представителем клиники.
  addColSafe('labs', 'trial_until', 'TEXT');
  addColSafe('labs', 'trial_paid', 'BOOLEAN DEFAULT 0');
  addColSafe('labs', 'trial_email', 'TEXT');
  addColSafe('labs', 'trial_phone', 'TEXT');
}

  /**
   * Есть ли смысл показывать мастер.
   *
   * Мастер — это только первый запуск: после «пропустить» или прохождения
   * шагов настройка больше не появляется сама. Поэтому «настроен когда-то»
   * (setup_done) и «сейчас хотим мастер» — разные вещи, и держать второе
   * в базе незачем: достаточно первого флага.
   */
  function setupPending(db, labId) {
    const row = db.prepare('SELECT setup_done FROM labs WHERE id = ?').get(labId);
    return !row || !row.setup_done;
  }

  /** Мастер закрыт навсегда: лаборатория сама решила, что готова. */

  function setStep(db, labId, step) {
  db.prepare('UPDATE labs SET setup_step = ? WHERE id = ?').run(step, labId);
}

function finish(db, labId) {
  db.prepare('UPDATE labs SET setup_done = 1, setup_step = 5 WHERE id = ?').run(labId);
}

/** Значение настройки установки. */
function getSetting(db, labId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
    .get(labId, key);
  return row && row.value !== null ? row.value : fallback;
}

function setSetting(db, labId, key, value) {
  db.prepare(`
    INSERT INTO lab_settings (lab_id, key, value) VALUES (?,?,?)
    ON CONFLICT(lab_id, key) DO UPDATE SET value = excluded.value
  `).run(labId, key, value === null || value === undefined ? null : String(value));
}

module.exports = {
  migrateSetup, setupPending, setStep, finish,
  getSetting, setSetting,
};