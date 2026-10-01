// Живая проверка переписки в наряде, изоляции справочника по
// лабораториям, первого запуска и специализаций. Поднимает сервер на
// временной базе, прогоняет сценарий через HTTP и гасит сервер:
//   node test/chat-live.js

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CHAT_TEST_PORT) || 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '/tmp/opencode/chat-test';

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

(async () => {
  const { rmSync, mkdirSync, copyFileSync } = require('fs');

  if (await portBusy()) {
    console.log(`  ПОРТ ${PORT} занят другим процессом — тест не запущен.`);
    console.log(`  Освободите порт или запустите с другим: CHAT_TEST_PORT=3200`);
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'db'), { recursive: true });
  mkdirSync(path.join(TMP, 'up'), { recursive: true });
  // Своя копия контента: тест не должен писать в боевой content/site.json.
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
      SESSION_SECRET: 'chat-test-secret',
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
    const labId = (slug) => db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug).id;

    // ---- 1. Первый запуск: мастер встречает и его можно пропустить ----
    check('регистрация лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Зуборг', slug: 'zuborg', username: 'Главный', password: 'Пароль123',
        email: 'lab@example.com',
    })).status === 302);

    const first = await req('GET', '/orders');
    check('после входа открывается мастер, а не наряды',
      first.status === 302 && String(first.location || '').includes('/setup'),
      `HTTP ${first.status} → ${first.location}`);

    const skipped = await req('POST', '/setup/skip');
    check('кнопка «пропустить» работает', skipped.status === 302, `HTTP ${skipped.status}`);

    const afterSkip = await req('GET', '/orders');
    check('после пропуска открываются наряды', afterSkip.status === 200, `HTTP ${afterSkip.status}`);

    const second = await req('GET', '/orders');
    check('мастер больше не возвращается', second.status === 200, `HTTP ${second.status}`);

    const setupRoot = await req('GET', '/setup');
    check('после настройки /setup уводит в наряды',
      setupRoot.status === 302 && String(setupRoot.location || '').includes('/orders'),
      `HTTP ${setupRoot.status} → ${setupRoot.location}`);

    check('флаг завершения записан',
      db.prepare('SELECT setup_done FROM labs WHERE id = ?').get(labId('zuborg')).setup_done === 1);

    const A = labId('zuborg');

    // ---- 2. Справочник копируется каждой лаборатории ----
    const itemsA = db.prepare('SELECT COUNT(*) AS n FROM constructions WHERE lab_id = ?').get(A).n;
    check('своему справочнику стандартные позиции заведены', itemsA > 200, `позиций: ${itemsA}`);

    const tirebar = db.prepare('SELECT title FROM constructions WHERE lab_id = ? AND code = ?').get(A, '125140');
    check('позиция Tirebar на месте с единицей измерения',
      tirebar && /Tirebar/.test(tirebar.title) && /промежуток или консоль/.test(tirebar.title),
      tirebar && tirebar.title);

    // Каппы остались в ортодонтии: пользователь просил дерево не трогать.
    const capsGroup = db.prepare(`
      SELECT g.code FROM constructions c JOIN construction_groups g ON g.id = c.group_id
      WHERE c.lab_id = ? AND c.code = '121010'`).get(A);
    check('каппы остались в ортодонтии', capsGroup && capsGroup.code === 'ortho',
      capsGroup && capsGroup.code);

    // ---- 3. Специализации ----
    await req('POST', '/add-user', {
      newUsername: 'Керамист', password: 'Пароль123', role: 'tech', specialization: 'ceramist',
    });
    const tech = db.prepare('SELECT role, specialization FROM users WHERE lab_id = ? AND name = ?').get(A, 'Керамист');
    check('специализация техника сохранилась',
      tech && tech.role === 'tech' && tech.specialization === 'ceramist',
      JSON.stringify(tech));

    await req('POST', '/add-user', {
      newUsername: 'Склочник', password: 'Пароль123', role: 'tech', specialization: 'accountant',
    });
    const wrong = db.prepare('SELECT specialization FROM users WHERE lab_id = ? AND name = ?').get(A, 'Склочник');
    check('чужая специализация не сохраняется', wrong && wrong.specialization === null,
      JSON.stringify(wrong));

    await req('POST', '/add-user', {
      newUsername: 'Бухгалтер', password: 'Пароль123', role: 'admin', specialization: 'accountant',
    });
    const acc = db.prepare('SELECT role, specialization FROM users WHERE lab_id = ? AND name = ?').get(A, 'Бухгалтер');
    check('административная специализация сохранилась',
      acc && acc.role === 'admin' && acc.specialization === 'accountant', JSON.stringify(acc));

    const addUserPage = await req('GET', '/add-user');
    check('форма выбора роли показывает набор своей роли',
      addUserPage.body.includes('Керамисты') && addUserPage.body.includes('Бухгалтер'));

    // ---- 4. Наряд, цены и переписка ----
    // Администратор назначает цены: без них наряд из переписки собрался бы
    // с нулевой суммой, и врач не увидел бы стоимости договорённости.
    // Правка идёт по id, а не созданием новой позиции: код из стандартного
    // прайса уже занят и повторное создание отклонилось бы.
    const fixedGroup = db.prepare("SELECT id FROM construction_groups WHERE code = 'fixed'").get().id;
    const item = (code) => db.prepare('SELECT * FROM constructions WHERE lab_id = ? AND code = ?').get(A, code);
    const setPrice = async (code, title, price, tech) => req('POST',
      `/orders/catalog/constructions/${item(code).id}`,
      { title, group_id: fixedGroup, price, price_tech: tech, active: '1' });

    await setPrice('125140', 'Каркас для армирования условно-съёмного протеза Tirebar (за 1 промежуток или консоль)',
      '3500', '1800');
    await setPrice('125120', 'Каркас бюгельного протеза с опорно-удерживающими кламмерами', '9000', '5000');

    const priced = db.prepare('SELECT price, price_tech FROM constructions WHERE lab_id = ? AND code = ?').get(A, '125140');
    check('цены назначены в своём справочнике', priced && priced.price === 3500 && priced.price_tech === 1800,
      JSON.stringify(priced));


    const order = await req('POST', '/orders', { order_number: 'Ч-1', teeth: '11', stage: 'new' });
    const orderId = Number(String(order.location || '').split('/').pop());
    check('наряд заведён', order.status === 302 && orderId > 0, order.location);

    const sent = await req('POST', `/orders/${orderId}/messages`, {
      body: 'Пациент просит мост на 11-12, каркас Tirebar. Срок — пятница.',
      codes: ['125140', '125120'],
    });
    check('сообщение отправлено', sent.status === 302, `HTTP ${sent.status}`);

    const msg = db.prepare('SELECT * FROM order_messages WHERE order_id = ? AND lab_id = ?').get(orderId, A);
    check('сообщение сохранено с автором',
      msg && /Tirebar/.test(msg.body) && msg.author_name === 'Главный',
      msg && msg.author_name);
    check('договорённость записана кодами',
      msg && msg.proposal_codes && msg.proposal_codes.includes('125140') && msg.proposal_codes.includes('125120'),
      msg && msg.proposal_codes);

    const msgId = msg.id;

    // Чужой код в подделанной форме не должен попасть в договорённость.
    await req('POST', `/orders/${orderId}/messages`, {
      body: 'И ещё поднос.', codes: ['999999'],
    });
    const forged = db.prepare('SELECT proposal_codes FROM order_messages WHERE order_id = ? AND lab_id = ? ORDER BY id DESC').get(orderId, A);
    check('несуществующий код не принимается', forged && !forged.proposal_codes,
      forged && forged.proposal_codes);

    const applied = await req('POST', `/orders/${orderId}/messages/${msgId}/apply`);
    check('кнопка «заполнить наряд» работает', applied.status === 302, `HTTP ${applied.status}`);

    const rows = db.prepare('SELECT code, title, price, price_tech FROM order_constructions WHERE order_id = ? AND lab_id = ? ORDER BY code').all(orderId, A);
    check('в наряд попали обе согласованные позиции', rows.length === 2, `строк: ${rows.length}`);
    check('цены взяты из справочника лаборатории',
      rows.every(r => r.price > 0 && r.price_tech > 0), JSON.stringify(rows));

    // Позиция, вписанная в наряд, удаляться не должна: иначе в истории
    // наряда осталась бы ссылка в никуда. Проверяем после сборки —
    // до неё позиция ещё нигде не использована и удаляется законно.
    await req('POST', `/orders/catalog/constructions/${item('125140').id}/delete`);
    const stillThere = db.prepare('SELECT COUNT(*) AS n FROM constructions WHERE lab_id = ? AND code = ?').get(A, '125140').n;
    check('позиция из наряда удаляется только отключением', stillThere === 1, `строк: ${stillThere}`);

    const again = await req('POST', `/orders/${orderId}/messages/${msgId}/apply`);
    check('повторное нажатие не дублирует позиции', again.status === 302);
    const rows2 = db.prepare('SELECT id FROM order_constructions WHERE order_id = ? AND lab_id = ?').all(orderId, A);
    check('после повторного нажатия строк столько же', rows2.length === rows.length, `строк: ${rows2.length}`);
    check('сообщение помечено как собранное',
      db.prepare('SELECT applied_at FROM order_messages WHERE id = ?').get(msgId).applied_at != null);

    const show = await req('GET', `/orders/${orderId}`);
    check('в наряде видна переписка', show.status === 200 && show.body.includes('Tirebar'), `HTTP ${show.status}`);
    check('в наряде видна отметка «уже в наряде»', show.body.includes('Уже в наряде'));

    // ---- 5. Соседняя лаборатория ----
    const adminA = cookie;
    check('регистрация второй лаборатории', (await req('POST', '/register-lab', {
      lab_name: 'Денталь', slug: 'dental', username: 'Свой', password: 'Пароль456',
        email: 'lab@example.com',
    })).status === 302);
    await req('POST', '/setup/skip');
    const B = labId('dental');

    const itemsB = db.prepare('SELECT COUNT(*) AS n FROM constructions WHERE lab_id = ?').get(B).n;
    check('у соседней лаборатории свой полный справочник', itemsB > 200, `позиций: ${itemsB}`);

    const foreignPrice = db.prepare('SELECT price FROM constructions WHERE lab_id = ? AND code = ?').get(B, '125140');
    check('цены соседней лаборатории не копируются', foreignPrice && foreignPrice.price === null,
      JSON.stringify(foreignPrice));

    const foreignOrder = await req('GET', `/orders/${orderId}`);
    check('соседняя лаборатория не видит чужой наряд', foreignOrder.status === 404, `HTTP ${foreignOrder.status}`);

    const foreignMsg = await req('POST', `/orders/${orderId}/messages`, { body: 'подмена' });
    check('соседняя лаборатория не пишет в чужую переписку', foreignMsg.status === 404, `HTTP ${foreignMsg.status}`);

    const foreignApply = await req('POST', `/orders/${orderId}/messages/${msgId}/apply`);
    check('соседняя лаборатория не собирает чужой наряд', foreignApply.status === 404, `HTTP ${foreignApply.status}`);

    const foreignCodes = db.prepare('SELECT COUNT(*) AS n FROM order_messages WHERE lab_id = ?').get(B).n;
    check('в чужую переписку ничего не попало', foreignCodes === 0, `строк: ${foreignCodes}`);

    const tirebarB = db.prepare('SELECT title FROM constructions WHERE lab_id = ? AND code = ?').get(B, '125140');
    check('название Tirebar синхронизировано и у соседа',
      tirebarB && /промежуток или консоль/.test(tirebarB.title), tirebarB && tirebarB.title);

    // Синхронизация названий идёт один раз: правку администратора не затирает.
    db.prepare("UPDATE constructions SET title = 'Своё название' WHERE lab_id = ? AND code = '125140'").run(A);
    await req('GET', '/orders/new');
    const renamed = db.prepare('SELECT title FROM constructions WHERE lab_id = ? AND code = ?').get(A, '125140');
    check('правка названия не затирается повторным посевом', renamed.title === 'Своё название', renamed.title);

    cookie = adminA;

    const failed = results.filter(r => !r.ok).length;
    console.log(`\n  Итог: успешно ${results.length - failed} из ${results.length}`);
    if (failed) console.log('  СБОИ: ' + results.filter(r => !r.ok).map(r => r.name).join('; '));
    done(failed ? 1 : 0);
  } catch (err) {
    console.error(err);
    console.log('\nсервер:\n' + serverLog.slice(-3000));
    done(1);
  }
})();
