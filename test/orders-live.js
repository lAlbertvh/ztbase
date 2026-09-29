// Живая проверка заказ-нарядов: поднимает сервер, прогоняет сценарий
// через настоящие HTTP-запросы и гасит сервер. Запуск:
//   node test/orders-live.js
//
// Сервер живёт только внутри этого процесса, поэтому проверка не
// зависит от того, как запущен терминал.

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 3197;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode/live-test';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

let cookie = '';

// Порт должен быть свободен. Если его держит прошлый запуск теста,
// на запросы ответит чужой процесс с чужой базой — и проверка будет
// падать с вводящим в заблуждение 500 вместо честной ошибки.
function portBusy() {
  return new Promise(resolve => {
    const net = require('net');
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
          Array.isArray(v)
            ? v.map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`).join('&')
            : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
        ).join('&')
      : null;
    const u = new URL(BASE + url);
    const headers = { Cookie: cookie };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
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

async function waitReady(timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200) return true;
    } catch { /* сервер ещё не слушает */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  const { rmSync, mkdirSync } = require('fs');

  // Порт проверяем до запуска: иначе наш сервер не сможет занять
  // занятый порт, упадёт при старте, а отвечать на запросы будет
  // чужой процесс с чужой базой.
  if (await portBusy()) {
    console.log(`  ПОРТ ${PORT} занят другим процессом — тест не запущен.`);
    console.log(`  Освободите порт или запустите с другим: TEST_PORT=3200 npm test`);
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'db'), { recursive: true });
  mkdirSync(path.join(TMP, 'up'), { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_DIR: path.join(TMP, 'db'),
      UPLOAD_DIR: path.join(TMP, 'up'),
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
      SESSION_SECRET: 'live-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const done = (code) => { try { server.kill('SIGKILL'); } catch {} process.exit(code); };

  try {
    if (!await waitReady()) { console.log('сервер не поднялся:\n' + serverLog); return done(1); }

    // 1. Лаборатория и вход
    check('регистрация лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Тест Лаб', slug: 'testlab', username: 'Админ', password: 'Пароль123',
    })).status === 302);
    check('вход сотрудника', (await req('POST', '/set-user', {
      lab_slug: 'testlab', username: 'Админ', password: 'Пароль123',
    })).status === 302);

    // 2. Наряд
    const created = await req('POST', '/orders', {
      order_number: 'Н-1001', customer: 'Клиника Весна', patient: 'Иванов И.И.',
      phone: '+7 900 000-00-00', teeth: '16,15 14 21', work_kind: 'bridge',
      material: 'Циркон', color: 'A2', incoming: ['impression', 'model'],
      delivery: 'plaster', comment: 'Мост на 4 единицы', flags: 'try_in',
      material_name: 'Диск циркон', material_qty: '1', material_unit: 'шт',
    });
    check('создание наряда', created.status === 302 && /\/orders\/\d+/.test(created.location || ''),
      created.location || created.status);

    const id = (created.location || '').match(/(\d+)$/)?.[1];

    // 3. Дубликат номера
    const dup = await req('POST', '/orders', { order_number: 'Н-1001', teeth: '11' });
    check('отказ дубля номера в лаборатории', dup.status === 400, dup.body.slice(0, 60));

    // 4. Пустая зубная формула
    const noTeeth = await req('POST', '/orders', { order_number: 'Н-1002' });
    check('отказ наряда без зубов', noTeeth.status === 400, noTeeth.body.slice(0, 60));

    // 4б. Несуществующие в формуле номера: 19, 20, 29, 30, 39, 40
    // не относятся ни к одному квадранту и молча отбрасываются.
    const badTeeth = await req('POST', '/orders', {
      order_number: 'Н-1003', teeth: '19,20,29,30,39,40',
    });
    check('отказ наряда только с несуществующими зубами', badTeeth.status === 400,
      badTeeth.body.slice(0, 60));
    const mixedTeeth = await req('POST', '/orders', {
      order_number: 'Н-1004', teeth: '16,19,21',
    });
    check('частично верная формула принимается', mixedTeeth.status === 302,
      mixedTeeth.location || mixedTeeth.status);
    if (mixedTeeth.status === 302) {
      const badId = (mixedTeeth.location || '').match(/(\d+)$/)?.[1];
      const badCard = await req('GET', `/orders/${badId}`);
      check('несуществующий зуб 19 не попал в наряд',
        !badCard.body.includes('>19<') && badCard.body.includes('16'));
    }

    // 4в. Редактирование. Проверяем, что занятый номер не роняет
    // страницу в 500, а даёт понятный отказ, и что свой номер
    // сохранить можно — иначе любое редактирование без смены номера
    // было бы невозможно. Занятый номер берём у наряда Н-1004,
    // который выше действительно создался.
    const editDup = await req('POST', '/orders', {
      id: String(id), order_number: 'Н-1004', teeth: '16',
    });
    check('отказ при редактировании на занятый номер', editDup.status === 400,
      `HTTP ${editDup.status} ${editDup.body.slice(0, 50)}`);

    // Форма наряда сохраняется целиком, поэтому при редактировании
    // повторяем заполненные поля — иначе они затрутся пустыми.
    const editSelf = await req('POST', '/orders', {
      id: String(id), order_number: 'Н-1001', customer: 'Клиника Весна',
      patient: 'Иванов И.И.', phone: '+7 900 000-00-00',
      teeth: '16,15,14,21', work_kind: 'bridge', material: 'Циркон', color: 'A2',
      comment: 'Уточнён', material_name: 'Диск циркон', material_qty: '1', material_unit: 'шт',
    });
    check('редактирование с сохранением своего номера', editSelf.status === 302,
      editSelf.location || editSelf.status);
    const edited = await req('GET', `/orders/${id}`);
    check('изменения сохранились', edited.body.includes('Уточнён'));
    check('номер наряда не сбился', edited.body.includes('Н-1001'));

    // 5. Страницы
    for (const [name, url] of [
      ['список нарядов', '/orders'],
      ['форма нового наряда', '/orders/new'],
      ['карточка наряда', `/orders/${id}`],
      ['печатная форма', `/orders/${id}/print`],
      ['справочник материалов', '/orders/catalog/materials'],
    ]) {
      const r = await req('GET', url);
      check(`страница: ${name}`, r.status === 200, `HTTP ${r.status}`);
    }

    // 6. Данные реально попали в страницу
    const card = await req('GET', `/orders/${id}`);
    check('на карточке виден номер наряда', card.body.includes('Н-1001'));
    check('на карточке видны зубы', card.body.includes('16') && card.body.includes('21'));
    check('на карточке виден материал', card.body.includes('Диск циркон'));
    check('на карточке виден заказчик', card.body.includes('Клиника Весна'));

    const print = await req('GET', `/orders/${id}/print`);
    check('в печати есть журнал этапов', print.body.includes('Журнал этапов'));
    check('в печати есть блок подписей', print.body.includes('Проверил администратор'));

    // 7. Этап и материал
    check('добавление этапа с заметкой', (await req('POST', `/orders/${id}/stage`, {
      stage: 'milled', note: 'Фрезерование начато',
    })).status === 302);
    const afterStage = await req('GET', `/orders/${id}`);
    check('этап виден в журнале', afterStage.body.includes('Фрезерование'));
    check('заметка видна в журнале', afterStage.body.includes('Фрезерование начато'));

    check('добавление материала в наряд', (await req('POST', `/orders/${id}/material`, {
      name: 'Порошок циркония', qty: '45', unit: 'г',
    })).status === 302);

    // 8. Старые экраны не должны сломаться. Проверяем, пока сессия
    // ещё в своей лаборатории: после смены лаборатории они тоже
    // закроются на /login и сказать ничего не смогут.
    const home = await req('GET', '/');
    check('главная страница открывается', home.status === 200, `HTTP ${home.status}`);
    check('на главной есть ссылка на заказ-наряды', home.body.includes('href="/orders"'));
    check('главная показывает имя сотрудника', home.body.includes('Админ'));
    for (const [name, url] of [
      ['титановые основания', '/titan'],
      ['добавление пользователя', '/add-user'],
      ['форма наряда с выбором материала', '/orders/new'],
    ]) {
      const r = await req('GET', url);
      check(`старый экран: ${name}`, r.status === 200, `HTTP ${r.status}`);
    }

    // 9. Пагинация. Проверяем до смены лаборатории, иначе сессия
    // уже принадлежит другой лаборатории и наряд не найдётся.
    await req('POST', '/set-user', { lab_slug: 'testlab', username: 'Админ', password: 'Пароль123' });
    const many = await req('GET', '/orders?limit=1');
    check('пагинация отдаёт страницу', many.status === 200, `HTTP ${many.status}`);

    // 10. Изоляция лабораторий. 404 — правильный ответ: наряд другой
    // лаборатории не должен ни открываться, ни угадываться по коду.
    const other = await req('POST', '/register-lab', {
      lab_name: 'Чужая', slug: 'otherlab', username: 'Чужой', password: 'Пароль456',
    });
    check('регистрация второй лаборатории', other.status === 302);
    const cross = await req('GET', `/orders/${id}`);
    check('чужой наряд не отдаётся другой лаборатории', cross.status === 404, `HTTP ${cross.status}`);

    // Номер наряда уникален внутри лаборатории, а не глобально:
    // в соседней лаборатории такой же номер заводится свободно.
    const sameNumber = await req('POST', '/orders', { order_number: 'Н-1001', teeth: '11' });
    check('тот же номер в другой лаборатории заводится', sameNumber.status === 302,
      sameNumber.location || sameNumber.status);


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
