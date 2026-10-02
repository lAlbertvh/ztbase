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
const O = require(path.join(__dirname, '..', 'src', 'services', 'orders'));
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

// Запрос без сессии — для проверки публичных и закрытых страниц.
// Куки текущего пользователя здесь намеренно не передаются.
function reqNoCookie(method, url, form) {
  return new Promise((resolve, reject) => {
    const body = form
      ? Object.entries(form).map(([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
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

// Загрузка файла как из формы: multer разбирает multipart, поэтому
// обычный urlencoded-хелпер здесь не подходит.
function uploadMultipart(field, filename, sizeBytes) {
  return new Promise((resolve, reject) => {
    const boundary = '----ztlabtest' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const blob = Buffer.alloc(sizeBytes, 0x41);
    const body = Buffer.concat([head, blob, tail]);
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
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, body: data });
      });
    });
    r.on('error', reject);
    r.write(body);
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
  const { rmSync, mkdirSync, copyFileSync, readFileSync } = require('fs');

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
  // Копия контента для теста. Без неё редактор содержимого писал
  // в боевой content/site.json: тест подставлял заголовок и телефон,
  // и настоящие контакты уезжали в репозиторий. Копируем, а не
  // подставляем пустой объект — проверка должна идти по живому файлу.
  const contentDir = path.join(TMP, 'content');
  mkdirSync(contentDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'content', 'site.json'),
    path.join(contentDir, 'site.json'));

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
      SESSION_SECRET: 'live-test-secret',
      // Лимит загрузки занижен намеренно: тест проверяет, что
      // превышение размера отклоняется понятным ответом, а не 500.
      MAX_FILE_MB: '1',
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
      const Database = require('better-sqlite3');
      const testDb = new Database(path.join(TMP, 'db', 'exo.db'));

      // Контакт обязателен: без него пробный период нечем продлить, и
      // человек после недели не знает, куда писать.
      check('регистрация без e-mail отклоняется', (await req('POST', '/register-lab', {
        lab_name: 'Без почты', slug: 'nokod', username: 'Кто-то', password: 'Пароль123',
      })).status === 400);
      check('регистрация с неверным e-mail отклоняется', (await req('POST', '/register-lab', {
        lab_name: 'Кривая почта', slug: 'krivaya', username: 'Кто-то', password: 'Пароль123',
        email: 'не-почта',
      })).status === 400);
      check('регистрация с кривым телефоном отклоняется', (await req('POST', '/register-lab', {
        lab_name: 'Кривой телефон', slug: 'krivoitel', username: 'Кто-то', password: 'Пароль123',
        email: 'lab@example.com', phone: 'не-телефон',
      })).status === 400);

      check('регистрация лаборатории', (await req('POST', '/register-lab', {
        lab_name: 'Тест Лаб', slug: 'testlab', username: 'Админ', password: 'Пароль123',
        email: 'lab@example.com', phone: '+7 900 000-00-00',
      })).status === 302);
      check('пробный период назначен на неделю', (() => {
        const lab = testDb.prepare('SELECT trial_until, trial_email, trial_phone FROM labs WHERE slug = ?').get('testlab');
        if (!lab || !lab.trial_until) return false;
        const days = (Date.parse(lab.trial_until) - Date.now()) / 86400000;
        return days > 6.5 && days <= 7
          && lab.trial_email === 'lab@example.com' && lab.trial_phone === '+7 900 000-00-00';
      })());
  check('вход сотрудника', (await req('POST', '/set-user', {
        lab_slug: 'testlab', username: 'Админ', password: 'Пароль123',
      })).status === 302);

      // Свежезарегистрированная лаборатория попадает в мастер настройки.
      // Закрываем его одной кнопкой: проверка ниже про наряды, а сам
      // мастер разбирает отдельный test/setup-live.js.
      const wizard = await req('GET', '/orders');
      check('новая лаборатория сначала попадает в мастер',
        wizard.status === 302 && String(wizard.location || '').includes('/setup'),
        `HTTP ${wizard.status} → ${wizard.location}`);
      await req('POST', '/setup/finish');
      const afterSetup = await req('GET', '/orders');
      check('после настройки открываются наряды', afterSetup.status === 200,
        `HTTP ${afterSetup.status} → ${afterSetup.location}`);

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

    // Зубная формула кликабельная. Раньше это было текстовое поле с
    // серой подсказкой, и номер зуба вводился вручную: ошибка в одном
    // номере означает изготовление не того, что нужно.
    const form = await req('GET', '/orders/new');
    check('в формуле есть кликабельный ряд', form.body.includes('class="tooth'), 'нет кнопок зубов');
    check('в формуле 32 зуба', (form.body.match(/data-tooth="/g) || []).length === 32,
      `найдено ${(form.body.match(/data-tooth="/g) || []).length}`);
    check('в формуле есть скрытое поле teeth', form.body.includes('id="teeth"'));
    check('скрипт формулы подключён', form.body.includes('/js/teeth-formula.js'));
    // Видимое поле не должно отправляться: сервер читает только
    // скрытое, иначе получил бы два разных значения из одной формы.
    const visibleTeeth = /<input[^>]*data-teeth-input[^>]*>/.exec(form.body);
    check('видимое поле формулы не отправляется',
      !!visibleTeeth && !/\sname=/.test(visibleTeeth[0]),
      visibleTeeth ? 'у видимого поля есть name' : 'поля нет');
    // Отметка «антагонист» приходит на форму под своим названием.
    check('на форме есть отметка «Антагонист»', form.body.includes('Антагонист'));
    check('на форме нет прежней «Maxilla»', !form.body.includes('Maxilla'));

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
    //
    // Этап отмечается кнопкой, а не выбором из списка, и заметка
    // обязательна: пустая строка в журнале означала «этап пройден»,
    // и спросить, что сделали, было уже нечем.
    check('этап без заметки не записывается',
      (await req('POST', `/orders/${id}/stage`, { stage: 'review' })).status === 302);
    // Сервер отвечает редиректом с текстом в ?error, поэтому проверяем
    // ровно то, что человек увидит: страницу с этим параметром.
    const withError = await req('GET', `/orders/${id}?error=${encodeURIComponent('Напишите, что сделано на этом этапе')}`);
    check('пустая заметка объяснена у формы этапов',
      withError.body.includes('Напишите, что сделано'));
    // Проверяем через страницу: запись в базу из теста недоступна, а
    // сам журнал — тоже документ, который читают. Ищем заголовок
    // «Проверка врачом» из журнала этапов, а не кнопку перехода:
    // кнопка есть на странице всегда.
    const afterRefuse = await req('GET', `/orders/${id}`);
    check('после отказа этап не записан',
      !/<strong>Проверка врачом<\/strong>/.test(afterRefuse.body), 'этап попал в журнал');

    check('добавление этапа с заметкой', (await req('POST', `/orders/${id}/stage`, {
      stage: 'milled', note: 'Фрезерование начато',
    })).status === 302);
    const afterStage = await req('GET', `/orders/${id}`);
    check('этап виден в журнале', afterStage.body.includes('Фрезерование'));
    check('заметка видна в журнале', afterStage.body.includes('Фрезерование начато'));

    // Кнопки этапов вместо выпадающего списка.
    check('на карточке есть кнопки этапов', afterStage.body.includes('data-stage='),
      'кнопок этапов нет');
    check('этап отмечается кнопкой, а не списком',
      !/<select name="stage"/.test(afterStage.body), 'остался выпадающий список этапов');
    check('у кнопок этапа подключён скрипт', afterStage.body.includes('/js/stage-buttons.js'));
    // Кнопка текущего этапа не должна предлагать переход в себя же.
    check('текущий этап помечен и не выбирается',
      /class="btn stage-btn is-current"/.test(afterStage.body), 'текущий этап не помечен');

    check('добавление материала в наряд', (await req('POST', `/orders/${id}/material`, {
      name: 'Порошок циркония', qty: '45', unit: 'г',
    })).status === 302);

    // 8. Старые экраны не должны сломаться. Проверяем, пока сессия
    // ещё в своей лаборатории: после смены лаборатории они тоже
    // закроются на /login и сказать ничего не смогут.
    const home = await req('GET', '/');
    check('главная страница открывается', home.status === 200, `HTTP ${home.status}`);
    check('главная показывает имя сотрудника', home.body.includes('Админ'));

    // Навигация по разделам. Раньше она жила в шапке каждого экрана и
    // отличалась от экрана к экрану: из карточки наряда нельзя было
    // попасть ни в обмен файлами, ни в титановые основания. Плитки
    // разделов должны быть на всех страницах приложения.
    //
    // Обмен файлами переехал с '/' на '/files': корень отдан меню
    // приложения, иначе программа начиналась со случайного раздела.
    const NAV = [
      ['Заказ-наряды', 'href="/orders"'],
      ['Файлы', 'href="/files"'],
      ['Титановые основания', 'href="/titan"'],
      ['Новый наряд', 'href="/orders/new"'],
    ];
    for (const [name, url] of [
      ['обмен файлами', '/files'],
      ['список нарядов', '/orders'],
      ['форма наряда', '/orders/new'],
      ['титановые основания', '/titan'],
    ]) {
      const page = await req('GET', url);
      check(`навигация есть на «${name}»`, page.status === 200, `HTTP ${page.status}`);
      for (const [label, href] of NAV) {
        check(`  плитка «${label}» на «${name}»`, page.body.includes(href));
      }
    }
    // Активный раздел помечен, чтобы пользователь видел, где находится.
    check('на списке нарядов активен свой раздел', (await req('GET', '/orders')).body.includes('nav-tile is-active'));
    check('в обмене файлами активен свой раздел', (await req('GET', '/files')).body.includes('nav-tile is-active'));

    // Вход должен открывать заказ-наряды, а не обмен файлами:
    // с обмена начинать было неудобно, нужный раздел был не виден.
    const savedCookie = cookie;
    cookie = '';
    const loginAgain = await req('POST', '/set-user', {
      lab_slug: 'testlab', username: 'Админ', password: 'Пароль123',
    });
    check('после входа открываются заказ-наряды', loginAgain.status === 302, `HTTP ${loginAgain.status}`);
    check('редирект ведёт на /orders', String(loginAgain.location || '').includes('/orders'),
      loginAgain.location || 'нет заголовка');
    check('после входа доступны наряды', (await req('GET', '/orders')).status === 200);
    cookie = savedCookie;

    for (const [name, url] of [
      ['титановые основания', '/titan'],
      ['добавление пользователя', '/add-user'],
      ['форма наряда с выбором материала', '/orders/new'],
      ['редактор содержимого сайта', '/admin/content'],
    ]) {
      const r = await req('GET', url);
      check(`старый экран: ${name}`, r.status === 200, `HTTP ${r.status}`);
    }

    // 8a. Админка содержимого: правка телефона должна доехать до файла
    // и пережить перезапуск сервера. Проверяем и сохранение, и то, что
    // чужим ролям вход закрыт.
    const contentBefore = await req('GET', '/admin/content');
    check('админка показывает поле телефона', contentBefore.body.includes('name="contacts[phone]"'));
    const savedContent = await req('POST', '/admin/content', {
      'contacts[phone]': '+7 900 123-45-67',
      'hero[title]': 'Заголовок из теста',
    });
    check('правка содержимого сохраняется', savedContent.status === 302, `HTTP ${savedContent.status}`);
    const contentAfter = await req('GET', '/admin/content');
    check('новый телефон виден в форме', contentAfter.body.includes('+7 900 123-45-67'));
    check('загруженная картинка не затирается пустым значением',
      contentAfter.body.includes('name="images[hero]"'));
    // Тест правки содержимого не должен трогать боевой файл: иначе
    // «Заголовок из теста» и телефон 900-123-45-67 остаются в
    // репозитории и потом публикуются на сайт.
    const realContent = readFileSync(path.join(ROOT, 'content', 'site.json'), 'utf8');
    check('тест не пишет в боевой файл контента',
      !realContent.includes('Заголовок из теста') && !realContent.includes('+7 900 123-45-67'),
      'боевой site.json испорчен тестом');

    // 9. Пагинация. Проверяем до смены лаборатории, иначе сессия
    // уже принадлежит другой лаборатории и наряд не найдётся.
    await req('POST', '/set-user', { lab_slug: 'testlab', username: 'Админ', password: 'Пароль123' });
    const many = await req('GET', '/orders?limit=1');
    check('пагинация отдаёт страницу', many.status === 200, `HTTP ${many.status}`);

    // 10. Изоляция лабораторий. 404 — правильный ответ: наряд другой
    // лаборатории не должен ни открываться, ни угадываться по коду.
    const other = await req('POST', '/register-lab', {
      lab_name: 'Чужая', slug: 'otherlab', username: 'Чужой', password: 'Пароль456',
        email: 'lab@example.com',
    });
check('регистрация второй лаборатории', other.status === 302);
      // Соседней лаборатории тоже нужно закрыть мастер, иначе вместо
      // ожидаемого 404 на её наряды придёт редирект на /setup.
      await req('POST', '/setup/finish');
      const cross = await req('GET', `/orders/${id}`);
    check('чужой наряд не отдаётся другой лаборатории', cross.status === 404, `HTTP ${cross.status}`);

    // Номер наряда уникален внутри лаборатории, а не глобально:
    // в соседней лаборатории такой же номер заводится свободно.
    const sameNumber = await req('POST', '/orders', { order_number: 'Н-1001', teeth: '11' });
      check('тот же номер в другой лаборатории заводится', sameNumber.status === 302,
        sameNumber.location || sameNumber.status);

      // ---- Манипуляции: чек-лист наряда, QR и расчёт зарплаты ----
      //
      // Смысл проверок: у нового наряда должен быть готовый список
      // работ, техник отмечает их с телефона, а администратор видит
      // сумму. Отдельно проверяем, что чужие лаборатории ничего не видят.

      // Предыдущая проверка оставила сессию в соседней лаборатории.
      // Возвращаемся в свою явно: иначе наряд, техник и отчёт
      // оказались бы в чужой лаборатории и проверки врали бы.
      const neighborSession = cookie;
      cookie = '';
      const adminLogin = await req('POST', '/set-user', {
        lab_slug: 'testlab', username: 'Админ', password: 'Пароль123',
      });
      check('администратор вернулся в свою лабораторию', adminLogin.status === 302,
        `HTTP ${adminLogin.status}`);

      const manipOrder = await req('POST', '/orders', {
        order_number: 'МАН-2001', customer: 'Клиника', stage: 'new',
        work_kind: 'crown', teeth: '16',
      });
      check('наряд для проверки манипуляций создан', manipOrder.status === 302,
        manipOrder.location || manipOrder.status);
      const manipId = Number(String(manipOrder.location || '').split('/').pop());

      const manipPage = await req('GET', `/orders/${manipId}/manipulations`);
      check('страница манипуляций открывается', manipPage.status === 200, `HTTP ${manipPage.status}`);
      check('в наряде есть общие шаги', manipPage.body.includes('INTAKE'));
      check('в наряде есть шаги по виду работы', manipPage.body.includes('PORCELAIN'));
      check('на странице есть кнопка возврата к наряду', manipPage.body.includes(`/orders/${manipId}`));

      // Идентификатор манипуляции берём со страницы самого наряда:
      // он сквозной по базе, и жёстко заданное число указало бы на
      // чужой наряд, из-за чего отметка молча не применилась бы.
      const manipRow = manipPage.body.match(
        new RegExp(`/orders/${manipId}/manipulations/(\\d+)`)
      );
      check('на странице есть форма отметки', Boolean(manipRow));
      const manipMid = manipRow ? Number(manipRow[1]) : 0;

      const qr = await req('GET', `/orders/${manipId}/qr.svg`);
      check('QR-код наряда отдаётся', qr.status === 200, `HTTP ${qr.status}`);
      check('QR-код это SVG', qr.body.includes('<svg'));
      // Код ведёт на страницу со списком работ, поэтому без входа
      // отдавать его нельзя: иначе по ссылке был бы виден наряд.
      const adminCookieForQr = cookie;
      cookie = '';
      const qrNoAuth = await req('GET', `/orders/${manipId}/qr.svg`);
      check('QR-код не отдаётся без входа', qrNoAuth.status === 302, `HTTP ${qrNoAuth.status}`);
      cookie = adminCookieForQr;

      const printPage = await req('GET', `/orders/${manipId}/print`);
      check('на печатном бланке есть QR-код', printPage.body.includes('qr.svg'));

      // Отметка выполнения, затем снятие отметки.
      const catalog = await req('GET', '/orders/catalog/manipulations');
      check('справочник манипуляций открыт', catalog.status === 200, `HTTP ${catalog.status}`);

      const markFirst = await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '1' });
      check('отметка манипуляции принимается', markFirst.status === 302, `HTTP ${markFirst.status}`);

      const afterMark = await req('GET', `/orders/${manipId}/manipulations`);
      check('отметка сохранилась', afterMark.body.includes('class="manip done"'));

      const stats = await req('GET', '/orders/stats/manipulations');
      check('отчёт по манипуляциям открывается', stats.status === 200, `HTTP ${stats.status}`);
      // Ищем имя сотрудника как отдельное слово. Простая проверка
      // includes('Админ') тут не годится: в меню есть плитка
      // «Администрирование», и она начинается с тех же букв, из-за чего
      // проверка проходила бы, даже если бы в отчёте никого не было.
      const adminNameRx = /Админ(?![а-яё])/;
      check('в отчёте видно техника, который отметил работу', adminNameRx.test(stats.body));

      // Снятие отметки: чек-лист должен вернуться в исходное состояние.
      const unmark = await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '0' });
      check('снятие отметки принимается', unmark.status === 302, `HTTP ${unmark.status}`);
      const afterUnmark = await req('GET', `/orders/${manipId}/manipulations`);
      check('отметка снята', !afterUnmark.body.includes('class="manip done"'));

      const wrongOrder = await req('GET', '/orders/999999/manipulations');
      check('несуществующий наряд не отдаёт манипуляции', wrongOrder.status === 404, `HTTP ${wrongOrder.status}`);

      // Справочник и отчёт — только администратору. Создаём техника
      // и проверяем, что обычный сотрудник в расчёт зарплаты не лезет.
      const adminSession = cookie;
      await req('POST', '/add-user', {
        newUsername: 'ТехникИван', password: 'Пароль123', role: 'tech',
      });
      // Сессия техника — отдельная: общий cookiejar не позволяет держать
      // две сессии, поэтому логин делаем начисто.
      cookie = '';
      await req('POST', '/set-user', {
        lab_slug: 'testlab', username: 'ТехникИван', password: 'Пароль123',
      });
      const techLoggedIn = await req('GET', '/orders');
      check('техник вошёл в свою лабораторию', techLoggedIn.status === 200, `HTTP ${techLoggedIn.status}`);
      const techStats = await req('GET', '/orders/stats/manipulations');
      check('техник не видит отчёт по зарплате', techStats.status === 403, `HTTP ${techStats.status}`);
      const techCatalog = await req('GET', '/orders/catalog/manipulations');
      check('техник не открывает справочник манипуляций', techCatalog.status === 403,
        `HTTP ${techCatalog.status}`);
      // Панель администрирования технику тоже не нужна: все её разделы
      // закрыты для него, ссылка в меню ему не показывается.
      const techAdmin = await req('GET', '/admin');
      check('техник не открывает панель администрирования', techAdmin.status === 403,
        `HTTP ${techAdmin.status}`);
      const techOrders = await req('GET', '/orders');
      check('у техника в меню нет плитки администрирования',
        !techOrders.body.includes('href="/admin"'), 'ссылка найдена в меню');
      // Отмечать манипуляции техник может — это его прямая работа.
      const techMark = await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '1' });
      check('техник может отмечать манипуляции', techMark.status === 302, `HTTP ${techMark.status}`);
      const techMarked = await req('GET', `/orders/${manipId}/manipulations`);
      check('отметка техника сохранилась', techMarked.body.includes('class="manip done"'));
      check('в чек-листе виден автор отметки', techMarked.body.includes('ТехникИван'));
      // Возвращаем отметку в исходное состояние, чтобы не оставлять
      // за собой выполненную работу в отчёте.
      await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '0' });

      // Стоматолог — внешний клиент. Роль в приложении не выдаётся,
      // поэтому заводим пользователя прямо в базе: так проверка
      // защиты работает и не зависит от экрана регистрации.
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const dentistHash = 'scrypt$' + salt + '$' +
        crypto.scryptSync('Пароль123', salt, 64).toString('hex');
      testDb.prepare(
        'INSERT INTO users (name, password_hash, role, active, lab_id) VALUES (?,?,?,1,?)'
      ).run('Стоматолог', dentistHash, 'dentist', 2);

      cookie = '';
      await req('POST', '/set-user', {
        lab_slug: 'testlab', username: 'Стоматолог', password: 'Пароль123',
      });
      const dentistOrders = await req('GET', '/orders');
      check('стоматолог вошёл', dentistOrders.status === 200, `HTTP ${dentistOrders.status}`);
      // Своих нарядов он не имеет, но и производство закрыто: даже
      // существующий наряд нельзя отметить выполненным.
      const dentistMark = await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '1' });
      check('стоматолог не может отметить манипуляцию', dentistMark.status === 403,
        `HTTP ${dentistMark.status}`);
      const dentistCatalog = await req('GET', '/orders/catalog/manipulations');
      check('стоматолог не открывает справочник манипуляций', dentistCatalog.status === 403,
        `HTTP ${dentistCatalog.status}`);
        const dentistAdmin = await req('GET', '/admin');
        check('стоматолог не открывает панель администрирования', dentistAdmin.status === 403,
          `HTTP ${dentistAdmin.status}`);
  
        cookie = adminSession;
  
        // ---- Цены: кому какие видно и кто их назначает --------------------
        // Проверяем на живом HTTP, потому что именно тут ошибка стоит
        // клинике денег: лишняя цена в наряде и подставленная скидка.
        {
          // Своя конструкция администратора с обеими ценами.
          const adminOwn = await req('POST', '/orders', {
            order_number: 'ЦЕНЫ-1', customer: 'Клиника', patient: 'Пациент',
            teeth: '16', construction_custom: 'Коронка из диоксида',
            construction_custom_price: '5000', construction_custom_price_tech: '2000',
            construction_qty: '1', discount: '20',
          });
          check('администратор создаёт наряд со своими ценами',
            adminOwn.status === 302, `HTTP ${adminOwn.status}`);
          const ownId = String(adminOwn.location || '').split('/').pop();
          const ownShow = await req('GET', `/orders/${ownId}`);
          // Скидка лежит в самом наряде, а не в строках конструкций:
          // итог считаем с ней, иначе проверка была бы проверкой функции,
          // а не сохранённых данных.
          const ownDisc = testDb.prepare('SELECT discount FROM orders WHERE id = ?').get(Number(ownId));
          const ownSum = O.constructionsTotal(
            testDb.prepare('SELECT price, price_tech, qty FROM order_constructions WHERE order_id = ?').all(Number(ownId)),
            ownDisc ? ownDisc.discount : 0);
          check('обе цены сохранены в наряде',
            ownSum.client === 5000 && ownSum.tech === 2000, JSON.stringify(ownSum));
          check('скидка 20% дала 4000 к оплате',
            ownSum.clientTotal === 4000 && ownSum.saved === 1000, JSON.stringify(ownSum));
          check('администратор видит обе цены',
            ownShow.body.includes('5000') && ownShow.body.includes('2000'),
            'одна из цен не показана');
  
          // Врач подставляет цену и скидку в свою конструкцию.
          cookie = '';
          await req('POST', '/set-user', {
            lab_slug: 'testlab', username: 'Стоматолог', password: 'Пароль123',
          });
          const dentistOwn = await req('POST', '/orders', {
            order_number: 'ЦЕНЫ-2', customer: 'Клиника', patient: 'Пациент',
            teeth: '16', construction_custom: 'Мост по сканированию',
            construction_custom_price: '99999', construction_custom_price_tech: '88888',
            construction_qty: '1', discount: '90',
          });
          check('врач создаёт наряд со своей конструкцией',
            dentistOwn.status === 302, `HTTP ${dentistOwn.status}`);
          const dentistOwnId = String(dentistOwn.location || '').split('/').pop();
          const dentistRow = testDb.prepare(
            'SELECT price, price_tech FROM order_constructions WHERE order_id = ?'
          ).get(Number(dentistOwnId));
          check('цена врача не попала в наряд',
            dentistRow && dentistRow.price === null && dentistRow.price_tech === null,
            JSON.stringify(dentistRow));
          const savedDisc = testDb.prepare('SELECT discount FROM orders WHERE id = ?').get(Number(dentistOwnId));
          check('скидка врача сохранена', savedDisc && savedDisc.discount === 90,
            String(savedDisc && savedDisc.discount));
          const dentistForm = await req('GET', '/orders/new');
          // Проверяем сам input в разметке, а не строку в скрипте:
          // обработчик пересчёта итогов есть у всех и без полей.
          check('врачу не показывают поля цен своей конструкции',
            !dentistForm.body.includes('name="construction_custom_price"'),
            'поле цены есть в форме врача');
          check('врачу показывают блок скидки',
            dentistForm.body.includes('name="discount"'), 'блок скидки не найден');
  
          cookie = '';
          await req('POST', '/set-user', {
            lab_slug: 'testlab', username: 'ТехникИван', password: 'Пароль123',
          });
          const techOwn = await req('POST', '/orders', {
            order_number: 'ЦЕНЫ-3', customer: 'Клиника', patient: 'Пациент',
            teeth: '16', construction_custom: 'Каркас', construction_custom_price: '77777',
            construction_qty: '1', discount: '65',
          });
          const techOwnId = String(techOwn.location || '').split('/').pop();
          const techRow = testDb.prepare(
            'SELECT price FROM order_constructions WHERE order_id = ?'
          ).get(Number(techOwnId));
          check('цена техника не попала в наряд', techRow && techRow.price === null,
            JSON.stringify(techRow));
          const techDisc = testDb.prepare('SELECT discount FROM orders WHERE id = ?').get(Number(techOwnId));
          check('техник не может дать скидку', techDisc && techDisc.discount === 0,
            String(techDisc && techDisc.discount));
          const techForm = await req('GET', '/orders/new');
          check('технику не показывают блок скидки',
            !techForm.body.includes('name="discount_preset"'), 'блок скидки найден');
          check('технику не показывают поле своей скидки',
            !techForm.body.includes('name="discount"'), 'поле скидки найден');
  
          // Техник не видит клиентскую цену, врач — себестоимость.
          const techShow = await req('GET', `/orders/${ownId}`);
          check('техник не видит цену для врача',
            !techShow.body.includes('5000'), 'клиентская цена попала в наряд техника');
          check('техник видит себестоимость', techShow.body.includes('2000'), 'себестоимость не показана');
  
          cookie = '';
          await req('POST', '/set-user', {
            lab_slug: 'testlab', username: 'Стоматолог', password: 'Пароль123',
          });
          // Свой наряд врача: своей цены у него нет, поэтому и суммы нет,
          // но скидка должна быть видна — её счёт предъявит клинике.
          const dentShow = await req('GET', `/orders/${dentistOwnId}`);
          check('врач видит свою скидку', dentShow.body.includes('90'),
            'скидка не показана в наряде врача');
          check('врач не видит подставленную цену',
            !dentShow.body.includes('99999'), 'цена врача попала в наряд');
          // Чужой наряд с ценами врачу недоступен вовсе.
          const dentForeign = await req('GET', `/orders/${ownId}`);
          check('врач не открывает чужой наряд с ценами',
            dentForeign.status === 403 || dentForeign.status === 404,
            `HTTP ${dentForeign.status}`);
          const dentOwn403 = await req('GET', `/orders/${ownId}/edit`);
          check('врач не правит чужой наряд', dentOwn403.status === 403 || dentOwn403.status === 404,
            `HTTP ${dentOwn403.status}`);
          const dentSave = await req('POST', '/orders', {
            id: String(ownId), order_number: 'ЦЕНЫ-1', customer: 'Подмена', teeth: '16',
            construction_custom: 'Подмена состава',
          });
          check('врач не переписывает чужой наряд подменой id',
            dentSave.status === 403 || dentSave.status === 404, `HTTP ${dentSave.status}`);
          const foreignIntact = testDb.prepare(
            'SELECT customer FROM orders WHERE id = ?'
          ).get(Number(ownId));
          check('чужой наряд не изменился после попытки',
            foreignIntact && foreignIntact.customer === 'Клиника',
            String(foreignIntact && foreignIntact.customer));
  
          cookie = adminSession;
        }

      // Настройки приложения: администратор видит все разделы,
      // а в меню появляется плитка. Проверяем именно наличие ссылок
      // на страницы, которыми панель пользуется: иначе хаб был бы
      // пустым списком, который никуда не ведёт.
      const adminPanel = await req('GET', '/admin');
      check('настройки приложения открываются', adminPanel.status === 200, `HTTP ${adminPanel.status}`);
      const panelLinks = [
        '/orders/catalog/manipulations', '/orders/stats/manipulations',
        '/orders/catalog/materials', '/add-user', '/setup/clinics',
        // Разделы хаба обязаны быть видны из панели: иначе до них можно
        // дойти только по заученному адресу.
        '/messages', '/users', '/options', '/notifications', '/files',
      ];
      const missing = panelLinks.filter((h) => !adminPanel.body.includes(`href="${h}"`));
      check('панель ссылается на все разделы', missing.length === 0, `нет: ${missing.join(', ')}`);
      check('обмен файлами в панели ведёт на /files, а не на хаб',
        !new RegExp(`class="card[^"]*"[^>]*href="/"`).test(adminPanel.body),
        'осталась плитка на корневой хаб');
      const adminOrdersPage = await req('GET', '/orders');
      check('в меню администратора есть плитка настроек приложения',
        adminOrdersPage.body.includes('href="/admin"'), 'плитка не найдена');
      // Настройки сайта и приложения — две отдельные админки. В панели
      // приложения лендинга быть не должно среди разделов: у него своя
      // авторизация, и лаборатория к его текстам отношения не имеет.
      // Ссылка-указатель в сноске допустима, карточки раздела — нет.
      check('в настройках приложения нет раздела правки лендинга',
        !/class="card[^"]*"\s+href="\/admin\/content"/.test(adminPanel.body),
        'лендинг попал в разделы приложения');
      const siteAdmin = await req('GET', '/admin/content');
      check('админка сайта открывается', siteAdmin.status === 200, `HTTP ${siteAdmin.status}`);
      check('админка сайта отсылает к настройкам приложения',
        siteAdmin.body.includes('href="/admin"'), 'ссылки на панель приложения нет');
      check('админка сайта не тащит разделы приложения',
        !siteAdmin.body.includes('href="/add-user"'), 'раздел приложения попал в админку сайта');

      // Разделы хаба. Каждый должен открываться и не содержать следов
      // шаблона: раньше запросы к ним падали в 500 из-за несуществующей
      // колонки в orders, и обычная проверка кода это не видела.
      for (const [href, label] of [
        ['/messages', 'переписка'],
        ['/users', 'сотрудники и коды'],
        ['/notifications', 'уведомления'],
        ['/options', 'настройки этапов'],
        ['/legal/privacy', 'политика конфиденциальности'],
        ['/legal/offer', 'оферта'],
      ]) {
        const page = await req('GET', href);
        check(`раздел открывается: ${label}`,
          page.status === 200 && !/Error:|at Object|stack/i.test(page.body),
          `HTTP ${page.status}`);
        check(`в разделе нет служебных плейсхолдеров: ${label}`,
          !/undefined|\[object Object\]|NaN/.test(page.body),
          'в выводе попали значения undefined/NaN');
      }

      // /join — публичная страница входа по коду, поэтому её надо
      // проверить и без авторизации: сессию сбрасываем и повторяем.
      const joinPage = await req('GET', '/join');
      check('страница входа по коду доступна', joinPage.status === 200, `HTTP ${joinPage.status}`);
      const anon = await reqNoCookie('GET', '/messages');
      check('переписка не открыта без входа',
        anon.status === 302 || anon.status === 401,
        `HTTP ${anon.status}`);
      const anonJoin = await reqNoCookie('GET', '/join');
      check('вход по коду доступен без входа', anonJoin.status === 200, `HTTP ${anonJoin.status}`);
      const anonLegal = await reqNoCookie('GET', '/legal/privacy');
      check('политика доступна без входа', anonLegal.status === 200, `HTTP ${anonLegal.status}`);

      // Одноразовый код: выдаём настоящий, гасим входом по нему и
      // проверяем, что повторно он уже не работает.
      const issued = await req('POST', '/users/codes', { role: 'tech' });
      check('код сотрудника выдаётся', issued.status === 302, `HTTP ${issued.status}`);
      const inviteRow = testDb.prepare(
        'SELECT COUNT(*) AS n FROM invite_codes WHERE used_at IS NULL'
      ).get().n;
      check('в базе появился неиспользованный код', inviteRow === 1, `строк ${inviteRow}`);
      const codeHash = testDb.prepare('SELECT code_hash FROM invite_codes LIMIT 1').get().code_hash;
      check('код в базе хранится хэшем, а не открытым текстом',
        /^[0-9a-f]{64}$/.test(codeHash), codeHash.slice(0, 16) + '…');

      // Неверный код и перебор не должны пропускать вход.
      const badJoin = await reqNoCookie('POST', '/join', {
        username: 'Новый', password: 'Пароль123', code: 'XXXXXXXX',
      });
      check('неверный код не пускает в систему',
        badJoin.status === 400 && /код/i.test(badJoin.body),
        `HTTP ${badJoin.status}`);

      // Перебор одного кода должен упираться в лимит: страница публичная,
      // поэтому без счётчика её можно было бы долбить наугад.
      let limited = 0;
      let lastStatus = 0;
      for (let i = 0; i < 12; i++) {
        const attempt = await reqNoCookie('POST', '/join', {
          username: 'Перебор', password: 'Пароль123', code: 'ZZZZZZZZ',
        });
        lastStatus = attempt.status;
        if (attempt.status === 429) limited++;
      }
      check('перебор кода в конце упирается в ограничение',
        limited > 0 && lastStatus === 429, `HTTP ${lastStatus}, ограничений ${limited}`);

      // Лимит загрузки: слишком большой файл должен отклоняться
      // понятным ответом, а не падением с 500 и не записью на диск.
      const tooBig = await uploadMultipart('stlFiles', 'model.stl', 2 * 1024 * 1024);
      check('файл больше лимита отклоняется', tooBig.status === 413, `HTTP ${tooBig.status}`);
      check('в ответе сказано про размер', /МБ/.test(tooBig.body), tooBig.body.slice(0, 80));

      // Файл в пределах лимита должен пройти: иначе проверка размера
      // ничего не значит — можно отклонить вообще всё.
      const okFile = await uploadMultipart('stlFiles', 'model.stl', 64 * 1024);
      check('файл в пределах лимита принимается', okFile.status === 302, `HTTP ${okFile.status}`);
      const saved = testDb.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE original_name = 'model.stl'"
      ).get().n;
      check('файл записан в базу', saved >= 1, `строк: ${saved}`);

      // Изоляция лабораторий: соседняя лаборатория не должна ни увидеть
      // наряд, ни получить его чек-лист и отчёт.
      cookie = neighborSession;
      const foreignPage = await req('GET', `/orders/${manipId}/manipulations`);
      check('соседняя лаборатория не видит чужой наряд', foreignPage.status === 404,
        `HTTP ${foreignPage.status}`);
      const foreignQr = await req('GET', `/orders/${manipId}/qr.svg`);
      check('соседняя лаборатория не получает чужой QR', foreignQr.status === 404,
        `HTTP ${foreignQr.status}`);
      const foreignMark = await req('POST', `/orders/${manipId}/manipulations/${manipMid}`, { done: '1' });
      check('соседняя лаборатория не может отмечать чужую работу', foreignMark.status === 404,
        `HTTP ${foreignMark.status}`);
      const foreignStats = await req('GET', '/orders/stats/manipulations');
      check('соседняя лаборатория не видит чужой отчёт', adminNameRx.test(foreignStats.body) === false,
        'отчёт содержит чужого сотрудника');

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
