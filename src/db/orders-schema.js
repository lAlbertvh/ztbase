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

    -- Переписка внутри наряда.
    --
    -- Смысл в том, чтобы врач и техник решали вопрос прямо в заказе:
    -- «поставьте импланты вместо 28-го», «сделайте мост из циркона» —
    -- и из этого разговора рождался наряд. Поэтому сообщения привязаны к
    -- наряду, а не болтаются общим списком.
    --
    -- author_user_id — автор по users.id, а не по имени: сотрудника могут
    -- переименовать, и тогда его старые сообщения стали бы чужими.
    -- author_name копируется для показа, чтобы не подтягивать пользователя
    -- на каждое сообщение и не ломать историю при отключении учётки.
    CREATE TABLE IF NOT EXISTS order_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      author_user_id INTEGER,
      author_name TEXT,
      author_role TEXT,
      body TEXT NOT NULL,
      -- Согласованные конструкции из переписки: по кодам из справочника.
      -- Хранятся именно коды, а не id: код переживает смену прайса, и
      -- кнопка «Заполнить наряд» остаётся рабочей после обновления цен.
      proposal_codes TEXT,
      -- Сообщение, из которого наряд уже собрали: помечаем, чтобы
      -- повторное нажатие не плодило дубли позиций.
      applied_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_order_messages_order
      ON order_messages(order_id, id);

    -- Отметка «до какого момента пользователь читал переписку».
    --
    -- Отдельная таблица, а не колонка в order_messages: у наряда
    -- несколько читателей, и у каждого своя отметка. Сообщение считается
    -- непрочитанным, если оно написано после last_seen_at этого
    -- пользователя в этом наряде и отправлено не им самим.
    CREATE TABLE IF NOT EXISTS order_seen (
      order_id INTEGER NOT NULL,
      user_id  INTEGER NOT NULL,
      last_seen_at TEXT,
      PRIMARY KEY (order_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_order_seen_user ON order_seen(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_materials_order ON order_materials(order_id);
    CREATE INDEX IF NOT EXISTS idx_materials_lab ON materials(lab_id, active);

    -- Конструкции, заказанные в наряде. Отдельная от order_teeth
    -- таблица, потому что наряд почти никогда не бывает «одна
    -- конструкция на все зубы»: врач пишет «17,16 съёмная, вместо 28
    -- имплант, между ними мост», и всё это три разные позиции с
    -- разными ценами. Раньше в наряде было ровно одно поле work_kind
    -- на весь заказ, из-за чего состав работы не помещался в наряд.
    -- construction_id nullable: позиция может остаться в наряде даже
    -- если её убрали из справочника, поэтому копируем название и цену.
    CREATE TABLE IF NOT EXISTS order_constructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lab_id INTEGER NOT NULL DEFAULT 1,
      construction_id INTEGER,
      code TEXT,
      title TEXT NOT NULL,
      price REAL,
      price_tech REAL,
      qty REAL NOT NULL DEFAULT 1,
      material TEXT,
      note TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_order_constructions_order
      ON order_constructions(order_id);
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
  // Клиника наряда: по ней врачи одной клиники видят общие заказы.
  //
  // Колонка допускает NULL: наряд может остаться без клиники, если автор
  // ни к одной не привязан (личный заказ лаборатории, старые данные).
  // NULL — это не «неизвестная клиника»: такой наряд остаётся доступным
  // автору и администратору, а не пропадает у всех сразу.
  addColSafe('orders', 'clinic_id', 'INTEGER');

  // users.clinic_id объявляет миграция конструкций. Объявляем здесь же:
  // перенос нарядов ниже читает именно эту колонку, а порядок вызова
  // миграций однажды изменится — и перенос молча перестанет работать.
  addColSafe('users', 'clinic_id', 'INTEGER');

  // Индекс создаём после addColSafe: в общем блоке выше колонки ещё нет,
  // и на пустой базе CREATE INDEX упал бы с «no such column».
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_lab_clinic ON orders(lab_id, clinic_id, created_at DESC)');

  // Наряды, заведённые до появления колонки, привязываем к клинике
  // их автора. Условие clinic_id IS NULL делает перенос одноразовым:
  // повторный запуск сервера не переписывает уже проставленные вручную
  // правки, а новые наряды с клиникой не затрагивает.
  const filled = db.prepare(`
    UPDATE orders SET clinic_id = (
      SELECT u.clinic_id FROM users u
      WHERE u.lab_id = orders.lab_id AND u.name = orders.created_by
    )
    WHERE clinic_id IS NULL
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.lab_id = orders.lab_id AND u.name = orders.created_by
      )
  `).run().changes;
  if (filled > 0) {
    console.log(`Клиника проставлена у ${filled} наряд(ах), заведённых до перехода`);
  }

  // Автор_id у сообщений: переименование сотрудника не должно делать его
  // старые сообщения чужими.
  addColSafe('order_messages', 'author_user_id', 'INTEGER');

  // Две цены у позиции наряда: для врача и себестоимость для техника.
  // В наряде хранится копия обеих — правка прайса не должна менять уже
  // согласованные суммы.
  addColSafe('order_constructions', 'price_tech', 'REAL');

  // Скидка в процентах от цены для врача. Хранится именно процент,
  // а не итоговая сумма: при правке цен скидка должна пересчитаться
  // сама, иначе клиника увидела бы одну сумму, а лаборатория считала бы
  // другую. На себестоимость скидка не влияет.
  addColSafe('orders', 'discount', 'REAL NOT NULL DEFAULT 0');

  // Номера нарядов уникальны внутри лаборатории, а не глобально:
  // две разные лаборатории вправе использовать один и тот же номер.
  // Частичный уникальный индекс не ломает существующие дубликаты,
  // в отличие от UNIQUE в самой таблице.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_lab_number
    ON orders(lab_id, order_number) WHERE order_number <> ''
  `);

  // Отметка «верхний зуб» называлась maxilla. Теперь antagonist —
  // «антагонист», как в стоматологии: верхний и нижний противопоставлены
  // друг другу, а не выделены как «главный» и «второй».
  //
  // Переписываем список зубов, а не отдельную колонку: flags хранит
  // набор через запятую, и maxilla может стоять в любом месте строки.
  // Условие по ',maxilla,' и границам строки важны: подстрока 'maxillary'
  // не должна превратиться в 'antagonistry'.
  const renamed = db.prepare(`
    SELECT id, flags FROM order_teeth
    WHERE flags IS NOT NULL
      AND (',' || REPLACE(flags, ' ', '') || ',') LIKE '%,maxilla,%'
  `).all();

  for (const row of renamed) {
    // Через split/join, а не через REPLACE по строке: так сохраняются
    // остальные отметки и их порядок, а случайные совпадения в других
    // словах не затрагиваются.
    const next = String(row.flags).split(',').map(f => {
      const key = f.trim();
      return key === 'maxilla' ? 'antagonist' : f;
    }).filter(Boolean).join(',');
    db.prepare('UPDATE order_teeth SET flags = ? WHERE id = ?').run(next, row.id);
  }
  if (renamed.length) {
    console.log(`Отметка maxilla переименована в antagonist у ${renamed.length} зуб(ах)`);
  }
}

module.exports = { migrateOrders };
