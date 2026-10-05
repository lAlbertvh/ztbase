// Конфигурация приложения: пути, порт, лимиты.
//
// Вынесено из server.js, чтобы модули маршрутов и сервисы не зависели от
// того, где именно лежит код. Разница важна для сборки в исполняемый
// файл: внутри pkg templates лежат по внутреннему пути бандла (__dirname),
// а данные — рядом с самим .exe. В разработке и то и другое совпадает,
// поэтому ошибку в этой логике не видно до момента сборки.
//
// Пути с данными по умолчанию лежат рядом с кодом — удобно при
// разработке. В бою их выносят в отдельный каталог (например
// /var/lib/ztlab): тогда обновление кода через git или rsync не задевает
// данные, а резервную копию снять проще — одной командой.

const path = require('path');
const fs = require('fs');

// Корневая папка приложения. В собранном exe (pkg) данные кладутся рядом
// с исполняемым файлом, в dev-режиме — рядом с исходниками.
// Этот файл лежит в src/, поэтому на уровень выше — корень проекта
// (path.resolve(__dirname, '..')), а на два — уже родительская папка.
const appRoot = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');

// Папка с шаблонами: в exe — внутри бандла (__dirname), в dev — как обычно.
const viewsDir = process.pkg
  ? path.join(__dirname, '..', 'views')
  : path.join(appRoot, 'views');

// Папка со статикой: манифест, иконки, service worker.
const publicDir = process.pkg
  ? path.join(__dirname, '..', 'public')
  : path.join(appRoot, 'public');

const uploadDir = path.resolve(
  process.env.UPLOAD_DIR || path.join(appRoot, 'uploads')
);
const dbDir = path.resolve(
  process.env.DB_DIR || path.join(appRoot, 'database')
);

// Промежуточные файлы при загрузке. В системном сервисе путь задаётся
// переменной: с ProtectSystem=strict писать внутрь /opt нельзя,
// поэтому временные файлы живут рядом с базой.
const tmpUploadDir = process.env.TMP_UPLOAD_DIR
  || path.join(appRoot, 'tmp-uploads');

// Публичные файлы и тексты лендинга. Картинки, загруженные через
// /admin/content, по умолчанию ложатся в public/content: адрес прежний —
// /public/content, — чтобы значения, уже сохранённые в site.json,
// продолжали работать. В бою CONTENT_IMG_DIR переопределяет путь на
// каталог данных (/var/lib/ztlab/content/img), потому что с
// ProtectSystem=strict в /opt вообще нельзя писать, а обновление через
// deploy.sh не должно затирать загруженное.
const contentDir = process.env.CONTENT_DIR || path.join(appRoot, 'content');
const contentImgDir = path.resolve(
  process.env.CONTENT_IMG_DIR || path.join(publicDir, 'content')
);

const PORT = process.env.PORT || 3000;
// Адрес, который слушает приложение. В бою — только 127.0.0.1:
// перед приложением стоит nginx с TLS, и наружу порт не открывается.
const HOST = process.env.HOST || '127.0.0.1';

// Предел на один загружаемый файл. Без него любой вошедший сотрудник
// мог залить на диск файл любого размера и забить машину. 100 МБ —
// с запасом для сканирования в высоком разрешении.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);

// Каталоги создаются сразу при загрузке модуля: и сервер, и живые
// тесты поднимают приложение, и оба рассчитывают, что папки уже есть.
for (const dir of [uploadDir, dbDir, tmpUploadDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  appRoot,
  viewsDir,
  publicDir,
  uploadDir,
  dbDir,
  tmpUploadDir,
  contentDir,
  contentImgDir,
  PORT,
  HOST,
  MAX_FILE_MB,
  // Секрет для подписи cookie обязателен в production: с ключом из
  // примера любой может подделать сессию администратора.
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  COOKIE_SECURE: process.env.COOKIE_SECURE,
};