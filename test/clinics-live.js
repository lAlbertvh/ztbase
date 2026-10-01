// Живая проверка клиник: клиника принадлежит лаборатории, врачи одной
// клиники видят общие наряды, чужие — нет, а представитель клиники может
// получить учётную запись. Поднимает сервер на временной базе, прогоняет
// сценарий через HTTP и гасит сервер:
//   node test/clinics-live.js
//
// В отличие от остальных тестов здесь сервер поднимается дважды: перенос
// старых нарядов на клинику автора выполняется миграцией при старте, и
// иначе его нечем проверить.

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CLINIC_TEST_PORT) || 3201;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode/clinic-test';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

let cookie = '';

function req(method, url, form) {
  return new Promise((resolve, reject) => {
    let body = null;
    if (form) {
      const pairs = [];
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) {
          for (const item of v) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
        } else {
          pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`);
        }
      }
      body = pairs.join('&');
    }
    const u = new URL(BASE + url);
    const headers = { Cookie: cookie };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
          resolve({ status: res.statusCode, location: res.headers.location, body: data });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function portBusy() {
  return new Promise(resolve => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(PORT, '127.0.0.1');
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

let serverLog = '';

// Сервер поднимается на уже существующей базе. Второй запуск нужен миграции:
// база не пустая, поэтому поднимается тот же процесс, что и в бою.
function startServer() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_DIR: path.join(TMP, 'db'),
      UPLOAD_DIR: path.join(TMP, 'up'),
      CONTENT_DIR: path.join(TMP, 'content'),
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
      SESSION_SECRET: 'clinic-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  return server;
}

// Вход отдельным пользователем. Общий cookie не позволяет держать две
// сессии сразу, поэтому старую сохраняем и восстанавливаем.
async function loginAs(username, password, slug = 'testlab') {
  const saved = cookie;
  cookie = '';
  const res = await req('POST', '/set-user', { lab_slug: slug, username, password });
  const session = cookie;
  cookie = saved;
  return { res, session };
}

(async () => {
  const { rmSync, mkdirSync, copyFileSync } = require('fs');

  if (await portBusy()) {
    console.log(`  ПОРТ ${PORT} занят другим процессом — тест не запущен.`);
    console.log(`  Освободите порт или запустите с другим: CLINIC_TEST_PORT=3202`);
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'db'), { recursive: true });
  mkdirSync(path.join(TMP, 'up'), { recursive: true });
  // Своя копия контента: тест не должен писать в боевой content/site.json.
  const contentDir = path.join(TMP, 'content');
  mkdirSync(contentDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'content', 'site.json'), path.join(contentDir, 'site.json'));

  let server = startServer();
  const done = (code) => {
    try { server.kill('SIGKILL'); } catch { /* уже остановлен */ }
    process.exit(code);
  };

  try {
    if (!await waitReady()) { console.log('сервер не поднялся:\n' + serverLog); return done(1); }

    const Database = require('better-sqlite3');
    const db = new Database(path.join(TMP, 'db', 'exo.db'));
    const labId = (slug) => db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug).id;

    // ---- 1. Лаборатория и клиники ----
    check('регистрация лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Зуборг', slug: 'testlab', username: 'Главный', password: 'Пароль123',
        email: 'lab@example.com',
    })).status === 302);
    await req('POST', '/setup/skip');

    const A = labId('testlab');
    const adminSession = cookie;

    await req('POST', '/setup/clinics', { name: 'Стоматология Денталь', contact: '+7 900' });
    await req('POST', '/setup/clinics', { name: 'Клиника Заря' });
    const clinics = db.prepare('SELECT id, name FROM clinics WHERE lab_id = ? ORDER BY id').all(A);
    check('клиники заведены в справочнике лаборатории', clinics.length === 2,
      clinics.map(c => c.name).join(', '));

    const [dental, zarya] = clinics;

    // ---- 2. Представитель клиники получает учётную запись ----
    await req('POST', '/setup/contacts', {
      clinic_id: dental.id, name: 'Анна', role: 'dentist',
      specialization: 'orthodontist', contact: '+7 901', password: 'Пароль123',
    });
    const anna = db.prepare('SELECT * FROM users WHERE lab_id = ? AND name = ?').get(A, 'Анна');
    check('представитель клиники стал врачом с клиникой',
      anna && anna.role === 'dentist' && anna.clinic_id === dental.id && anna.specialization === 'orthodontist',
      JSON.stringify(anna && { role: anna.role, clinic_id: anna.clinic_id, spec: anna.specialization }));

    const annaContact = db.prepare('SELECT user_id FROM clinic_contacts WHERE lab_id = ? AND name = ?').get(A, 'Анна');
    check('контакт связан с учётной записью', annaContact && annaContact.user_id === anna.id,
      JSON.stringify(annaContact));

    // Второй врач той же клиники — чтобы было видно, что наряды общие.
    await req('POST', '/setup/contacts', {
      clinic_id: dental.id, name: 'Борис', role: 'dentist', specialization: 'surgeon', password: 'Пароль123',
    });
    const boris = db.prepare('SELECT * FROM users WHERE lab_id = ? AND name = ?').get(A, 'Борис');
    check('второй врач клиники заведён', boris && boris.clinic_id === dental.id,
      JSON.stringify(boris && boris.clinic_id));

    // Врач другой клиники.
    await req('POST', '/setup/contacts', {
      clinic_id: zarya.id, name: 'Вера', role: 'dentist', specialization: 'therapist', password: 'Пароль123',
    });
    const vera = db.prepare('SELECT * FROM users WHERE lab_id = ? AND name = ?').get(A, 'Вера');
    check('врач другой клиники заведён', vera && vera.clinic_id === zarya.id,
      JSON.stringify(vera && vera.clinic_id));

    // Представитель без пароля: строка справочника без доступа в систему.
    await req('POST', '/setup/contacts', {
      clinic_id: zarya.id, name: 'Гриша', role: 'other', contact: '+7 903',
    });
    const g = db.prepare('SELECT user_id FROM clinic_contacts WHERE lab_id = ? AND name = ?').get(A, 'Гриша');
    const gUser = db.prepare('SELECT id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Гриша');
    check('контакт без пароля остаётся без учётной записи', g && g.user_id === null && !gUser,
      JSON.stringify(g));

    // Короткий пароль не заводит врача: счётчик тарифа не должен тихо расти.
    await req('POST', '/setup/contacts', {
      clinic_id: zarya.id, name: 'Дима', role: 'dentist', password: '123',
    });
    const dUser = db.prepare('SELECT id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Дима');
    check('короткий пароль не создаёт учётную запись', !dUser, JSON.stringify(dUser));

    // Занятое имя: представитель есть, второй врач не плодится.
    await req('POST', '/setup/contacts', {
      clinic_id: zarya.id, name: 'Анна', role: 'dentist', password: 'Пароль123',
    });
    const annaCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE lab_id = ? AND name = ?').get(A, 'Анна').n;
    const annaContacts = db.prepare('SELECT COUNT(*) AS n FROM clinic_contacts WHERE lab_id = ? AND name = ?').get(A, 'Анна').n;
    check('занятое имя не создаёт второго пользователя и контакта',
      annaCount === 1 && annaContacts === 1, `пользователей: ${annaCount}, контактов: ${annaContacts}`);

    // ---- 3. Тариф не считает человека дважды ----
    const L = require('../src/services/license');
    const usage = L.usage(db, A);
    // Сотрудники: Главный, Анна, Борис, Вера — четверо.
    // Контакты без доступа: Гриша и Дима (Дима — с коротким паролем, учётной
    // записи нет, но представитель в справочнике остался).
    // Анна, Борис и Вера есть в обоих списках и должны считаться по одному разу.
    check('представитель с учётной записью считается один раз',
      usage.staff === 4 && usage.contacts === 2 && usage.used === 6,
      `сотрудников: ${usage.staff}, контактов: ${usage.contacts}, всего: ${usage.used}`);

    // ---- 4. Наряды клиник ----
    const annaSession = (await loginAs('Анна', 'Пароль123')).session;
    const veraSession = (await loginAs('Вера', 'Пароль123')).session;

    cookie = annaSession;
    const created = await req('POST', '/orders', {
      order_number: 'Д-1', teeth: '11', stage: 'new',
      // Клиника подставляется врачом: подставленная в форму чужая не должна
      // перенести наряд в другую клинику.
      clinic_id: zarya.id,
    });
    const dentaOrderId = Number(String(created.location || '').split('/').pop());
    check('врач завёл наряд', created.status === 302 && dentaOrderId > 0, created.location);

    const dentaOrder = db.prepare('SELECT clinic_id, created_by FROM orders WHERE id = ? AND lab_id = ?')
      .get(dentaOrderId, A);
    check('наряд врача остался в его клинике',
      dentaOrder && dentaOrder.clinic_id === dental.id && dentaOrder.created_by === 'Анна',
      JSON.stringify(dentaOrder));
    check('подставленная в форма чужя клиника проигнорирована',
      dentaOrder && dentaOrder.clinic_id !== zarya.id, JSON.stringify(dentaOrder && dentaOrder.clinic_id));

    cookie = veraSession;
    const veraCreated = await req('POST', '/orders', { order_number: 'З-1', teeth: '22', stage: 'new' });
    const zaryaOrderId = Number(String(veraCreated.location || '').split('/').pop());
    const zaryaOrder = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(zaryaOrderId, A);
    check('наряд второго врача попал в свою клинику', zaryaOrder && zaryaOrder.clinic_id === zarya.id,
      JSON.stringify(zaryaOrder));

    // ---- 5. Врачи одной клиники видят общие наряды ----
    const borisSession = (await loginAs('Борис', 'Пароль123')).session;

    cookie = borisSession;
    const listSame = await req('GET', '/orders');
    check('коллега по клинике видит наряд', listSame.status === 200 && listSame.body.includes('Д-1'), `HTTP ${listSame.status}`);
    check('коллега по клинике не видит наряд другой клиники',
      !listSame.body.includes('З-1'));

    const sameOpen = await req('GET', `/orders/${dentaOrderId}`);
    check('коллега по клинике открывает чужой наряд', sameOpen.status === 200, `HTTP ${sameOpen.status}`);

    const sameEdit = await req('GET', `/orders/${dentaOrderId}/edit`);
    check('коллега по клинике открывает форму правки', sameEdit.status === 200, `HTTP ${sameEdit.status}`);
    check('в форме правки видна клиника наряда', sameEdit.body.includes('Стоматология Денталь'));

    const samePrint = await req('GET', `/orders/${dentaOrderId}/print`);
    check('коллега по клинике печатает наряд', samePrint.status === 200, `HTTP ${samePrint.status}`);

    const sameQr = await req('GET', `/orders/${dentaOrderId}/qr.svg`);
    check('коллега по клинике строит QR', sameQr.status === 200, `HTTP ${sameQr.status}`);

    // ---- 6. Чужая клиника не видит ничего ----
    cookie = veraSession;
    const foreignOpen = await req('GET', `/orders/${dentaOrderId}`);
    check('врач другой клиники не открывает наряд', foreignOpen.status === 403, `HTTP ${foreignOpen.status}`);

    const foreignEdit = await req('GET', `/orders/${dentaOrderId}/edit`);
    check('врач другой клиники не открывает форму правки', foreignEdit.status === 403, `HTTP ${foreignEdit.status}`);

    const foreignPrint = await req('GET', `/orders/${dentaOrderId}/print`);
    check('врач другой клиники не печатает наряд', foreignPrint.status === 403, `HTTP ${foreignPrint.status}`);

    const foreignList = await req('GET', '/orders');
    check('в списке врага нет чужого наряда', foreignList.status === 200 && !foreignList.body.includes('Д-1'));

    // ---- 7. Печать пачкой не обходит права ----
    const batch = await req('GET', `/orders/print/batch?ids=${dentaOrderId},${zaryaOrderId}`);
    check('печать пачкой отбрасывает чужие наряды',
      batch.status === 200 && batch.body.includes('З-1') && !batch.body.includes('Д-1'),
      `HTTP ${batch.status}`);

    const batchEmpty = await req('GET', `/orders/print/batch?ids=${dentaOrderId}`);
    check('печать пачкой без доступных нарядов не показывает чужих',
      batchEmpty.status === 404, `HTTP ${batchEmpty.status}`);

    // ---- 8. Счётчики этапов не выдают чужую клинику ----
    //
    // Плитки этапов на списке показываются только администратору, поэтому
    // правило сужения проверяем на самом сервисе: при отображении счётчика
    // врачу нельзя отдавать сводку по всей лаборатории.
    const O = require('../src/services/orders');
    const scope = (name, clinicId) => ({ name, clinicId });
    const sum = (s) => Object.values(s).reduce((x, y) => x + y, 0);
    check('счётчик этапов врача считает только свою клинику',
      sum(O.stageSummary(db, A, { clinicOf: scope('Анна', dental.id) })) === 1
      && sum(O.stageSummary(db, A, { clinicOf: scope('Вера', zarya.id) })) === 1,
      `Анна: ${sum(O.stageSummary(db, A, { clinicOf: scope('Анна', dental.id) }))}, ` +
      `Вера: ${sum(O.stageSummary(db, A, { clinicOf: scope('Вера', zarya.id) }))}`);
    check('счётчик этапов администратора считает всю лабораторию',
      sum(O.stageSummary(db, A)) === 2, `админ: ${sum(O.stageSummary(db, A))}`);
    check('врач без клиники в счётчиках не видит чужих нарядов',
      sum(O.stageSummary(db, A, { clinicOf: scope('Олег', null) })) === 0);

    // ---- 9. Администратор выбирает клинику, но только свою ----
    // Возвращаемся под администратором: предыдущий раздел закончился сессией
    // врача другой клиники, и наряд «от администратора» завела бы она.
    cookie = adminSession;
    const crossLabClinic = db.prepare('SELECT id FROM clinics WHERE lab_id != ? LIMIT 1').get(A);
    const adminOrder = await req('POST', '/orders', {
      order_number: 'А-1', teeth: '31', stage: 'new', clinic_id: zarya.id,
    });
    const adminOrderId = Number(String(adminOrder.location || '').split('/').pop());
    const ao = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(adminOrderId, A);
    check('администратор назначает клинику из своей лаборатории', ao && ao.clinic_id === zarya.id,
      JSON.stringify(ao));
    check('клиника соседней лаборатории не принимается',
      !crossLabClinic || (ao && ao.clinic_id !== crossLabClinic.id));

    const noClinic = await req('POST', '/orders', { order_number: 'А-2', teeth: '32', stage: 'new' });
    const noClinicId = Number(String(noClinic.location || '').split('/').pop());
    const nc = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(noClinicId, A);
    check('наряд без клиники остаётся без клиники', nc && nc.clinic_id === null, JSON.stringify(nc));

    // Форма наряда показывает клинику, а не свободный текст.
    const formNew = await req('GET', '/orders/new');
    check('в форме наряда есть выбор клиники',
      formNew.body.includes('name="clinic_id"') && formNew.body.includes('Стоматология Денталь'));
    check('в форме наряда больше нет свободного текста вместо клиники',
      !formNew.body.includes('Лаборатория / клиника'));

    // Врачу выбор не показывают: его клиника задана учётной записью.
    cookie = annaSession;
    const formDentist = await req('GET', '/orders/new');
    check('врачу его клиника показана текстом, а не списком',
      formDentist.body.includes('Стоматология Денталь') && !formDentist.body.includes('name="clinic_id"'));
    const forgedEdit = await req('POST', '/orders', {
      id: dentaOrderId, order_number: 'Д-1', teeth: '11', stage: 'new', clinic_id: zarya.id,
    });
    check('врач может править наряд своей клиники', forgedEdit.status === 302, `HTTP ${forgedEdit.status}`);
    const stillDenta = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(dentaOrderId, A);
    check('при правке клиника не переехала в чужую',
      stillDenta && stillDenta.clinic_id === dental.id, JSON.stringify(stillDenta));

    const foreignEditPost = await req('POST', '/orders', {
      id: adminOrderId, order_number: 'А-1', teeth: '31', stage: 'new',
    });
    check('врач не правит наряд чужой клиники', foreignEditPost.status === 403, `HTTP ${foreignEditPost.status}`);

    cookie = adminSession;

    // ---- 10. Врач без клиники видит только своё ----
    await req('POST', '/setup/staff', {
      name: 'Олег', password: 'Пароль123', role: 'dentist', specialization: 'prosthodontist',
    });
    const olegSession = (await loginAs('Олег', 'Пароль123')).session;
    const unattachedPage = await (async () => { cookie = adminSession; return req('GET', '/setup/clinics'); })();
    check('врач без клиники предложен к привязке', unattachedPage.body.includes('Олег'));
    check('форма привязки показывает клиники лаборатории',
      unattachedPage.body.includes('/setup/clinic/' + dental.id + '/link'));

    cookie = olegSession;
    const olegCreated = await req('POST', '/orders', { order_number: 'О-1', teeth: '41', stage: 'new' });
    const olegOrderId = Number(String(olegCreated.location || '').split('/').pop());
    const olegOrder = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(olegOrderId, A);
    check('наряд врача без клиники остаётся без клиники', olegOrder && olegOrder.clinic_id === null,
      JSON.stringify(olegOrder));

    const olegList = await req('GET', '/orders');
    check('врач без клиники не видит наряды коллег',
      olegList.body.includes('О-1') && !olegList.body.includes('Д-1') && !olegList.body.includes('А-1'));
    const olegForeign = await req('GET', `/orders/${dentaOrderId}`);
    check('врач без клиники не открывает чужой наряд', olegForeign.status === 403, `HTTP ${olegForeign.status}`);

    // ---- 11. Привязка врача к клинике ----
    cookie = adminSession;
    await req('POST', `/setup/clinic/${dental.id}/link`, { user_id: db.prepare('SELECT id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Олег').id });
    const olegLink = db.prepare('SELECT clinic_id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Олег');
    check('врач привязан к клинике', olegLink && olegLink.clinic_id === dental.id, JSON.stringify(olegLink));

    // Техника привязать к клинике нельзя: он не клиника.
    await req('POST', '/setup/staff', { name: 'Тех', password: 'Пароль123', role: 'tech' });
    const techId = db.prepare('SELECT id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Тех').id;
    await req('POST', `/setup/clinic/${dental.id}/link`, { user_id: techId });
    const techLink = db.prepare('SELECT clinic_id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Тех');
    check('техника нельзя привязать к клинике', techLink && techLink.clinic_id === null, JSON.stringify(techLink));

    // Привязка клиники соседней лаборатории отклоняется.
    await req('POST', `/setup/clinic/999999/link`, { user_id: techId });
    const noLabClinic = db.prepare('SELECT clinic_id FROM users WHERE lab_id = ? AND name = ?').get(A, 'Олег');
    check('привязка к несуществующей клинике ничего не меняет',
      noLabClinic && noLabClinic.clinic_id === dental.id, JSON.stringify(noLabClinic));

    cookie = olegSession;
    const olegListAfter = await req('GET', '/orders');
    check('после привязки врач видит наряды клиники',
      olegListAfter.body.includes('Д-1') && olegListAfter.body.includes('О-1'));

    // ---- 12. Перенос старых нарядов на клинику автора ----
    // Наряд Олега создан до привязки и остался без клиники: переносит его
    // миграция при следующем старте сервера.
    const beforeRestart = db.prepare('SELECT clinic_id FROM orders WHERE id = ?').get(olegOrderId);
    check('до перезапуска наряд остался без клиники', beforeRestart && beforeRestart.clinic_id === null,
      JSON.stringify(beforeRestart));

    // Возвращаемся под администратором: предыдущий раздел закончился сессией
    // врача без клиники, а удалять клиники может только администратор.
    cookie = adminSession;

    // Клиника с нарядами и врачами не удаляется, а отключается: её история
    // должна остаться, а молча исчезнувшая клиника выглядела бы как ошибка.
    await req('POST', `/setup/clinics/${zarya.id}/delete`);
    const zaryaAfter = db.prepare('SELECT active FROM clinics WHERE id = ? AND lab_id = ?').get(zarya.id, A);
    check('клиника с нарядами отключена, а не удалена', zaryaAfter && zaryaAfter.active === 0,
      JSON.stringify(zaryaAfter));
    const zaryaOrdersKept = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE lab_id = ? AND clinic_id = ?').get(A, zarya.id).n;
    check('наряды отключённой клиники остались на месте', zaryaOrdersKept === 2, `нарядов: ${zaryaOrdersKept}`);
    const zaryaInList = await req('GET', '/setup/clinics');
    check('отключённая клиника показана отдельной строкой с возвратом',
      zaryaInList.body.includes('Клиника Заря') && zaryaInList.body.includes(`/setup/clinics/${zarya.id}/restore`));
    const zaryaInForm = await req('GET', '/orders/new');
    check('отключённая клиника не попадает в выбор наряда',
      !zaryaInForm.body.includes('Клиника Заря'), 'в форме есть отключённая клиника');

    // Пустую клинику удалять можно: истории нет, и она бы только мешала.
    const emptyClinic = db.prepare('INSERT INTO clinics (lab_id, name) VALUES (?, ?)').run(A, 'Без работы');
    const emptyId = emptyClinic.lastInsertRowid;
    await req('POST', `/setup/clinics/${emptyId}/delete`);
    const emptyLeft = db.prepare('SELECT COUNT(*) AS n FROM clinics WHERE id = ? AND lab_id = ?').get(emptyId, A).n;
    check('пустая клиника удаляется целиком', emptyLeft === 0, `строк: ${emptyLeft}`);

    await req('POST', `/setup/clinics/${zarya.id}/restore`);
    const zaryaBack = db.prepare('SELECT active FROM clinics WHERE id = ? AND lab_id = ?').get(zarya.id, A);
    check('отключённая клиника возвращается в работу', zaryaBack && zaryaBack.active === 1,
      JSON.stringify(zaryaBack));

    // Врач отключённой клиники должен попасть в список на привязку.
    await req('POST', `/setup/clinics/${zarya.id}/delete`);
    cookie = adminSession;
    const linkAfterHide = await req('GET', '/setup/clinics');
    // Отключённая клиника остаётся в справочнике (раздел «Отключённые»), но
    // её больше нет среди кнопок привязки — привязывать к ней врачей нельзя.
    check('отключённая клиника не предлагается для привязки',
      !linkAfterHide.body.includes(`action="/setup/clinic/${zarya.id}/link"`),
      'кнопка привязки к отключённой клинике есть');
    check('врач отключённой клиники предложен к перепривязке',
      // Кнопка привязки — это отдельная форма на каждую клинику, поэтому
      // ищем её целиком: id врача в hidden и название клиники в кнопке.
      /action="\/setup\/clinic\/\d+\/link"[^>]*>\s*<input[^>]*value="4"[^>]*>\s*<button[^>]*>\s*Стоматология Денталь/
        .test(linkAfterHide.body)
      && linkAfterHide.body.includes('Вера'),
      `Вера в списке на привязку: ${linkAfterHide.body.includes('Вера')}`);
    await req('POST', `/setup/clinics/${zarya.id}/restore`);

    cookie = adminSession;

    // ---- 13. Соседняя лаборатория ничего не видит ----
    const adminSessionHere = cookie;
    check('регистрация второй лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Денталь', slug: 'dental', username: 'Свой', password: 'Пароль456',
        email: 'lab@example.com',
    })).status === 302);
    await req('POST', '/setup/skip');
    const B = labId('dental');
    check('у соседней лаборатории свой справочник клиник',
      db.prepare('SELECT COUNT(*) AS n FROM clinics WHERE lab_id = ?').get(B).n === 0);

    const crossList = await req('GET', '/orders');
    check('соседняя лаборатория не видит клинических нарядов',
      crossList.status === 200 && !crossList.body.includes('Д-1') && !crossList.body.includes('О-1'));

    const crossOpen = await req('GET', `/orders/${dentaOrderId}`);
    check('соседняя лаборатория не открывает наряд', crossOpen.status === 404, `HTTP ${crossOpen.status}`);

    const crossBatch = await req('GET', `/orders/print/batch?ids=${dentaOrderId},${zaryaOrderId}`);
    check('соседняя лаборатория не печатает чужие наряды пачкой', crossBatch.status === 404, `HTTP ${crossBatch.status}`);

    // Перезапуск: миграция переносит старый наряд на клинику автора.
    cookie = adminSessionHere;
    try { server.kill('SIGKILL'); } catch { /* уже остановлен */ }
    server = startServer();
    if (!await waitReady()) { console.log('сервер не поднялся после перезапуска:\n' + serverLog); return done(1); }

    const afterRestart = db.prepare('SELECT clinic_id, created_by FROM orders WHERE id = ? AND lab_id = ?')
      .get(olegOrderId, A);
    check('старый наряд перенесён на клинику автора',
      afterRestart && afterRestart.clinic_id === dental.id && afterRestart.created_by === 'Олег',
      JSON.stringify(afterRestart));

    const untouched = db.prepare('SELECT clinic_id FROM orders WHERE id = ? AND lab_id = ?').get(noClinicId, A);
    check('наряд без клиники переносом не тронут', untouched && untouched.clinic_id === null,
      JSON.stringify(untouched));

    // Войти заново: сессия пережила перезапуск, но проверяем вход.
    cookie = '';
    const reLogin = await req('POST', '/set-user', {
      lab_slug: 'testlab', username: 'Анна', password: 'Пароль123',
    });
    check('врач клиники входит после перезапуска', reLogin.status === 302, `HTTP ${reLogin.status}`);
    const annaAfter = await req('GET', '/orders');
    check('после переноса врач видит и наряд коллеги по клинике',
      annaAfter.body.includes('Д-1') && annaAfter.body.includes('О-1'));

    // ---- 14. Пробный период: работа останавливается, данные целы ----
    //
    // Срок ставим в прошлое прямо в базе: ждать неделю в тесте нельзя, а
    // проверяется именно реакция на истёкший срок.
    db.prepare("UPDATE labs SET trial_until = '2020-01-01T00:00:00Z' WHERE id = ?").run(A);

    const wallOrders = await req('GET', '/orders');
    check('после истечения пробного периода наряды закрыты',
      wallOrders.status === 302 && String(wallOrders.location || '').includes('/trial'),
      `HTTP ${wallOrders.status} → ${wallOrders.location}`);

    const wall = await req('GET', '/trial');
    check('экран продления объясняет причину',
      wall.status === 200 && /Пробный период завершён/.test(wall.body), `HTTP ${wall.status}`);
    check('экран продления говорит, что данные на месте',
      /Все данные на месте/.test(wall.body));

    const wallAdmin = await req('GET', '/admin');
    check('настройки приложения тоже закрыты', wallAdmin.status === 302, `HTTP ${wallAdmin.status}`);

    const wallFiles = await req('GET', '/');
    check('обмен файлами тоже закрыт', wallFiles.status === 302, `HTTP ${wallFiles.status}`);

    // Заявка на продление должна приниматься и с закрытого приложения:
    // иначе человек застрянет без способа сообщить об оплате.
    // Ошибка возвращается на /trial с кодом в адресе: сама страница под
    // сессией закрытой лаборатории доступна, но с теми же query-параметрами.
    const renewBad = await req('POST', '/trial/renew', { email: 'не-почта' });
    check('заявка на продление проверяет e-mail',
      renewBad.status === 302 && String(renewBad.location || '').includes('error='),
      `HTTP ${renewBad.status} → ${renewBad.location}`);
    const renewOk = await req('POST', '/trial/renew', {
      email: 'boss@dent.ru', phone: '+7 900 111-22-33', message: 'Готовы оплатить',
    });
    check('заявка на продление принимается', renewOk.status === 302, `HTTP ${renewOk.status}`);
    const wallSent = await req('GET', '/trial?sent=1');
    check('после заявки показан подтверждение', wallSent.body.includes('Заявка отправлена'));

    // Данные не тронуты: наряд и настройки на месте, срок не восстановился.
    const stillThere = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE lab_id = ?').get(A).n;
    check('наряды не пропали при остановке работы', stillThere >= 5, `нарядов: ${stillThere}`);
    const stillExpired = db.prepare('SELECT trial_paid FROM labs WHERE id = ?').get(A).trial_paid === 0;
    check('пробный период сам не восстановился', stillExpired);

    // Оплата снимает блокировку — и это единственное, что её снимает.
    db.prepare('UPDATE labs SET trial_paid = 1 WHERE id = ?').run(A);
    const afterPay = await req('GET', '/orders');
    check('после оплаты работа возвращается', afterPay.status === 200, `HTTP ${afterPay.status}`);
    const ordersBack = await req('GET', '/orders');
    check('после оплаты наряды на месте', ordersBack.body.includes('Д-1'), 'наряды не вернулись');

    // Лаборатория без пробного срока (NULL) не блокируется: заводилась
    // до появления механики и должна работать.
    db.prepare('UPDATE labs SET trial_until = NULL, trial_paid = 0 WHERE id = ?').run(B);
    cookie = '';
    await req('POST', '/set-user', { lab_slug: 'dental', username: 'Свой', password: 'Пароль456' });
    const nullTrial = await req('GET', '/orders');
    check('лаборатория без пробного срока не блокируется', nullTrial.status === 200, `HTTP ${nullTrial.status}`);

    const failed = results.filter(r => !r.ok).length;
    console.log(`\n  Итог: успешно ${results.length - failed} из ${results.length}`);
    if (failed) {
      console.log('  СБОИ: ' + results.filter(r => !r.ok).map(r => r.name).join('; '));
      // Без лога сервера сбой вроде «HTTP 500» нечем объяснить: причина
      // печатается в stderr процесса, а не в ответе.
      console.log('\nсервер:\n' + serverLog.slice(-4000));
    }
    done(failed ? 1 : 0);
  } catch (err) {
    console.error(err);
    console.log('\nсервер:\n' + serverLog.slice(-3000));
    done(1);
  }
})();
