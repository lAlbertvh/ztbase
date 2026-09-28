require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { storage, uniqueName, BACKEND } = require('./src/services/storage');
const SqliteStore = require('./src/services/session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// ------ Определяем корневую папку приложения ------
// В собранном exe (pkg) данные кладём рядом с исполняемым файлом,
// в dev-режиме — рядом с исходниками
const appRoot = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname);

// Папка с шаблонами: в exe — внутри бандла (__dirname), в dev — как обычно
const viewsDir = process.pkg
  ? path.join(__dirname, 'views')
  : path.join(appRoot, 'views');

// Папка со статикой (PWA: манифест, иконки, сервис-воркер)
const publicDir = process.pkg
  ? path.join(__dirname, 'public')
  : path.join(appRoot, 'public');

console.log('Корневая папка приложения:', appRoot);

// Пути к папкам для данных
const uploadDir = path.join(appRoot, 'uploads');
const dbDir = path.join(appRoot, 'database');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Создана папка для загрузок:', uploadDir);
}

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ------ Хэширование паролей ------
// scrypt из стандартной библиотеки Node: не нужно тянуть bcrypt,
// и он устойчив к перебору. Формат: scrypt$<соль>$<хэш>
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ------ Подключение к SQLite ------
const db = new Database(path.join(dbDir, 'exo.db'));
db.pragma('journal_mode = WAL');

// ------ Инициализация таблиц и миграция ------
function initDb() {
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

  // Проверка наличия устаревшей колонки и добавление (если нет)
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
        UNIQUE (lab_id, name)
      );
      INSERT INTO users_new (id, name, lab_id, password_hash, role, active)
        SELECT id, name, lab_id, password_hash, role, active FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('users: уникальность имени ограничена лабораторией (lab_id, name)');
  }

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

// ------ Миграция из старого файла files.db (SQLite) ------
function migrateLegacyData() {
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
      console.log(`Временный пароль для перенесённых пользователей: из MIGRATION_TEMP_PASSWORD`);
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

initDb();
migrateLegacyData();

// ------ Хелпер для запросов (совместимость с API pool.query) ------
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  const firstWord = sql.trim().split(/[\s(]/)[0].toUpperCase();
  if (firstWord === 'SELECT') {
    return { rows: stmt.all(...params) };
  }
  const info = stmt.run(...params);
  return { rows: [], changes: info.changes };
}

// ------ Настройка Express ------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  const isFileRoute = req.path.startsWith('/image/') || req.path.startsWith('/download');
  if (!isFileRoute) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  }
  next();
});
// Секрет для подписи cookie. В рабочей версии он обязан быть задан:
// с ключом из примера любой может подделать сессию администратора.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'your-secret-key-change-this') {
  if (process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET не задан. Приложение не запускается.');
    process.exit(1);
  }
  console.warn('ВНИМАНИЕ: SESSION_SECRET не задан, используется временный ключ.');
}

// Временный ключ только для локальной разработки: он меняется при каждом
// запуске, поэтому сессии не переживают перезапуск — и это безопасно.
const devSecret = SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

app.use(session({
  store: new SqliteStore(db),
  secret: devSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 12 * 60 * 60 * 1000, // 12 часов: рабочая смена
    httpOnly: true,
    sameSite: 'lax',
    // За nginx с HTTPS cookie должна быть secure, иначе браузер
    // не отправит её и вход будет сбрасываться при каждом обновлении.
    secure: process.env.COOKIE_SECURE === '1'
  }
}));

app.use(express.static(publicDir));

// Браузер не должен сохранять страницы с заказами на диск: после выхода
// из аккаунта данные остались бы в кэше и могли бы попасть в поле зрения
// следующего сотрудника на том же компьютере.
app.use((req, res, next) => {
  if (req.path.startsWith('/public')) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.set('view engine', 'ejs');
app.set('views', viewsDir);

// ------ Multer для загрузки файлов ------
// Файлы пишутся во временную папку, а не сразу в конечное место.
// Причина: STL полной дуги весит 50-150 МБ, и держать их в памяти нельзя.
// После загрузки storage.put() переносит файл в папку лаборатории
// (или в облако, если STORAGE_BACKEND=s3).
const tmpUploadDir = path.join(appRoot, 'tmp-uploads');
if (!fs.existsSync(tmpUploadDir)) {
  fs.mkdirSync(tmpUploadDir, { recursive: true });
  console.log('Создана временная папка для загрузок:', tmpUploadDir);
}

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const os = require('os');
    cb(null, fs.mkdtempSync(path.join(os.tmpdir(), 'ztlab-')));
  },
  filename: (req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uniqueName(decodedName));
  }
});
const upload = multer({ storage: multerStorage });

// Защита от подбора пароля: не больше 10 попыток с одного адреса за 15 минут.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function attemptsFor(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, first: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// ------ Middleware авторизации ------
const PUBLIC_PATHS = new Set(['/login', '/set-user', '/register', '/register-lab']);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/public')) {
    return next();
  }
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
});

// Только администратор лаборатории (удаление файлов, пользователи).
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.status(403).send('Недостаточно прав');
  }
  next();
}

// ------ Маршруты ------

// Страница входа
app.get('/login', async (req, res) => {
  // Адрес лаборатории можно указать один раз и потом просто входить по паролю.
  // Ссылка вида /login?lab=ivanova приходит из письма или закладки.
  const preslug = String(req.query.lab || '').trim();
  const error = String(req.query.error || '');
  res.render('login', { error: error || null, preslug });
});

// Страница регистрации лаборатории
app.get('/register', async (req, res) => {
  res.render('register', { error: null });
});

// Вход по имени и паролю. Раньше пароля не было: на странице входа был
// выбор имени из списка, что неприемлемо, когда в системе чужие лаборатории.
app.post('/set-user', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const slug = (req.body.lab_slug || '').trim().toLowerCase();
  const ip = req.ip || 'unknown';

  if (attemptsFor(ip) > MAX_ATTEMPTS) {
    return res.status(429).render('login', { error: 'Слишком много попыток. Подождите 15 минут.', preslug: slug });
  }

  const fail = (msg, status) => res.status(status).render('login', { error: msg, preslug: slug });

  try {
    // Лабораторию нужно знать заранее: одно и то же имя может быть
    // у сотрудника любой лаборатории, искать по всем сразу нельзя —
    // иначе можно войти в чужую лабораторию, назвав чужое имя.
    if (!slug) {
      return fail('Укажите адрес лаборатории', 400);
    }
    const lab = query('SELECT id, slug FROM labs WHERE slug = ?', [slug]);
    if (lab.rows.length === 0) {
      // Не сообщаем, существует ли адрес, чтобы не перебирать лаборатории.
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }
    const labId = lab.rows[0].id;

    const result = query(
      'SELECT * FROM users WHERE name = ? AND lab_id = ?',
      [username, labId]
    );
    if (result.rows.length === 0) {
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }

    const user = result.rows[0];
    if (!user.active) {
      return fail('Учётная запись отключена', 403);
    }
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }

    clearAttempts(ip);
    req.session.user = username;
    req.session.labId = labId;
    req.session.role = user.role;
    req.session.labSlug = slug;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

app.get('/logout', (req, res) => {
  // Адрес лаборатории запоминаем, чтобы на форме входа он уже был заполнен.
  const slug = req.session.labSlug || '';
  req.session.destroy(() => {
    res.redirect(slug ? `/login?lab=${encodeURIComponent(slug)}` : '/login');
  });
});

// Регистрация новой лаборатории. Создаёт лабораторию и первого
// администратора за один шаг, чтобы не пришлось настраивать вручную.
app.post('/register-lab', async (req, res) => {
  const labName = (req.body.lab_name || '').trim();
  const userName = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!labName) return res.status(400).send('Укажите название лаборатории');
  if (!userName) return res.status(400).send('Укажите имя пользователя');
  if (password.length < 6) return res.status(400).send('Пароль короче 6 символов');

  try {
    let slug = (req.body.slug || '').trim().toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) slug = 'lab-' + Date.now().toString(36);

    const exists = query('SELECT id FROM labs WHERE slug = ?', [slug]).rows;
    if (exists.length > 0) {
      return res.status(409).send('Такая лаборатория уже зарегистрирована');
    }

    query('INSERT INTO labs (slug, name) VALUES (?, ?)', [slug, labName]);
    const labId = db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug).id;

    query(
      'INSERT INTO users (name, password_hash, role, active, lab_id) VALUES (?, ?, ?, 1, ?)',
      [userName, hashPassword(password), 'admin', labId]
    );

    req.session.user = userName;
    req.session.labId = labId;
    req.session.role = 'admin';
    req.session.labSlug = slug;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при регистрации');
  }
});

// Главная страница (с перенаправлением для Елены и динамическим поиском)
app.get('/', async (req, res) => {
  const { date, uploader, downloaded, filename } = req.query;

  let sql = 'SELECT * FROM files';
  const params = [];
  const conditions = [];

  // Ограничение по лаборатории добавляется первым условием и всегда:
  // без него заказы других лабораторий были бы видны.
  const labId = req.session.labId || 1;
  conditions.push('lab_id = ?');
  params.push(labId);

  if (date) {
    conditions.push('substr(upload_date, 1, 10) = ?');
    params.push(date);
  }
  if (uploader) {
    conditions.push('uploader = ?');
    params.push(uploader);
  }
  if (downloaded !== undefined && downloaded !== '') {
    conditions.push('downloaded = ?');
    params.push(downloaded === 'true' ? 1 : 0);
  }
  if (filename && filename.trim() !== '') {
    conditions.push('original_name LIKE ?');
    params.push('%' + filename + '%');
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY upload_date DESC';

  try {
    const filesResult = query(sql, params);
    const files = filesResult.rows;

    const today = new Date().toISOString().slice(0, 10);
    const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const byMonth = {};
    files.forEach(f => {
      const d = (f.upload_date || '').slice(0, 10);
      if (!d) return;
      const [y, m] = d.split('-').map(Number);
      const monthKey = `${y}-${String(m).padStart(2, '0')}`;
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m - 1]} ${y}`, days: {} };
      }
      if (!byMonth[monthKey].days[d]) {
        byMonth[monthKey].days[d] = { dateKey: d, isToday: d === today, files: [] };
      }
      byMonth[monthKey].days[d].files.push(f);
    });
    const groupedFiles = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const month = byMonth[k];
        const dayKeys = Object.keys(month.days).sort((a, b) => b.localeCompare(a));
        month.daysList = dayKeys.map(dk => {
          const day = month.days[dk];
          const [, mm, dd] = dk.split('-');
          const mi = parseInt(mm, 10) - 1;
          day.dayLabel = `${parseInt(dd, 10)} ${monthNamesGen[mi]} ${month.monthLabel.split(' ')[1]}`;
          return day;
        });
        return month;
      });

    const uploadersResult = query('SELECT DISTINCT uploader FROM files WHERE lab_id = ?', [req.session.labId || 1]);
    const uploaders = uploadersResult.rows.map(row => row.uploader);

    res.render('index', {
      files,
      groupedFiles,
      todayKey: today,
      users: uploaders,
      currentUser: req.session.user,
      isAdmin: req.session.role === 'admin',
      filters: { date, uploader, downloaded, filename }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка базы данных');
  }
});

// Загрузка файлов
app.post('/upload', upload.fields([
  { name: 'stlFiles', maxCount: 20 },
  { name: 'imageFile', maxCount: 1 }
]), async (req, res) => {
  if (!req.files || !req.files['stlFiles'] || req.files['stlFiles'].length === 0) {
    return res.status(400).send('Не выбрано ни одного 3D-файла.');
  }

  const stlFiles = req.files['stlFiles'];
  const imageFile = req.files['imageFile'] ? req.files['imageFile'][0] : null;

  const uploader = req.session.user;
  const labId = req.session.labId || 1;
  const uploadDate = new Date().toISOString();
  const milled = req.body.milled === 'on';
  const baked = req.body.baked === 'on';
  const comment = req.body.comment || '';

  const tmpDirs = new Set();
  const collectTmp = (f) => {
    if (f && f.path) {
      tmpDirs.add(path.dirname(f.path));
      if (f.filename) f.savedAs = f.filename;
    }
  };
  stlFiles.forEach(collectTmp);
  collectTmp(imageFile);

  try {
    // Переносим файлы из временной папки в хранилище лаборатории.
    // При STORAGE_BACKEND=s3 это единственное место, где идёт загрузка.
    let imageName = null;
    if (imageFile) {
      imageName = await storage.put(imageFile.path, labId, imageFile.savedAs);
    }
    const stlRows = [];
    for (const f of stlFiles) {
      const savedAs = await storage.put(f.path, labId, f.savedAs);
      stlRows.push([Buffer.from(f.originalname, 'latin1').toString('utf8'), savedAs]);
    }

    const insertStmt = db.prepare(
      `INSERT INTO files
       (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment, lab_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows) => {
      for (const [decodedStlName, storedStlName] of rows) {
        insertStmt.run(decodedStlName, storedStlName, imageName, uploader, uploadDate, 0, milled ? 1 : 0, baked ? 1 : 0, comment, labId);
      }
    });
    insertAll(stlRows);
    res.redirect('/');
  } catch (err) {
    console.error('Ошибка при загрузке файлов:', err);
    res.status(500).send('Ошибка при сохранении в БД.');
  } finally {
    // Временные папки убираем в любом случае, иначе они разрастаются.
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (e) {
        console.error('Не удалось убрать временную папку:', d, e.message);
      }
    }
  }
});

// Скачивание 3D-файла
app.get('/download/:id', async (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  try {
    const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден.');
    }
    const file = fileResult.rows[0];

    const updateDownloaders = (currentList, newUser) => {
      if (!currentList) return newUser;
      const users = currentList.split(',').map(u => u.trim());
      if (users.includes(newUser)) return currentList;
      return currentList + ', ' + newUser;
    };

    if (!file.downloaded) {
      const downloadDate = new Date().toISOString();
      query(
        'UPDATE files SET downloaded = 1, downloaded_by = ?, downloaded_date = ? WHERE id = ? AND lab_id = ?',
        [downloader, downloadDate, fileId, req.session.labId || 1]
      );
    } else {
      const newList = updateDownloaders(file.downloaded_by, downloader);
      if (newList !== file.downloaded_by) {
        query(
          'UPDATE files SET downloaded_by = ? WHERE id = ? AND lab_id = ?',
          [newList, fileId, req.session.labId || 1]
        );
      }
    }

    await storage.sendFile(res, file.lab_id || 1, file.stored_name, file.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// MIME-типы для изображений
const imageMime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

// Просмотр изображения
app.get('/image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = query('SELECT image_name, lab_id FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    // Через storage, а не sendFile: при STORAGE_BACKEND=s3 файла на диске нет.
    await storage.sendFile(res, file.lab_id, file.image_name, file.image_name, true);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Скачивание изображения
app.get('/download-image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = query('SELECT image_name, lab_id, original_name FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    await storage.sendFile(res, file.lab_id || 1, file.image_name, file.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Удаление файла
app.post('/delete/:id', async (req, res) => {
  const fileId = req.params.id;
  const { code } = req.body;

  if (code !== '78') {
    return res.status(403).send('Неверный код');
  }

  try {
    const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден');
    }
    const file = fileResult.rows[0];

    try {
      await storage.remove(file.lab_id || 1, file.stored_name);
      if (file.image_name) {
        await storage.remove(file.lab_id || 1, file.image_name);
      }
    } catch (err) {
      console.error('Ошибка удаления файлов:', err);
    }

    await query('DELETE FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при удалении из БД');
  }
});

// Переключение статусов
app.post('/toggle-milled/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await query('UPDATE files SET milled = NOT milled WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/toggle-baked/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await query('UPDATE files SET baked = NOT baked WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/comment/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  const { comment } = req.body;
  try {
    await query('UPDATE files SET comment = ? WHERE id = ? AND lab_id = ?', [comment, req.params.id, req.session.labId || 1]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

// Страница добавления пользователя
app.get('/add-user', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('add-user', { error: null });
});

// Добавление сотрудника в лабораторию. Только администратор.
app.post('/add-user', requireAdmin, async (req, res) => {
  const { password, newUsername, role } = req.body;
  const name = (newUsername || '').trim();

  if (!name) {
    return res.render('add-user', { error: 'Имя не может быть пустым' });
  }
  if (!password || password.length < 6) {
    return res.render('add-user', { error: 'Пароль должен быть не короче 6 символов' });
  }

  const newRole = role === 'admin' ? 'admin' : 'tech';

  try {
    const existing = query(
      'SELECT id FROM users WHERE name = ? AND lab_id = ?',
      [name, req.session.labId || 1]
    ).rows;
    if (existing.length > 0) {
      return res.render('add-user', { error: 'Пользователь с таким именем уже существует' });
    }
    query(
      'INSERT INTO users (name, password_hash, role, active, lab_id) VALUES (?, ?, ?, 1, ?)',
      [name, hashPassword(password), newRole, req.session.labId || 1]
    );
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('add-user', { error: 'Ошибка базы данных' });
  }
});

// ===== МАРШРУТЫ ДЛЯ УЧЁТА ТИТАНОВЫХ ОСНОВАНИЙ =====

// Страница со списком оснований (ИСПРАВЛЕННАЯ)
app.get('/titan', async (req, res) => {
  try {
    const { order_number, status, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM titan_orders';
    const params = [];
    const conditions = [];

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

    if (order_number && order_number.trim() !== '') {
      conditions.push(`order_number LIKE ?`);
      params.push(`%${order_number}%`);
    }
    if (status && status !== 'all') {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (date_from) {
      conditions.push(`order_date >= ?`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`order_date <= ?`);
      params.push(date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY order_date DESC, created_at DESC';

    const result = query(sql, params);
    const orders = result.rows;

    // ИСПРАВЛЕНО: используем локальную дату
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayKey = `${year}-${month}-${day}`;

    const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const byMonth = {};

    orders.forEach(o => {
      let dateStr = o.order_date;
      if (!dateStr) return;
      if (typeof dateStr === 'object' && dateStr.toISOString) {
        const d = new Date(dateStr);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dday = String(d.getDate()).padStart(2, '0');
        dateStr = `${y}-${m}-${dday}`;
      } else {
        dateStr = String(dateStr).slice(0, 10);
      }
      const [y, m] = dateStr.split('-').map(Number);
      const monthKey = `${y}-${String(m).padStart(2, '0')}`;
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m-1]} ${y}`, days: {} };
      }
      if (!byMonth[monthKey].days[dateStr]) {
        byMonth[monthKey].days[dateStr] = { dateKey: dateStr, isToday: dateStr === todayKey, orders: [] };
      }
      byMonth[monthKey].days[dateStr].orders.push(o);
    });

    const groupedOrders = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const month = byMonth[k];
        const dayKeys = Object.keys(month.days).sort((a, b) => b.localeCompare(a));
        month.daysList = dayKeys.map(dk => {
          const day = month.days[dk];
          const [, mm, dd] = dk.split('-');
          const mi = parseInt(mm, 10) - 1;
          day.dayLabel = `${parseInt(dd, 10)} ${monthNamesGen[mi]} ${month.monthLabel.split(' ')[1]}`;
          return day;
        });
        return month;
      });

    // Доступ к титановым основаниям — у администратора лаборатории.
    // Раньше это определялось именем «Елена», что не переносилось на другие лаборатории.
    const isAdmin = (req.session.role === 'admin');

    res.render('titan', {
      orders: orders,
      groupedOrders: groupedOrders,
      todayKey: todayKey, // передаём исправленную дату
      currentUser: req.session.user,
      isAdmin: isAdmin,
      filters: { order_number, status, date_from, date_to }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка базы данных');
  }
});

// Добавление записей (несколько позиций)
app.post('/titan/add', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { order_date, order_number, items } = req.body;
  let itemsArray = [];
  if (items) {
    if (Array.isArray(items)) {
      itemsArray = items;
    } else {
      itemsArray = [items];
    }
  } else {
    const { system_name, size, has_hex } = req.body;
    if (system_name && size) {
      itemsArray.push({ system_name, size, has_hex: has_hex === 'on' });
    }
  }

  if (itemsArray.length === 0) {
    return res.status(400).send('Нет данных для добавления');
  }

  const client = db;
  try {
    const insertStmt = db.prepare(
      `INSERT INTO titan_orders 
       (order_date, order_number, system_name, size, has_hex, created_by, lab_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows) => {
      for (const item of rows) {
        const sizeValue = parseFloat(item.size);
        if (isNaN(sizeValue)) {
          throw new Error(`Некорректное значение размера: ${item.size}`);
        }
        insertStmt.run(
          order_date || new Date().toISOString().slice(0,10),
          order_number,
          item.system_name,
          sizeValue,
          item.has_hex === true || item.has_hex === 'on' ? 1 : 0,
          req.session.user,
          req.session.labId || 1
        );
      }
    });
    insertAll(itemsArray);
    res.redirect('/titan');
  } catch (err) {
    console.error('Ошибка при добавлении:', err);
    res.status(500).send('Ошибка при добавлении: ' + err.message);
  }
});

// Переключение статуса основания — только для администратора лаборатории
app.post('/titan/toggle-status/:id', requireAdmin, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }
  const id = req.params.id;
  try {
    const current = query('SELECT status FROM titan_orders WHERE id = ? AND lab_id = ?', [id, req.session.labId || 1]);
    if (current.rows.length === 0) return res.status(404).json({ success: false });
    const newStatus = current.rows[0].status === 'pending' ? 'issued' : 'pending';
    await query('UPDATE titan_orders SET status = ? WHERE id = ? AND lab_id = ?', [newStatus, id, req.session.labId || 1]);
    res.json({ success: true, newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// Экспорт в Excel (с учётом текущих фильтров)
app.get('/titan/export', async (req, res) => {
  try {
    const { order_number, status, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM titan_orders';
    const params = [];
    const conditions = [];

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

    if (order_number && order_number.trim() !== '') {
      conditions.push(`order_number LIKE ?`);
      params.push(`%${order_number}%`);
    }
    if (status && status !== 'all') {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (date_from) {
      conditions.push(`order_date >= ?`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`order_date <= ?`);
      params.push(date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY order_date, order_number';

    const result = query(sql, params);
    const rows = result.rows;

    const groups = {};
    rows.forEach(row => {
      let dateStr = row.order_date;
      if (typeof dateStr === 'object' && dateStr.toISOString) {
        const d = new Date(dateStr);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dday = String(d.getDate()).padStart(2, '0');
        dateStr = `${y}-${m}-${dday}`;
      } else {
        dateStr = String(dateStr).slice(0, 10);
      }
      const key = `${row.order_number}_${row.system_name}_${row.size}_${row.has_hex}`;
      if (!groups[key]) {
        groups[key] = {
          order_date: dateStr,
          order_number: row.order_number,
          system_name: row.system_name,
          size: row.size,
          has_hex: row.has_hex ? 'Да' : 'Нет',
          count: 0
        };
      }
      groups[key].count++;
    });

    const data = Object.values(groups).sort((a, b) => {
      if (a.order_number !== b.order_number) return a.order_number.localeCompare(b.order_number);
      return a.order_date.localeCompare(b.order_date);
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Титановые основания');

    worksheet.columns = [
      { header: 'Дата', key: 'order_date', width: 12 },
      { header: 'Наряд', key: 'order_number', width: 15 },
      { header: 'Система', key: 'system_name', width: 25 },
      { header: 'Размер', key: 'size', width: 10 },
      { header: 'Позиционер', key: 'has_hex', width: 12 },
      { header: 'Количество', key: 'count', width: 10 }
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4CAF50' }
    };

    worksheet.addRows(data);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=titan_export.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Ошибка при создании Excel:', err);
    res.status(500).send('Ошибка при создании Excel: ' + err.message);
  }
});

// Печать (поддерживает фильтр по номеру наряда и диапазону дат)
app.get('/titan/print', async (req, res) => {
  try {
    const { order_number, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM titan_orders';
    const params = [];
    const conditions = [];

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

    if (order_number) {
      conditions.push(`order_number LIKE ?`);
      params.push(`%${order_number}%`);
    }
    if (date_from) {
      conditions.push(`order_date >= ?`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`order_date <= ?`);
      params.push(date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY order_date, order_number';

    const result = query(sql, params);
    const orders = result.rows;
    orders.forEach(o => {
      if (o.order_date && typeof o.order_date === 'object') {
        const d = new Date(o.order_date);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dday = String(d.getDate()).padStart(2, '0');
        o.order_date = `${y}-${m}-${dday}`;
      }
    });

    let title = 'Печать нарядов';
    if (order_number) {
      title = `Наряд № ${order_number}`;
    } else if (date_from && date_to) {
      title = `Период с ${date_from} по ${date_to}`;
    } else if (date_from) {
      title = `С ${date_from}`;
    } else if (date_to) {
      title = `По ${date_to}`;
    }

    res.render('titan_print', { 
      orders, 
      title: 'Печать нарядов',
      subtitle: title,
      order_number: order_number || null,
      date_from: date_from || null,
      date_to: date_to || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при загрузке данных для печати');
  }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`Для доступа с других компьютеров используйте IP-адрес этого компьютера`);
  if (process.env.OPEN_BROWSER !== '0') {
    const os = require('os');
    const url = `http://localhost:${PORT}`;
    let cmd = null;
    const platform = os.platform();
    if (platform === 'win32') {
      cmd = `start "" "${url}"`;
    } else if (platform === 'darwin') {
      cmd = `open "${url}"`;
    } else {
      const candidates = ['xdg-open', 'sensible-browser', 'gio open'];
      for (const c of candidates) {
        try {
          require('child_process').execSync(`which ${c.split(' ')[0]}`, { stdio: 'ignore' });
          cmd = `${c} "${url}"`;
          break;
        } catch (e) { /* not found */ }
      }
    }
    if (cmd) {
      try {
        require('child_process').exec(cmd);
        console.log('🌐 Открываю браузер...');
      } catch (e) { /* ignore */ }
    }
  }
});