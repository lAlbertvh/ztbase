// Живая проверка мастера первичной настройки: /setup
//
// Сервер живёт только внутри этого процесса и работает на временной
// базе, поэтому проверка не зависит от запущенного терминала и не
// трогает рабочие данные. Запуск:
//   node test/setup-live.js

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SETUP_TEST_PORT) || 3198;
const TMP = '/tmp/opencode/setup-test';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

let cookie = '';

function req(method, url, form) {
  return new Promise((resolve, reject) => {
    const body = form
      ? Object.entries(form).map(([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`).join('&')
      : '';
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: url, method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function portBusy() {
  return new Promise(resolve => {
    const net = require('net');
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(PORT, '127.0.0.1');
  });
}

function waitReady() {
  return new Promise(resolve => {
    let tries = 0;
    const tick = () => {
      req('GET', '/health').then(r => r.status === 200 ? resolve(true) : retry())
        .catch(retry);
    };
    const retry = () => (++tries > 80 ? resolve(false) : setTimeout(tick, 100));
    tick();
  });
}

(async () => {
  if (await portBusy()) { console.log('порт занят — не запускаю'); process.exit(1); }

  const fs = require('fs');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'db'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'up'), { recursive: true });
  const contentDir = path.join(TMP, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'content', 'site.json'), path.join(contentDir, 'site.json'));

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
      SESSION_SECRET: 'setup-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const done = (code) => { try { server.kill('SIGKILL'); } catch {} process.exit(code); };

  try {
    if (!await waitReady()) { console.log('сервер не поднялся:\n' + serverLog); return done(1); }

    const Database = require('better-sqlite3');
    const db = new Database(path.join(TMP, 'db', 'exo.db'));

    // 1. Регистрация и вход
    check('регистрация лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Новый век', slug: 'novy-vek', username: 'Сергей', password: 'Пароль123',
        email: 'lab@example.com',
    })).status === 302);

    // 2. Мастер встречает на входе
    const first = await req('GET', '/orders');
    check('после входа открывается мастер, а не наряды',
      first.status === 302 && String(first.location || '').includes('/setup'),
      `HTTP ${first.status} → ${first.location}`);

    const welcome = await req('GET', '/setup');
    check('приветствие мастера', welcome.status === 200 && welcome.body.includes('Приветствуем'));
    check('обещание, что всё можно поменять',
      welcome.body.includes('можно будет изменить'));

    // 3. Представьтесь
    await req('GET', '/setup/about');
    const noName = await req('POST', '/setup/about', { lab_name: 'Новый век', role: 'lab_admin' });
    check('без имени не проходит',
      String(noName.location || '').includes('error='), noName.location);

    const about = await req('POST', '/setup/about', {
      name: 'Сергей', lab_name: 'Новый век', role: 'lab_admin', contact: '+7 900 000-00-00',
    });
    check('шаг «представьтесь» пройден',
      about.status === 302 && String(about.location).includes('/setup/clinics'),
      about.location);

    const lab = db.prepare('SELECT * FROM labs WHERE slug = ?').get('novy-vek');
    check('название и владелец записаны',
      lab.owner_name === 'Сергей' && lab.contact === '+7 900 000-00-00');
    check('роль владельца сохранена',
      db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
        .get(lab.id, 'owner_role').value === 'lab_admin');

    // 4. Клиники и представители
    await req('POST', '/setup/clinics', { name: 'Стоматология Денталь', contact: '+7 901 111-11-11' });
    await req('POST', '/setup/clinics', { name: 'Стоматология Денталь' });
    const clinics = db.prepare('SELECT * FROM clinics WHERE lab_id = ?').all(lab.id);
    check('клиника добавлена один раз, повтор не создал дубль',
      clinics.length === 1, `записей: ${clinics.length}`);

    await req('POST', '/setup/contacts', {
      clinic_id: clinics[0].id, name: 'Анна', role: 'dentist', contact: '+7 902 222-22-22',
    });
    await req('POST', '/setup/contacts', { clinic_id: clinics[0].id, name: '', role: 'dentist' });
    const contacts = db.prepare('SELECT * FROM clinic_contacts WHERE lab_id = ?').all(lab.id);
    check('представитель добавлен, пустое имя отброшено',
      contacts.length === 1 && contacts[0].name === 'Анна', `записей: ${contacts.length}`);

    const clinicsPage = await req('GET', '/setup/clinics');
    check('клиника видна в мастере',
      clinicsPage.body.includes('Стоматология Денталь') && clinicsPage.body.includes('Анна'));

    // 5. Услуги, цены, материалы, цвета
    await req('POST', '/setup/services/construction', { title: 'Коронка цирконовая', price: '1 200,50' });
    await req('POST', '/setup/services/construction', { title: 'Без цены', price: '' });
    const cons = db.prepare("SELECT * FROM constructions WHERE code LIKE '9%' ORDER BY code").all();
    check('работа добавлена с разобранной ценой',
      cons.length === 2 && cons[0].price === 1200.5);
    check('работа без цены сохраняется с пустой ценой', cons[1].price === null);
    check('свои работы попали в отдельную группу',
      db.prepare('SELECT title FROM construction_groups WHERE code = ?').get('own').title === 'Свои услуги');

    await req('POST', '/setup/services/material', { name: 'Циркон Zirkonzahn', category: 'керамика', unit: 'диск' });
    const mats = db.prepare('SELECT * FROM materials WHERE lab_id = ?').all(lab.id);
    check('материал добавлен', mats.length === 1 && mats[0].name === 'Циркон Zirkonzahn');

    await req('POST', '/setup/services/colors', { colors: 'A1, A2, A3, C2' });
    check('цвета сохранены',
      db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
        .get(lab.id, 'colors').value === 'A1,A2,A3,C2',
      db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
        .get(lab.id, 'colors').value);

    // 6. Команда и тариф
    const staff = await req('GET', '/setup/staff');
    check('шаг команды показывает счётчик тарифа',
      staff.body.includes('Основной') && staff.body.includes('мест'));

    await req('POST', '/setup/staff', { name: 'Мария', role: 'tech', password: 'Пароль123' });
    await req('POST', '/setup/staff', { name: 'Мария', role: 'tech', password: 'Пароль123' });
    await req('POST', '/setup/staff', { name: 'Иван', role: 'dentist', password: '123' });
    const users = db.prepare('SELECT * FROM users WHERE lab_id = ?').all(lab.id);
    check('сотрудник добавлен, дубль и короткий пароль отброшены',
      users.length === 2, `сотрудников: ${users.length}`);

    // Мест 5, занято 3: Сергей, Мария и представитель клиники Анна.
    // Предупреждения быть не должно — человек ещё помещается.
    const roomy = await req('GET', '/setup/staff');
    check('счётчик считает сотрудников и представителей клиник',
      roomy.body.includes('занято 3') && roomy.body.includes('представителей клиник 1'));
    check('пока места есть, предупреждения нет',
      !roomy.body.includes('сверх тарифа') && !roomy.body.includes('больше, чем 5'));

    // Добиваем до превышения: должно пустить и показать предупреждение.
    for (const n of ['Пётр', 'Ольга', 'Дарья']) {
      await req('POST', '/setup/staff', { name: n, role: 'tech', password: 'Пароль123' });
    }
    const after = db.prepare('SELECT COUNT(*) AS n FROM users WHERE lab_id = ? AND active = 1').get(lab.id).n;
    check('лимит не блокирует добавление людей', after === 5, `сотрудников: ${after}`);
    const overPage = await req('GET', '/setup/staff');
    check('при превышении показано предупреждение',
      overPage.body.includes('больше, чем 5') || overPage.body.includes('превышение'));

    // 7. Завершение
    check('кнопка «завершить» работает', (await req('POST', '/setup/finish')).status === 302);
    const orders = await req('GET', '/orders');
    check('после настройки открываются наряды, а не мастер',
      orders.status === 200 && !String(orders.body).includes('Приветствуем'),
      `HTTP ${orders.status}`);

    const admin = await req('GET', '/admin');
    check('админка доступна после настройки', admin.status === 200);

    // 8. Мастер не блокирует врача, если администратор ещё не закончил
    // Врача добавляем с нормальным паролем: Иван с коротким паролем выше
    // был отклонён, и вход под ним просто не удался бы.
    await req('POST', '/setup/staff', { name: 'Дмитрий', role: 'dentist', password: 'Пароль456' });
    const lab2db = db.prepare('SELECT id FROM labs WHERE slug = ?').get('novy-vek');
    db.prepare('UPDATE labs SET setup_done = 0 WHERE id = ?').run(lab2db.id);
    const dLogin = await req('POST', '/set-user', {
      lab_slug: 'novy-vek', username: 'Дмитрий', password: 'Пароль456',
    });
    check('вход врача', dLogin.status === 302, `HTTP ${dLogin.status}`);
    const dentist = await req('GET', '/orders');
    check('врача незавершённая настройка не уводит в мастер',
      dentist.status === 200, `HTTP ${dentist.status} → ${dentist.location}`);

  } catch (e) {
    console.log('исключение: ' + e.message);
    console.log(serverLog);
    return done(1);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
  if (failed.length) {
    console.log('  Провалено: ' + failed.map(f => f.name).join(', '));
    console.log(serverLog.split('\n').slice(-20).join('\n'));
  }
  done(failed.length ? 1 : 0);
})();