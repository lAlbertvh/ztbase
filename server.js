require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

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

// ------ Пароль для добавления новых пользователей ------
const ADD_USER_PASSWORD = process.env.ADD_USER_PASSWORD || '545';

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
  `);

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

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const defaultUsers = [
      'София', 'Анна', 'Маргарита', 'Слава', 'Егор',
      'Наталья', 'Мария', 'Сухроб', 'Абу', 'Альберт', 'Юлия'
    ];
    const insertUser = db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)');
    for (const name of defaultUsers) {
      insertUser.run(name);
    }
    console.log('Добавлены начальные пользователи');
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

    const insertUser = db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)');
    for (const u of legacyUsers) {
      insertUser.run(u.name);
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
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(publicDir));
app.set('view engine', 'ejs');
app.set('views', viewsDir);

// ------ Multer для загрузки файлов ------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(uploadDir, req.session.user);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safeName = path.basename(decodedName);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const uniqueName = uniqueSuffix + '-' + safeName;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage: storage });

// ------ Middleware авторизации ------
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/set-user' || req.path.startsWith('/public')) {
    return next();
  }
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
});

// ------ Маршруты ------

// Страница входа
app.get('/login', async (req, res) => {
  try {
    const result = query('SELECT name FROM users ORDER BY name');
    const users = result.rows.map(row => row.name);
    res.render('login', { users });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/set-user', async (req, res) => {
  const username = req.body.username;
  try {
    const result = query('SELECT name FROM users WHERE name = ?', [username]);
    if (result.rows.length === 0) {
      return res.redirect('/login');
    }
    req.session.user = username;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Главная страница (с перенаправлением для Елены и динамическим поиском)
app.get('/', async (req, res) => {
  if (req.session.user === 'Елена') {
    return res.redirect('/titan');
  }

  const { date, uploader, downloaded, filename } = req.query;

  let sql = 'SELECT * FROM files';
  const params = [];
  const conditions = [];

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

    const uploadersResult = query('SELECT DISTINCT uploader FROM files');
    const uploaders = uploadersResult.rows.map(row => row.uploader);

    res.render('index', {
      files,
      groupedFiles,
      todayKey: today,
      users: uploaders,
      currentUser: req.session.user,
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
  let imageName = imageFile ? imageFile.filename : null;

  const uploader = req.session.user;
  const uploadDate = new Date().toISOString();
  const milled = req.body.milled === 'on';
  const baked = req.body.baked === 'on';
  const comment = req.body.comment || '';

  const client = db;
  try {
    const insertStmt = db.prepare(
      `INSERT INTO files 
       (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows) => {
      for (const [decodedStlName, storedStlName] of rows) {
        insertStmt.run(decodedStlName, storedStlName, imageName, uploader, uploadDate, 0, milled ? 1 : 0, baked ? 1 : 0, comment);
      }
    });
    insertAll(stlFiles.map(f => [Buffer.from(f.originalname, 'latin1').toString('utf8'), f.filename]));
    res.redirect('/');
  } catch (err) {
    console.error('Ошибка при загрузке файлов:', err);
    res.status(500).send('Ошибка при сохранении в БД.');
  }
});

// Скачивание 3D-файла
app.get('/download/:id', async (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  try {
    const fileResult = query('SELECT * FROM files WHERE id = ?', [fileId]);
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
        'UPDATE files SET downloaded = 1, downloaded_by = ?, downloaded_date = ? WHERE id = ?',
        [downloader, downloadDate, fileId]
      );
    } else {
      const newList = updateDownloaders(file.downloaded_by, downloader);
      if (newList !== file.downloaded_by) {
        query(
          'UPDATE files SET downloaded_by = ? WHERE id = ?',
          [newList, fileId]
        );
      }
    }

    const filePath = path.join(uploadDir, file.uploader, file.stored_name);
    res.download(filePath, file.original_name);
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
    const result = query('SELECT image_name, uploader FROM files WHERE id = ?', [fileId]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    const ext = path.extname(file.image_name).toLowerCase();
    const contentType = imageMime[ext] || 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(imagePath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Скачивание изображения
app.get('/download-image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = query('SELECT image_name, uploader, original_name FROM files WHERE id = ?', [fileId]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    const imagePath = path.join(uploadDir, file.uploader, file.image_name);
    res.download(imagePath, file.original_name);
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
    const fileResult = query('SELECT * FROM files WHERE id = ?', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден');
    }
    const file = fileResult.rows[0];

    const stlPath = path.join(uploadDir, file.uploader, file.stored_name);
    fs.unlink(stlPath, (err) => {
      if (err) console.error('Ошибка удаления STL:', err);
    });

    if (file.image_name) {
      const imagePath = path.join(uploadDir, file.uploader, file.image_name);
      fs.unlink(imagePath, (err) => {
        if (err) console.error('Ошибка удаления изображения:', err);
      });
    }

    await query('DELETE FROM files WHERE id = ?', [fileId]);
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
    await query('UPDATE files SET milled = NOT milled WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/toggle-baked/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await query('UPDATE files SET baked = NOT baked WHERE id = ?', [req.params.id]);
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
    await query('UPDATE files SET comment = ? WHERE id = ?', [comment, req.params.id]);
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

app.post('/add-user', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { password, newUsername } = req.body;
  if (password !== ADD_USER_PASSWORD) {
    return res.render('add-user', { error: 'Неверный пароль' });
  }

  if (!newUsername || newUsername.trim() === '') {
    return res.render('add-user', { error: 'Имя не может быть пустым' });
  }

  try {
    const existing = query('SELECT id FROM users WHERE name = ?', [newUsername.trim()]).rows;
    if (existing.length > 0) {
      return res.render('add-user', { error: 'Пользователь с таким именем уже существует' });
    }
    query('INSERT INTO users (name) VALUES (?)', [newUsername.trim()]);
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

    const isElena = (req.session.user === 'Елена');

    res.render('titan', {
      orders: orders,
      groupedOrders: groupedOrders,
      todayKey: todayKey, // передаём исправленную дату
      currentUser: req.session.user,
      isElena: isElena,
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
       (order_date, order_number, system_name, size, has_hex, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`
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
          req.session.user
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

// Переключение статуса (только Елена)
app.post('/titan/toggle-status/:id', async (req, res) => {
  if (req.session.user !== 'Елена') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }
  const id = req.params.id;
  try {
    const current = query('SELECT status FROM titan_orders WHERE id = ?', [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false });
    const newStatus = current.rows[0].status === 'pending' ? 'issued' : 'pending';
    await query('UPDATE titan_orders SET status = ? WHERE id = ?', [newStatus, id]);
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