// Живая проверка писем при регистрации и восстановления пароля:
// поднимает сервер с MAIL_DRY_RUN, прогоняет сценарий настоящими
// HTTP-запросами и читает письма из журнала сервера. Запуск:
//   node test/password-live.js
//
// Реальный SMTP здесь не нужен и не подключается намеренно: проверка
// не должна слать письма по-настоящему, а MAIL_DRY_RUN печатает их
// в журнал, где их и видно.

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode/password-test';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

let cookie = '';

function portBusy() {
  return new Promise(resolve => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(PORT, '127.0.0.1');
  });
}

function req(method, url, form) {
  return new Promise((resolve, reject) => {
    const body = form
      ? Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : null;
    const u = new URL(BASE + url);
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({
        status: res.statusCode, location: res.headers.location, body: data,
      }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
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

// Письмо из журнала: последнее с нужным заголовком.
function lastMail(log, subject) {
  const parts = log.split(`[MAIL_DRY_RUN] ${subject}`);
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

function tokenFromMail(log, subject) {
  const mail = lastMail(log, subject);
  const m = mail && mail.match(/(\/password\/set\?token=[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

(async () => {
  const { rmSync, mkdirSync, copyFileSync } = require('fs');

  if (await portBusy()) {
    console.log(`  ПОРТ ${PORT} занят другим процессом — тест не запущен.`);
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'db'), { recursive: true });
  mkdirSync(path.join(TMP, 'up'), { recursive: true });
  const contentDir = path.join(TMP, 'content');
  mkdirSync(contentDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'content', 'site.json'), path.join(contentDir, 'site.json'));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_DIR: path.join(TMP, 'db'),
      UPLOAD_DIR: path.join(TMP, 'up'),
      CONTENT_DIR: contentDir,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
      SESSION_SECRET: 'password-test-secret',
      PUBLIC_ORIGIN: 'https://www.ztbase.ru',
      // Письма печатаются в журнал вместо отправки: SMTP-сервер в
      // проверке не нужен, а настоящие письма никто не должен получить.
      MAIL_DRY_RUN: '1',
      SMTP_FROM: 'ZT Lab <noreply@ztbase.ru>',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const done = code => { try { server.kill('SIGKILL'); } catch {} process.exit(code); };

  try {
    if (!await waitReady()) { console.log('сервер не поднялся:\n' + serverLog); return done(1); }

    // 1. Регистрация: письмо с данными для входа уходит на указанную почту.
    const reg = await req('POST', '/register-lab', {
      lab_name: 'Почтовая Лаб', slug: 'pochta', username: 'Иван',
      password: 'Пароль123', email: 'ivan@example.com', phone: '+7 900 000-00-00',
    });
    check('регистрация прошла', reg.status === 302, `HTTP ${reg.status}`);

    const welcome = lastMail(serverLog, 'ZT Lab: вход для вашей лаборатории');
    check('письмо при регистрации отправлено на указанный адрес',
      Boolean(welcome) && welcome.includes('ivan@example.com'));
    check('в письме есть адрес лаборатории и имя',
      Boolean(welcome) && welcome.includes('pochta') && welcome.includes('Иван'));
    check('в письме нет пароля', Boolean(welcome) && !welcome.includes('Пароль123'));
    check('в письме есть одноразовая ссылка', Boolean(welcome) && /\/password\/set\?token=/.test(welcome));
    check('ссылка в письме ведёт на публичный домен',
      Boolean(welcome) && welcome.includes('https://www.ztbase.ru/password/set'));

    // 2. Регистрация без почты не должна падать: письмо не уйдёт,
    //    но человек всё равно заведён.
    const regNoMail = await req('POST', '/register-lab', {
      lab_name: 'Без почты', slug: 'bezpochty', username: 'Пётр',
      password: 'Пароль123', phone: '+7 900 111-22-33',
    });
    check('регистрация без e-mail не проходит', regNoMail.status === 400, `HTTP ${regNoMail.status}`);

    // 3. Запрос ссылки на восстановление.
    const resetPage = await req('GET', '/password/reset?lab=pochta');
    check('страница восстановления открывается', resetPage.status === 200);
    check('на странице восстановления есть форма', resetPage.body.includes('action="/password/reset"'));

    const asked = await req('POST', '/password/reset', { lab_slug: 'pochta', username: 'Иван' });
    check('запрос ссылки отвечает нейтрально', asked.status === 200 && asked.body.includes('Если такая лаборатория'));
    const resetMail = lastMail(serverLog, 'ZT Lab: ссылка для входа');
    check('письмо со ссылкой отправлено', Boolean(resetMail) && resetMail.includes('ivan@example.com'));
    check('в письме восстановления нет пароля', Boolean(resetMail) && !resetMail.includes('Пароль123'));

    // Чужая лаборатория и несуществующий сотрудник выглядят так же.
    const stranger = await req('POST', '/password/reset', { lab_slug: 'pochta', username: 'Нету' });
    check('несуществующий сотрудник не выдаёт себя ответом',
      stranger.status === 200 && stranger.body.includes('Если такая лаборатория'));
    const mailsAfterStranger = (serverLog.match(/\[MAIL_DRY_RUN\]/g) || []).length;
    check('несуществующему сотруднику письмо не уходит', mailsAfterStranger === 2,
      `писем в журнале: ${mailsAfterStranger}`);

    // 4. Ссылка одноразовая и работает один раз.
    const resetPath = tokenFromMail(serverLog, 'ZT Lab: ссылка для входа');
    const setPage = await req('GET', resetPath);
    check('по ссылке открывается форма пароля',
      setPage.status === 200 && setPage.body.includes('action="/password/set"'));

    const short = await req('POST', '/password/set', { token: new URL(BASE + resetPath).searchParams.get('token'), password: '123' });
    check('короткий пароль отклоняется', short.status === 400 && short.body.includes('короче 6'));

    const mismatch = await req('POST', '/password/set', {
      token: new URL(BASE + resetPath).searchParams.get('token'), password: 'Пароль123', password2: 'Другой1',
    });
    check('несовпадение паролей отклоняется', mismatch.status === 400 && mismatch.body.includes('не совпадают'));

    const saved = await req('POST', '/password/set', {
      token: new URL(BASE + resetPath).searchParams.get('token'), password: 'НовыйПароль9', password2: 'НовыйПароль9',
    });
    check('пароль сохранён', saved.status === 200 && saved.body.includes('Пароль изменён'));

    const reuse = await req('GET', resetPath);
    check('ссылка не работает второй раз', reuse.status === 400 && reuse.body.includes('недействительна'));

    // 5. Вход новым паролем, старый больше не подходит.
    const withNew = await req('POST', '/set-user', { lab_slug: 'pochta', username: 'Иван', password: 'НовыйПароль9' });
    check('вход с новым паролем', withNew.status === 302 && withNew.location === '/orders', `HTTP ${withNew.status}`);
    const withOld = await req('POST', '/set-user', { lab_slug: 'pochta', username: 'Иван', password: 'Пароль123' });
    check('старый пароль больше не подходит', withOld.status === 401, `HTTP ${withOld.status}`);

    // 6. В базе нет ни пароля, ни ссылки открытым текстом.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(TMP, 'db', 'exo.db'));
    const rows = db.prepare('SELECT token_hash FROM password_resets').all();
    check('ссылки хранятся хэшами, а не открытым текстом',
      rows.length > 0 && rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash)));
    check('в базе нет пароля открытым текстом',
      !JSON.stringify(db.prepare('SELECT * FROM users').all()).includes('НовыйПароль9'));

    // 7. Ограничение попыток: письма не рассыпаются.
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const r = await req('POST', '/password/reset', { lab_slug: 'pochta', username: 'Иван' });
      if (r.status === 429) { limited = true; break; }
    }
    check('частые запросы ссылок ограничиваются', limited);

    const failed = results.filter(r => !r.ok);
    console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
    if (failed.length) {
      console.log('\n  Лог сервера:');
      console.log(serverLog.split('\n').slice(-14).map(l => '    ' + l).join('\n'));
    }
    return done(failed.length ? 1 : 0);
  } catch (e) {
    console.error('ошибка теста:', e);
    console.log(serverLog.split('\n').slice(-14).map(l => '  ' + l).join('\n'));
    return done(1);
  }
})();
