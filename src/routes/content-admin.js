'use strict';

// Админка содержимого: /admin/content
//
// Отдельного сервиса на C++ для этого не делаем намеренно. В проекте
// уже есть авторизация, роли и загрузка файлов, поэтому новая админка —
// это несколько маршрутов в том же приложении. Второй язык и второе
// развёртывание дали бы новую поверхность атаки ради правки текста.

const express = require('express');
const path = require('path');
const fs = require('fs');

const content = require('../services/content');

const router = express.Router();

const contentImgDir = path.resolve(
  process.env.CONTENT_IMG_DIR || path.join(__dirname, '..', '..', 'public', 'content')
);
// Папку создаём, но падение на этом не роняет всё приложение. Раньше
// mkdir шёл без защиты, и на VPS из-за отказа в доступе (ProtectSystem
// =strict, папка кода read-only) сервис целиком уходил в цикл
// перезапусков из-за несуществующего каталога картинок.
try {
  fs.mkdirSync(contentImgDir, { recursive: true });
} catch (e) {
  console.error(
    `Не удалось создать папку для картинок ${contentImgDir}: ${e.message}. `
    + 'Загрузка изображений не заработает, остальное приложение продолжит работу.'
  );
}

// Второй слой защиты поверх входа в приложение: обычная пара логин/пароль
// прямо в админку. Нужен потому, что раздел меняет публичный текст сайта,
// а лишний барьер здесь стоит недорого.
//
// Если переменные не заданы, работает только сессия администратора:
// раздел не должен ломаться при первом запуске, пока пароль ещё
// не придуман.
const adminUser = process.env.CONTENT_ADMIN_USER || '';
const adminPass = process.env.CONTENT_ADMIN_PASS || '';
const basicAuthRequired = Boolean(adminUser && adminPass);

// Сравнение постоянного времени: при обычном сравнении по задержке
// ответа можно подбирать пароль побайтно.
function secretEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
}

router.use((req, res, next) => {
  if (!basicAuthRequired) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0 &&
        secretEquals(decoded.slice(0, sep), adminUser) &&
        secretEquals(decoded.slice(sep + 1), adminPass)) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="ZT Lab content editor", charset="UTF-8"');
  return res.status(401).send('Требуется логин и пароль');
});

// Меняем содержимое только администратору лаборатории.
router.use((req, res, next) => {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.status(403).send('Раздел доступен только администратору лаборатории');
  }
  next();
});

router.get('/', (req, res) => {
  res.render('content-admin', {
    content: content.read(),
    contentFile: content.contentFile,
    published: content.read().publishedAt || 'ещё ни разу не публиковалось',
    saved: req.query.saved === '1',
    error: req.query.error || '',
  });
});

router.post('/', (req, res) => {
  try {
    content.saveFromForm(req.body);
    return res.redirect('/admin/content?saved=1');
  } catch (err) {
    console.error('Не удалось сохранить содержимое:', err);
    return res.redirect('/admin/content?error=' + encodeURIComponent('Не удалось сохранить: ' + err.message));
  }
});

// Загрузка картинок для лендинга. Отдельный обработчик от основного
// загрузчика моделей: сюда допускаем только изображения, потому что
// результат попадает в разметку сайта.
const multer = require('multer');

const imgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, contentImgDir),
  filename: (req, file, cb) => {
    // Имя файла задаёт пользователь, поэтому оставляем только
    // безопасный набор символов и добавляем своё расширение.
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    const safe = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'].includes(ext) ? ext : '.png';
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image';
    cb(null, base + '-' + Date.now().toString(36) + safe);
  },
});

const imgUpload = multer({
  storage: imgStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) return cb(null, true);
    return cb(new Error('Можно загружать только картинки'));
  },
});

router.post('/upload', imgUpload.single('image'), (req, res) => {
  if (!req.file) {
    return res.redirect('/admin/content?error=' + encodeURIComponent('Файл не получен'));
  }
  const slot = String(req.body.slot || 'hero');
  const allowed = ['logo', 'hero', 'ogImage'];
  if (!allowed.includes(slot)) {
    fs.unlink(req.file.path, () => {});
    return res.redirect('/admin/content?error=' + encodeURIComponent('Неизвестный слот картинки'));
  }
  const current = content.read();
  current.images[slot] = '/content/' + req.file.filename;
  content.save(current);
  res.redirect('/admin/content?saved=1');
});

// Сброс к заводским значениям. Отдельная кнопка, потому что заполнить
// заново форму руками — муторно, а дефолты как раз для этого случая.
router.post('/reset', (req, res) => {
  content.save(JSON.parse(JSON.stringify(content.DEFAULTS)));
  res.redirect('/admin/content?saved=1');
});

module.exports = router;
