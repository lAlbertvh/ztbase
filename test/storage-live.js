// Живая проверка лимита хранилища: поднимает сервер с крошечной квотой
// и грузит файлы по-настоящему. Запуск:
//   node test/storage-live.js
//
// Юнит-тесты доказывают арифметику сервиса, но не доказывают, что
// маршрут /upload вообще откажет и не оставит файл на диске. Именно
// это здесь и проверяется, поэтому обойтись без HTTP-запросов нельзя.

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_STORAGE_PORT) || 3203;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode/storage-live-test';
const UPLOADS = path.join(TMP, 'up');

const MB = 1024 * 1024;
// Квота заметно больше одного файла и заметно меньше двух: проверка
// идёт без граничных значений, где спотыкается о точность float.
const QUOTA_BYTES = Math.round(1.5 * MB);
const FILE_BYTES = MB;

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

let cookie = '';

function portBusy() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(PORT, '127.0.0.1');
  });
}

function req(method, url, form) {
  return new Promise((resolve, reject) => {
    const body = form
      ? Object.entries(form).map(([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : null;
    const u = new URL(BASE + url);
    const headers = { Cookie: cookie };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers,
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, location: res.headers.location, body: data });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Загрузка файла как из формы: multer разбирает multipart, поэтому
// обычный urlencoded-хелпер не подходит.
function uploadStl(filename, sizeBytes) {
  return new Promise((resolve, reject) => {
    const boundary = '----ztlabstorage' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="stlFiles"; filename="${filename}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, Buffer.alloc(sizeBytes, 0x41), tail]);
    const u = new URL(BASE + '/upload');
    const r = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: '/upload',
      headers: {
        Cookie: cookie,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

async function waitReady(timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await req('GET', '/health')).status === 200) return true;
    } catch { /* сервер ещё не слушает */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Сколько файлов реально лежит на диске у лаборатории.
function filesOnDisk(labId) {
  const dir = path.join(UPLOADS, String(labId));
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function diskBytes(labId) {
  return filesOnDisk(labId)
    .reduce((sum, n) => sum + fs.statSync(path.join(UPLOADS, String(labId), n)).size, 0);
}

// Текст строки «Занято …» из интерфейса. Регулярка ищет сам блок, а не
// просто слово «Занято»: то же слово есть в комментарии в CSS, и
// дешёвая проверка попадала бы в стили, а не в страницу.
function usageLine(html) {
  const m = html.match(/class="storage-usage[^"]*"[^>]*>([\s\S]{0,160}?)<\/div>/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function usageNear(html) {
  return /class="storage-usage near"/.test(html);
}

// Временные папки multer живут в os.tmpdir(), а не в каталоге теста,
// поэтому смотрим именно туда: утечка на отказе по квоте оставила бы
// там копии файлов и незаметно съедала бы диск.
function tmpUploadDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ztlab-'));
  } catch {
    return [];
  }
}

(async () => {
  if (await portBusy()) {
    console.log(`  ПОРТ ${PORT} занят другим процессом — тест не запущен.`);
    process.exit(1);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'db'), { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  const contentDir = path.join(TMP, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'content', 'site.json'),
    path.join(contentDir, 'site.json'));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_DIR: path.join(TMP, 'db'),
      UPLOAD_DIR: UPLOADS,
      CONTENT_DIR: contentDir,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
      SESSION_SECRET: 'storage-live-secret',
      // Файл должен проходить по размеру: единственная причина отказа
      // в проверке — квота. MAX_FILE_MB с запасом больше файла.
      MAX_FILE_MB: '4',
      STORAGE_QUOTA_GB: String(QUOTA_BYTES / (1024 * MB)),
      // Запас на диске не проверяем: тест про квоту лаборатории, а
      // свободное место машины заведомо есть.
      STORAGE_MIN_FREE_GB: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const done = (code) => { try { server.kill('SIGKILL'); } catch {} process.exit(code); };

  try {
    if (!await waitReady()) { console.log('сервер не поднялся:\n' + serverLog); return done(1); }

    await req('POST', '/register-lab', {
      lab_name: 'Квота Лаб', slug: 'kvota', username: 'Админ',
      password: 'Пароль123', email: 'lab@example.com', phone: '+7 900 000-00-00',
    });
    await req('POST', '/set-user', { lab_slug: 'kvota', username: 'Админ', password: 'Пароль123' });
    await req('POST', '/setup/finish');

    // Номер лаборатории узнаём из базы, а не считаем по порядку: при
    // пустой базе сервер сам создаёт лабораторию по умолчанию, поэтому
    // первая зарегистрированная лаборатория получает id не 1.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(TMP, 'db', 'exo.db'));
    const labId = slug => db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug)?.id;
    const kvotaId = labId('kvota');
    check('id лаборатории читается из базы', Boolean(kvotaId), String(kvotaId));

    // 1. До загрузок на странице уже видно, сколько занято и сколько можно
    const filesPage = await req('GET', '/files');
    check('страница загрузки открывается', filesPage.status === 200, `HTTP ${filesPage.status}`);
    check('занятое место видно до загрузки',
      usageLine(filesPage.body).includes('Занято 0 КБ'), usageLine(filesPage.body));
    check('пустое хранилище не выглядит занятым',
      !usageNear(filesPage.body), 'помечено как близкое к заполнению');

    // 2. Первый файл в квоту помещается
    const first = await uploadStl('pervyy.stl', FILE_BYTES);
    check('первый файл сохраняется', first.status === 302, `HTTP ${first.status} ${first.body.slice(0, 80)}`);
    check('файл действительно лёг на диск', diskBytes(kvotaId) === FILE_BYTES,
      `${diskBytes(kvotaId)} байт`);

    const afterFirst = await req('GET', '/files');
    check('занятое место обновилось',
      usageLine(afterFirst.body).includes('Занято 1,0 МБ из 1,5 МБ'),
      usageLine(afterFirst.body));

    // 3. Добиваем квоту почти вплотную: 96% — предупреждение есть
    const almost = await uploadStl('dozapolyayem.stl', Math.round(0.45 * MB));
    check('файл почти до предела ещё сохраняется', almost.status === 302,
      `HTTP ${almost.status} ${almost.body.slice(0, 80)}`);
    const nearPage = await req('GET', '/files');
    check('у почти заполненного хранилища есть предупреждение',
      usageNear(nearPage.body), usageLine(nearPage.body));

    // 4. Последние 100 КБ в квоту уже не влезают
    const tmpBefore = new Set(tmpUploadDirs());
    const overflow = await uploadStl('posledniy.stl', 100 * 1024);
    check('переполнение отклоняется с кодом 507', overflow.status === 507,
      `HTTP ${overflow.status}`);
    check('в ответе объяснено, что место кончилось',
      overflow.body.includes('место') && overflow.body.includes('Файл не сохранён'),
      overflow.body.slice(0, 90));
    check('на диск не попало ничего лишнего',
      diskBytes(kvotaId) === FILE_BYTES + Math.round(0.45 * MB),
      `${diskBytes(kvotaId)} байт`);
    // Отказ не должен оставлять временные копии файла.
    check('временные папки после отказа убраны',
      tmpUploadDirs().every(n => tmpBefore.has(n)),
      tmpUploadDirs().filter(n => !tmpBefore.has(n)).join(', ') || 'лишних нет');

    // 5. Соседняя лаборатория отказ не наследует: квота своя
    await req('POST', '/register-lab', {
      lab_name: 'Сосед Лаб', slug: 'sosed', username: 'Второй',
      password: 'Пароль123', email: 'sosed@example.com', phone: '+7 900 000-00-01',
    });
    await req('POST', '/set-user', { lab_slug: 'sosed', username: 'Второй', password: 'Пароль123' });
    await req('POST', '/setup/finish');
    const sosedId = labId('sosed');
    const neighbour = await uploadStl('sosedniy.stl', FILE_BYTES);
    check('соседняя лаборатория грузит по своей квоте', neighbour.status === 302,
      `HTTP ${neighbour.status} ${neighbour.body.slice(0, 80)}`);
    check('файл соседа лежит в своей папке', diskBytes(sosedId) === FILE_BYTES,
      `${diskBytes(sosedId)} байт`);
    check('папка соседа не та же, что у первой лаборатории',
      sosedId !== kvotaId, `${sosedId} против ${kvotaId}`);

    const neighbourPage = await req('GET', '/files');
    // Квота у соседа та же, но занято должно быть его собственное —
    // один файл. Если бы считалось по всему хранилищу, здесь стояло бы
    // 2,4 МБ вместе с файлами первой лаборатории.
    check('у соседа своё занятое место, а не общее',
      usageLine(neighbourPage.body).includes('Занято 1,0 МБ'),
      usageLine(neighbourPage.body));
    check('сосед не видит файлы первой лаборатории',
      !neighbourPage.body.includes('pervyy') && !neighbourPage.body.includes('dozapolyayem'),
      'в списке чужой файл');

    db.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
    if (failed.length) {
      console.log('\n  Лог сервера:');
      console.log(serverLog.split('\n').slice(-12).map(l => '    ' + l).join('\n'));
    }
    return done(failed.length ? 1 : 0);
  } catch (e) {
    console.error('ошибка теста:', e);
    console.log(serverLog.split('\n').slice(-12).map(l => '  ' + l).join('\n'));
    return done(1);
  }
})();