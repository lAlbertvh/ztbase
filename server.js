require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const cfg = require('./src/config');
const { hashPassword, verifyPassword } = require('./src/lib/password');
const { storage, uniqueName, BACKEND } = require('./src/services/storage');
const quota = require('./src/services/quota');
const SqliteStore = require('./src/services/session-store');
const { setupPending } = require('./src/db/setup-schema');
const RESET = require('./src/services/password-reset');
const mailer = require('./src/services/mailer');
const createOrderRoutes = require('./src/routes/orders');
const createSetupRoutes = require('./src/routes/setup');
const createSectionRoutes = require('./src/routes/sections');
const createLegalRoutes = require('./src/routes/legal');
const createPasswordRoutes = require('./src/routes/password');
const license = require('./src/services/license');
const SPEC = require('./src/services/specializations');
const constructions = require('./src/services/constructions');
const inbox = require('./src/services/inbox');

const app = express();
const PORT = cfg.PORT;

// Корневые папки, порт и лимиты описаны в src/config.js: там же —
// почему шаблоны в собранном exe ищутся по внутреннему пути бандла,
// а данные кладутся рядом с самим .exe.
const appRoot = cfg.appRoot;
const viewsDir = cfg.viewsDir;
const publicDir = cfg.publicDir;
const uploadDir = cfg.uploadDir;
const dbDir = cfg.dbDir;
const tmpUploadDir = cfg.tmpUploadDir;
const MAX_FILE_MB = cfg.MAX_FILE_MB;

console.log('Корневая папка приложения:', appRoot);
if (!process.env.UPLOAD_DIR) {
  console.log('Создана папка для загрузок:', uploadDir);
}

// ------ Подключение к SQLite, схема и миграции ------
// Описаны в src/db/index.js: точка входа не должна занимать созданием
// таблиц. Отсюда же берётся обёртка query(), под которую написан слой
// маршрутов.
const dbModule = require('./src/db');
const { connect, initDb, migrateLegacyData } = dbModule;

const db = connect(dbDir);
initDb(db);
migrateLegacyData(db, dbDir, hashPassword);

const query = (sql, params) => dbModule.query(db, sql, params);

// ------ Настройка Express ------

// nginx и приложение живут на одной машине, и nginx проксирует запросы
// с 127.0.0.1, поэтому в req.ip без этой настройки попадёт адрес nginx,
// а не реальный адрес сотрудника. Последствие: все пользователи
// считались бы одним адресом, и блокировка после 10 неудачных попыток
// выкидывала бы всю лабораторию разом.
//
// Доверяем только локальным и частным адресам (RFC1918/RFC4193) —
// именно оттуда приходит nginx. Запросы с публичных адресов
// заголовку X-Forwarded-For не верят.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Статика должна стоять выше middleware ниже, который насильно
// проставляет Content-Type: text/html. express.static тип файла
// выбирает сам, но только если заголовок ещё не задан, — иначе все
// файлы из public/ уходили к браузеру как html: стиль отвергался,
// манифест и sw.js не проходили проверку типа, service worker не
// регистрировался вовсе.
app.use(express.static(publicDir));

// Картинки, загруженные через /admin/content, лежат в каталоге данных
// (/var/lib/ztlab/content/img), а не в папке кода: обновление через
// deploy.sh не должно затирать загруженное, и при ProtectSystem=strict
// в /opt вообще нельзя писать. Адрес прежний — /public/content, —
// чтобы значения, уже сохранённые в site.json, продолжали работать.
const contentImgDir = path.resolve(
  process.env.CONTENT_IMG_DIR || path.join(publicDir, 'content')
);
app.use('/public/content', express.static(contentImgDir));

app.use((req, res, next) => {
  const isFileRoute = req.path.startsWith('/image/') || req.path.startsWith('/download');
  if (!isFileRoute) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  }
  next();
});
// Секрет для подписи cookie. В рабочей версии он обязан быть задан:
// с ключом из примера любой может подделать сессию администратора.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'your-secret-key-change-this') {
  if (process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET не задан. Приложение не запускается.');
    process.exit(1);
  }
  console.warn('ВНИМАНИЕ: SESSION_SECRET не задан, используется временный ключ.');
}

// Временный ключ только для локальной разработки: он меняется при каждом
// запуске, поэтому сессии не переживают перезапуск — и это безопасно.
const devSecret = SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

app.use(session({
  store: new SqliteStore(db),
  secret: devSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 12 * 60 * 60 * 1000, // 12 часов: рабочая смена
    httpOnly: true,
    sameSite: 'lax',
    // За nginx с HTTPS cookie должна быть secure, иначе браузер
    // не отправит её и вход будет сбрасываться при каждом обновлении.
    secure: process.env.COOKIE_SECURE === '1'
  }
}));

// Сообщение после регистрации показываем один экран: на первом экране
// настройки и на хабе. Именно настройку новичок видит сразу после
// регистрации, а хаб — много позже, поэтому одного из двух мало.
app.use((req, res, next) => {
  res.locals.notice = req.session.notice || null;
  next();
});

// Браузер не должен сохранять страницы с заказами на диск: после выхода
// из аккаунта данные остались бы в кэше и могли бы попасть в поле зрения
// следующего сотрудника на том же компьютере.
app.use((req, res, next) => {
  if (req.path.startsWith('/public')) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.set('view engine', 'ejs');
app.set('views', viewsDir);

// ------ Multer для загрузки файлов ------
// Файлы пишутся во временную папку, а не сразу в конечное место.
// Причина: STL полной дуги весит 50-150 МБ, и держать их в памяти нельзя.
// После загрузки storage.put() переносит файл в папку лаборатории
// (или в облако, если STORAGE_BACKEND=s3).
// Папка tmpUploadDir создаётся в src/config.js при загрузке модуля.

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztlab-'));
    // Запоминаем папку на запросе: если multer отклонит загрузку по
    // размеру, обработчик ошибок должен её убрать, а своего доступа
    // к локальным переменным маршрута у него нет.
    if (!req.ztlabTmpDirs) req.ztlabTmpDirs = new Set();
    req.ztlabTmpDirs.add(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uniqueName(decodedName));
  }
});
// Предел на один файл задаётся в src/config.js: без него любой вошедший
// сотрудник мог залить на диск файл любого размера и забить машину.

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    // Страхует от запроса с тысячами мелких частей: количество полей
    // в запросе не должно расти бесконтрольно.
    fields: 50,
    parts: 120,
  },
});

// Защита от подбора пароля.
//
// Счётчика два, потому что лаборатория обычно сидит за одним роутером,
// и один счётчик на весь адрес блокировал бы вход сразу всем сотрудникам.
//
//  1) на пару «адрес + сотрудник» — 10 попыток. Защищает конкретную учётку.
//  2) на адрес — 100 попыток. Ловит перебор с перебором имён подряд,
//     но обычных сотрудников не задевает.
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_PER_IP = 100;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function attemptsFor(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function clearAttempts(keys) {
  for (const k of [].concat(keys)) loginAttempts.delete(k);
}

// Периодически убираем протухшие записи, иначе память растёт бесконечно.
const attemptsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (now - v.first > ATTEMPT_WINDOW_MS) loginAttempts.delete(k);
  }
}, ATTEMPT_WINDOW_MS);
if (attemptsSweep.unref) attemptsSweep.unref();

// Проверка живости. Не требует входа и не отдаёт никаких данных.
// nginx и systemd используют её, чтобы понять, поднялся ли процесс.
app.get('/health', (req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch (e) {
    dbOk = false;
  }
  const ok = dbOk ? 'ok' : 'db-error';
  // Видимый адрес нужен только при настройке: по нему видно, проходит ли
  // nginx и какой реальный IP сотрудника. В бою адрес не отдаём.
  const body = { status: ok, uptime: Math.round(process.uptime()) };
  if (!IS_PROD) body.ip = req.ip;
  res.status(dbOk ? 200 : 503).json(body);
});

let lastLeadAt = 0;

// ------ Заявка с лендинга ------
// Форма на ztbase.ru обещает, что заявки придут в мессенджер, поэтому
// заявка уходит в Telegram: почта на домене не работает, а бот работает.
app.post('/lead', (req, res) => {
  // Медленная проверка: обычная отсекает ботов почти полностью, honeypot
  // добивает тех, кто отправляет форму не из браузера.
  const hp = (req.body && req.body.website) || '';
  if (hp) return res.status(200).send('ok');

  const now = Date.now();
  if (now - (lastLeadAt || 0) < 2000) {
    return res.status(429).send('Слишком часто. Подождите пару секунд и отправьте ещё раз.');
  }
  lastLeadAt = now;

  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 300);
  const name = clean(req.body.name, 120);
  const contact = clean(req.body.contact, 160);
  const message = clean(req.body.message, 2000);

  // Без контакта заявку некуда обработать: телефона и почты может не быть.
  if (!name || !contact) {
    return res.status(400).send('Укажите имя и способ связи');
  }

  const lines = [
    'Новая заявка с сайта',
    '',
    `Имя: ${name}`,
    `Связь: ${contact}`,
  ];
  if (message) lines.push('', `Сообщение: ${message}`);
  const text = lines.join('\n');

  const { send, configured } = require('./src/services/telegram');

  // В отличие от уведомлений о нарядах, здесь ждать ответа Telegram нужно:
  // посетителю нельзя показать «отправлено», если заявка никуда не ушла.
  // Одна повторная попытка — маршрут до Telegram местами подвисает.
  const deliver = async () => {
    if (!configured) return { skipped: true };
    let last = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await send(text, { timeoutMs: 10000 });
      if (last.status === 200) return last;
      await new Promise(r => setTimeout(r, 1200));
    }
    return last;
  };

  deliver().then(result => {
    if (result.skipped) {
      console.log('Заявка с сайта (Telegram не настроен):\n' + text);
      return;
    }
    if (result.status === 200) return;

    // Не полагаемся только на Telegram: каждая неотправленная заявка
    // дописывается в файл, чтобы её можно было поднять вручную.
    const stamp = new Date().toISOString();
    try {
      const fs = require('fs');
      const dir = process.env.LEAD_LOG_DIR || '/var/lib/ztlab';
      fs.appendFileSync(`${dir}/leads.log`,
        `\n===== ${stamp} · не доставлено в Telegram (${result.error || result.status}) =====\n${text}\n`);
    } catch (e) {
      console.error('Не удалось записать заявку в leads.log:', e.message);
    }
    console.error('Заявка не доставлена в Telegram:', JSON.stringify(result));
  });

  res.status(200).send(
    'Заявка принята. Мы свяжемся с вами в рабочее время. ' +
    'Если не дождётесь звонка — напишите нам в Telegram или WhatsApp.'
  );
});

// ------ Middleware авторизации ------
  // /join — вход нового сотрудника по одноразовому коду. Публичный
  // по существу: человек приходит по ссылке из мессенджера ещё без
  // сессии. Свою проверку кода делает маршрут, а лабораторию код
  // определяет сам — в форме её выбрать нельзя.
  const PUBLIC_PATHS = new Set([
    '/login', '/set-user', '/register', '/register-lab', '/health', '/lead', '/logout',
    '/join', '/legal/privacy', '/legal/offer',
    // Восстановление пароля приходит по ссылке из письма, то есть
    // до всякой сессии. Саму ссылку проверяет маршрут, а форма запроса
    // открыта всем: иначе забытый пароль нельзя было бы восстановить.
    '/password/reset', '/password/set',
  ]);

  // Экран продления и его форма должны работать без действующей подписки.
  // Это не ослабление проверки: внутри /trial нет ни одного рабочего
  // раздела, там только текст и заявка на продление. Держать их в общем
  // списке необязательно — проверка пробного периода ниже специально
  // пропускает этот префикс.
  const TRIAL_PATHS = ['/trial'];

// Редактор содержимого пропускается мимо общей проверки, иначе запрос
// без сессии ушёл бы на /login и до маршрута не дошёл. Свою проверку
// раздел всё равно делает: пароль, если он задан, и роль администратора.
// /public и обе админки должны доходить до своих обработчиков без
// сессии: там своя проверка — пароль администратора. Иначе глобальный
// редирект на /login перехватывал бы запрос раньше Basic-аутентификации,
// и вместо ответа 401 клиент получал бы 302 и не понимал, что нужен пароль.
const PUBLIC_PREFIXES = ['/public', '/admin/content'];

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) ||
      PUBLIC_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }
  if (!req.session.user) {
    return res.redirect('/login');
  }
  // Роль и пользователь нужны каждому экрану, а не только главному:
  // навигация решает по роли, какие плитки вообще показывать.
  // Явные параметры res.render по-прежнему имеют приоритет.
res.locals.currentUser = req.session.user;
    res.locals.isAdmin = req.session.role === 'admin';
    res.locals.isDentist = req.session.role === 'dentist';

        // Пробный период закончился: весь функционал закрыт, лаборатория
        // видит экран продления. Данные не удаляются — после оплаты всё
        // вернётся как было.
        //
        // Проверка после проверки сессии: неавторизованный посетитель должен
        // получить /login, а не экран оплаты чужой лаборатории.
        if (!TRIAL_PATHS.some((prefix) => req.path.startsWith(prefix)) &&
            TRIAL.trialExpired(db, req.session.labId)) {
          return res.redirect('/trial');
        }

        // Незавершённая настройка: показываем мастер вместо рабочих
        // экранов. Это только первый запуск лаборатории — после «пропустить»
        // флаг снимается и мастер больше не появляется сам. Проверяем
        // администратора, а не любого вошедшего: врачу мастер не нужен, и
        // его не должно уводить с чужой настройки.
      if (req.session.role === 'admin' &&
        !req.path.startsWith('/setup') &&
        req.path !== '/logout' &&
        setupPending(db, req.session.labId)) {
      return res.redirect('/setup');
    }
    next();
  });

// Только администратор лаборатории (удаление файлов, пользователи).
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.status(403).send('Недостаточно прав');
  }
  next();
}

// ------ Заказ-наряды ------
// Маршруты подключаются здесь, после requireAdmin: наряды нуждаются
// в этой проверке прав и в переменной db.
app.use('/orders', createOrderRoutes({ db, requireAdmin }));

  // Мастер первичной настройки. Свой requireAdmin внутри: мастер
  // доступен только тому, кто зарегистрировал лабораторию.
  app.use('/setup', createSetupRoutes({ db, requireAdmin, hashPassword }));

// ------ Разделы, не связанные с отдельным нарядом ------
// Переписка, пользователи с кодами, уведомления и редактор этапов.
// Маршруты лежат в корне (/messages, /users, /notifications, /options,
// /join), поэтому подключаются без префикса.
//
// Правила области видиния — те же, что у нарядов: врач видит в
// инбоксе переписку своей клиники, лаборатория — все. Иначе инбокс
// стал бы обходным путём к чужой корреспонденции.
// Правовые документы подключаются до проверки сессии: на них стоят
  // ссылки в форме регистрации, и человек обязан прочитать их до того,
  // как согласится на обработку данных. Маршруты сами по себе публичные
  // и ничего, кроме текста, не отдают.
  app.use(createLegalRoutes());

app.use(createSectionRoutes({
  db, requireAdmin, hashPassword,
  labId: (req) => req.session.labId || 1,
  isDentist: (req) => req.session.role === 'dentist',
  // Область видимости врача копируется из маршрутов нарядов: клиника
  // берётся из его учётной записи, а не из формы.
  dentistScope: (req) => {
    const row = db.prepare('SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?')
      .get(req.session.userId, req.session.labId || 1);
    return { name: req.session.user, clinicId: row && row.clinic_id ? row.clinic_id : null };
  },
}));

// ------ Коды приглашений ------
// Регистрация новых сотрудников идёт по одноразовому коду внутри
// лаборатории: /users выдаёт код, сотрудник входит на /join.
const TRIAL = require('./src/services/trial');
app.locals.TRIAL_DAYS = TRIAL.TRIAL_DAYS;

// ------ Единая панель настроек ------
// Сами разделы разъехались по разным адресам, а ссылок на них в меню
// не было: найти их можно было, только зная адрес. Хаб ничего не
// меняет — он даёт одну точку входа и виден только администратору.
app.get('/admin', requireAdmin, (req, res) => {
    // Счётчик мест нужен прямо на главной админки: человек должен
    // видеть, сколько осталось, не заходя в форму добавления.
    res.render('admin-home', {
      usage: license.usage(db, req.session.labId || 1),
      setupPendingHere: setupPending(db, req.session.labId || 1),
    });
  });

// ------ Редактор содержимого сайта ------
// Отдельный сервис на C++ для этого не делаем: авторизация, роли и
// загрузка файлов в проекте уже есть, а новая админка — это несколько
// маршрутов в том же приложении. Второй стек означал бы второе
// развёртывание и вторую поверхность атаки ради правки текста.
app.use('/admin/content', require('./src/routes/content-admin'));

// ------ Маршруты ------

// Восстановление пароля и вход по одноразовой ссылке. Маршруты
// публичные, но бесполезны без ссылки из письма: её хранит только
// хэш, поэтому по содержимому базы войти нельзя.
app.use(createPasswordRoutes({ db, hashPassword, attemptsFor }));

// Страница входа
app.get('/login', async (req, res) => {
  // Адрес лаборатории можно указать один раз и потом просто входить по паролю.
  // Ссылка вида /login?lab=ivanova приходит из письма или закладки.
  const preslug = String(req.query.lab || '').trim();
  const error = String(req.query.error || '');
  res.render('login', { error: error || null, preslug });
});

// Страница регистрации лаборатории
app.get('/register', async (req, res) => {
  res.render('register', { error: null });
});

// Вход по имени и паролю. Раньше пароля не было: на странице входа был
// выбор имени из списка, что неприемлемо, когда в системе чужие лаборатории.
app.post('/set-user', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const slug = (req.body.lab_slug || '').trim().toLowerCase();
  const ip = req.ip || 'unknown';
  // Счётчик ведём по паре «адрес + сотрудник», а не только по адресу:
  // за одним роутером сидит вся лаборатория, и общий счётчик на адрес
  // блокировал бы вход сразу всем после пары чужих ошибок.
  const ipKey = `ip:${ip}`;
  const userKey = `user:${ip}:${slug}:${username}`;

  if (attemptsFor(ipKey) > MAX_ATTEMPTS_PER_IP || attemptsFor(userKey) > MAX_ATTEMPTS) {
    return res.status(429).render('login', { error: 'Слишком много попыток. Подождите 15 минут.', preslug: slug });
  }

  const fail = (msg, status) => res.status(status).render('login', { error: msg, preslug: slug });

  try {
    // Лабораторию нужно знать заранее: одно и то же имя может быть
    // у сотрудника любой лаборатории, искать по всем сразу нельзя —
    // иначе можно войти в чужую лабораторию, назвав чужое имя.
    if (!slug) {
      return fail('Укажите адрес лаборатории', 400);
    }
    const lab = query('SELECT id, slug FROM labs WHERE slug = ?', [slug]);
    if (lab.rows.length === 0) {
      // Не сообщаем, существует ли адрес, чтобы не перебирать лаборатории.
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }
    const labId = lab.rows[0].id;

    const result = query(
      'SELECT * FROM users WHERE name = ? AND lab_id = ?',
      [username, labId]
    );
    if (result.rows.length === 0) {
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }

    const user = result.rows[0];
    if (!user.active) {
      return fail('Учётная запись отключена', 403);
    }
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      return fail('Неверное имя, пароль или адрес лаборатории', 401);
    }

clearAttempts([ipKey, userKey]);
      req.session.user = username;
      req.session.userId = user.id;
      req.session.labId = labId;
    req.session.role = user.role;
    req.session.labSlug = slug;
    // После входа открываем список заказ-нарядов, а не обмен файлами:
    // заказ-наряд — то, ради чего обращаются в лабораторию, и раньше
    // приходилось начинать с файлообменника, где нужного раздела не видно.
    res.redirect('/orders');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

app.get('/logout', (req, res) => {
  // Адрес лаборатории запоминаем, чтобы на форме входа он уже был заполнен.
  const slug = req.session.labSlug || '';
  req.session.destroy(() => {
    res.redirect(slug ? `/login?lab=${encodeURIComponent(slug)}` : '/login');
  });
});

// ---- Пробный период: закончился ----
//
// Экран показывает, что произошло, и куда писать. Функционал при этом
// закрыт целиком, но данные на месте: после оплаты человек возвращается
// к своим нарядам, а не начинает заново.
app.get('/trial', (req, res) => {
  const lab = req.session.labId
    ? db.prepare('SELECT name, trial_until, trial_email, trial_phone FROM labs WHERE id = ?')
      .get(req.session.labId)
    : null;
  res.render('trial-expired', {
    lab,
    loggedIn: !!req.session.user,
    error: req.query.error ? String(req.query.error) : null,
    sent: req.query.sent === '1',
  });
});

// Продление. Оплаты онлайн ещё нет, поэтому действие одно: доступ снимает
// менеджер после оплаты. Заявка уходит тем же путём, что и с лендинга, —
// в Telegram, а если он не настроен, в leads.log. Писать в базу некуда:
// таблицы заявок нет, а заводить её ради одной формы избыточно.
app.post('/trial/renew', (req, res) => {
  const check = TRIAL.validateContact(req.body.email, req.body.phone);
  if (!check.ok) {
    return res.redirect('/trial?error=' + encodeURIComponent(check.error));
  }
  const lab = req.session.labId
    ? db.prepare('SELECT name, trial_until, trial_email FROM labs WHERE id = ?').get(req.session.labId)
    : null;
  const text = [
    'ЗАЯВКА НА ПРОДЛЕНИЕ',
    `Лаборатория: ${lab ? lab.name : 'не указана'}`,
    `E-mail: ${check.email}${check.phone ? `, тел.: ${check.phone}` : ''}`,
    `Пробный период истёк: ${lab && lab.trial_until ? lab.trial_until : '—'}`,
    `Контакт при регистрации: ${lab && lab.trial_email ? lab.trial_email : '—'}`,
    `Комментарий: ${String(req.body.message || '').trim().slice(0, 1000) || '—'}`,
  ].join('\n');

  const { send, configured } = require('./src/services/telegram');
  const deliver = async () => {
    if (!configured) return { skipped: true };
    let last = {};
    // Одна повторная попытка: как и на лендинге, маршрут до Telegram
    // местами подвисает, и человек ушёл бы, решив, что заявка пропала.
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await send(text, { timeoutMs: 10000 });
      if (last.status === 200) return last;
      await new Promise(r => setTimeout(r, 1200));
    }
    return last;
  };

  deliver().then(result => {
    if (result.skipped) {
      console.log('Заявка на продление (Telegram не настроен):\n' + text);
      return;
    }
    if (result.status === 200) return;
    // Как и на лендинге: неотправленное не теряем, а дописываем в файл.
    try {
      const fs = require('fs');
      const dir = process.env.LEAD_LOG_DIR || '/var/lib/ztlab';
      fs.appendFileSync(`${dir}/leads.log`,
        `\n===== ${new Date().toISOString()} · продление не доставлено =====\n${text}\n`);
    } catch (e) {
      console.error('Не удалось записать заявку в leads.log:', e.message);
    }
  });

  res.redirect('/trial?sent=1');
});

// Регистрация новой лаборатории. Создаёт лабораторию и первого
// администратора за один шаг, чтобы не пришлось настраивать вручную.
  app.post('/register-lab', async (req, res) => {
    const labName = (req.body.lab_name || '').trim();
    const userName = (req.body.username || '').trim();
    const password = req.body.password || '';

    // Ошибку показываем на самой форме, а не голым текстом: раньше
    // res.send() отдавал пустую страницу, и человек терял всё, что уже
    // набрал, и не понимал, к какому полю претензия.
    const fail = (message, status = 400) => res.status(status).render('register', {
      error: message,
      form: {
        lab_name: req.body.lab_name || '',
        slug: req.body.slug || '',
        username: req.body.username || '',
        email: req.body.email || '',
        phone: req.body.phone || '',
      },
    });

    if (!labName) return fail('Укажите название лаборатории');
    if (!userName) return fail('Укажите имя пользователя');
    if (password.length < 6) return fail('Пароль короче 6 символов');

    // Обязателен только e-mail: без него пробный период нечем продлить,
    // а человек после недели не понимает, куда писать. Телефон необязателен
    // и ошибку его разбора регистрации не роняет. Это персональные данные,
    // поэтому форма регистрации ссылается на политику.
    const contact = TRIAL.validateContact(req.body.email, req.body.phone);
    if (!contact.ok) return fail(contact.error);
  
    try {
    let slug = (req.body.slug || '').trim().toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) slug = 'lab-' + Date.now().toString(36);

    const exists = query('SELECT id FROM labs WHERE slug = ?', [slug]).rows;
    if (exists.length > 0) {
      return fail('Такая лаборатория уже зарегистрирована', 409);
    }

      // Пробный период начинается сразу: неделя отсчитывается от даты
      // регистрации, а не от первого входа. Иначе «пробный» человек,
      // зарегистрировавшийся и ушедший на месяц, обнаружил бы истёкший
      // срок при первом же открытии.
      query(
        'INSERT INTO labs (slug, name, trial_until, trial_email, trial_phone) VALUES (?, ?, ?, ?, ?)',
        [slug, labName, TRIAL.trialUntil(), contact.email, contact.phone]
      );
      const labId = db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug).id;

    query(
      'INSERT INTO users (name, password_hash, role, active, lab_id) VALUES (?, ?, ?, 1, ?)',
      [userName, hashPassword(password), 'admin', labId]
    );

    // Свой прайс заводим сразу при регистрации, а не при первом
    // открытии наряда: лаборатория должна начать работать без
    // предварительного захода на пустую страницу — иначе первый наряд
    // создавался бы в окружении с пустым справочником.
    constructions.seed(db, labId);

  req.session.user = userName;
      req.session.userId = query(
        'SELECT id FROM users WHERE name = ? AND lab_id = ?', [userName, labId]
      ).rows[0].id;
      req.session.labId = labId;
      req.session.role = 'admin';
    req.session.labSlug = slug;
    // Телефон мог не распознаться. На следующей странице один раз
    // покажем это и снимем, иначе сообщение так и не появится.
    if (contact.warning) req.session.notice = contact.warning;

    // Данные для входа уходят на указанную при регистрации почту.
    // Пароль в письме не пересылаем: вместо него — одноразовая
    // ссылка, по которой человек задаст пароль заново, если
    // потеряет свой. Лаборатория и сотрудник к этому моменту уже
    // созданы, поэтому письмо — только подсказка, и его ошибка не
    // должна превращать успешную регистрацию в 500.
    const { token: welcomeToken } = RESET.createReset(db, req.session.userId);
    await mailer.send(mailer.welcomeMail({
      to: contact.email,
      labSlug: slug,
      username: userName,
      link: `${mailer.originFor(req)}/password/set?token=${encodeURIComponent(welcomeToken)}`,
    }));

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка при регистрации');
  }
});


// Главная страница (с перенаправлением для Елены и динамическим поиском)
// Хаб приложения: точка входа после входа. Раньше на '/' стоял обмен
// файлами, и человек, открывая программу, попадал в случайный раздел.
// Теперь '/' — меню разделов, а обмен файлами живёт на '/files'.
app.get('/', (req, res) => {
  const labId = req.session.labId || 1;
  const isDentist = req.session.role === 'dentist';
  const isAdmin = req.session.role === 'admin';

  // Счётчики на плитках: человек должен видеть, что ждёт его внимания,
  // не заходя в каждый раздел по очереди.
  const one = (sql, ...p) => db.prepare(sql).get(labId, ...p).n;

  const orders = isDentist
    ? db.prepare(`
        SELECT COUNT(*) AS n FROM orders
        WHERE lab_id = ?
          AND stage NOT IN ('issued','cancelled')
          AND (clinic_id IS NOT NULL AND clinic_id = (
                SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?)
               OR created_by = ?)
      `).get(labId, req.session.userId, labId, req.session.user).n
    : one("SELECT COUNT(*) AS n FROM orders WHERE lab_id = ? AND stage NOT IN ('issued','cancelled')");

  const files = one('SELECT COUNT(*) AS n FROM files WHERE lab_id = ? AND downloaded = 0');

  // Непрочитанные переписки считает тот же сервис, что и инбокс.
  // Дублировать запрос здесь нельзя: счётчик на хабе обязан считать
  // ровно то же, что человек потом увидит в /messages. Иначе врач
  // получает на главной непрочитанные по чужим клиникам, до которых
  // в инбоксе не дотянуться.
  const ownClinic = isDentist
    ? db.prepare('SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?')
      .get(req.session.userId, labId)
    : null;
  const scope = isDentist
    ? { name: req.session.user, clinicId: ownClinic ? ownClinic.clinic_id : null }
    : null;
  const unread = inbox.unreadTotal(db, labId, req.session.userId, scope);

  res.render('hub', {
    currentUser: req.session.user,
    isAdmin, isDentist,
    counters: { orders, files, unread },
    usage: isAdmin ? license.usage(db, labId) : null,
    setupPendingHere: isAdmin && setupPending(db, labId),
    // Сообщение после регистрации показываем один раз и сразу снимаем:
    // иначе оно висело бы на хабе до конца сессии.
    notice: req.session.notice || null,
  });
  if (req.session.notice) delete req.session.notice;
});

// Обмен файлами. Раньше этот экран занимал '/', и из-за него навигация
// начиналась со случайного раздела.
app.get('/files', async (req, res) => {
  const { date, uploader, downloaded, filename } = req.query;

  let sql = 'SELECT * FROM files';
  const params = [];
  const conditions = [];

  // Ограничение по лаборатории добавляется первым условием и всегда:
  // без него заказы других лабораторий были бы видны.
  const labId = req.session.labId || 1;
  conditions.push('lab_id = ?');
  params.push(labId);

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

    const uploadersResult = query('SELECT DISTINCT uploader FROM files WHERE lab_id = ?', [req.session.labId || 1]);
    const uploaders = uploadersResult.rows.map(row => row.uploader);

    // Занятое место показываем на странице загрузки: там человек и
    // решает, что грузить. Обход папки дёшево, но ошибку чтения глотать
    // нельзя — иначе вместо суммы в шаблон уехал бы ноль.
    let storageUsage = null;
    try {
      storageUsage = await quota.status(labId);
    } catch (e) {
      // Сбой подсчёта не должен ронять страницу: загрузка всё равно
      // получит отказ на проверке места.
      console.error('Не удалось посчитать занятое место:', e.message);
    }

    res.render('index', {
      files,
      groupedFiles,
      todayKey: today,
      users: uploaders,
      currentUser: req.session.user,
      isAdmin: req.session.role === 'admin',
      filters: { date, uploader, downloaded, filename },
      storageUsage
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

  const uploader = req.session.user;
  const labId = req.session.labId || 1;
  const uploadDate = new Date().toISOString();
  const milled = req.body.milled === 'on';
  const baked = req.body.baked === 'on';
  const comment = req.body.comment || '';

  const tmpDirs = new Set();
  const collectTmp = (f) => {
    if (f && f.path) {
      tmpDirs.add(path.dirname(f.path));
      if (f.filename) f.savedAs = f.filename;
    }
  };
  stlFiles.forEach(collectTmp);
  collectTmp(imageFile);

  try {
    // Проверяем место ДО переноса файлов: если лимит уже выбран, файл
    // не должен даже на секунду ложиться на диск. 507 — честный код
    // «не хватило места», клиент покажет текст ошибки как есть.
    const incomingBytes = stlFiles.reduce((sum, f) => sum + (f.size || 0), 0)
      + (imageFile ? imageFile.size || 0 : 0);
    const verdict = await quota.check({ labId, bytes: incomingBytes });
    if (!verdict.ok) {
      return res.status(507).send(verdict.message);
    }

    // Переносим файлы из временной папки в хранилище лаборатории.
    // При STORAGE_BACKEND=s3 это единственное место, где идёт загрузка.
    let imageName = null;
    if (imageFile) {
      imageName = await storage.put(imageFile.path, labId, imageFile.savedAs);
    }
    const stlRows = [];
    for (const f of stlFiles) {
      const savedAs = await storage.put(f.path, labId, f.savedAs);
      stlRows.push([Buffer.from(f.originalname, 'latin1').toString('utf8'), savedAs]);
    }

    const insertStmt = db.prepare(
      `INSERT INTO files
       (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment, lab_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((rows) => {
      for (const [decodedStlName, storedStlName] of rows) {
        insertStmt.run(decodedStlName, storedStlName, imageName, uploader, uploadDate, 0, milled ? 1 : 0, baked ? 1 : 0, comment, labId);
      }
    });
    insertAll(stlRows);
    res.redirect('/');
  } catch (err) {
    console.error('Ошибка при загрузке файлов:', err);
    res.status(500).send('Ошибка при сохранении в БД.');
  } finally {
    // Временные папки убираем в любом случае, иначе они разрастаются.
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (e) {
        console.error('Не удалось убрать временную папку:', d, e.message);
      }
    }
  }
});

// Понятный ответ вместо 500, когда загрузку остановил multer.
// Свои коды отдаём как есть, остальные ошибки разбора формы —
// как «не удалось загрузить», чтобы пользователь не гадал.
app.use((err, req, res, next) => {
  if (!err || !err.name || !err.name.startsWith('Multer')) return next(err);

  // Часть файлов к этому моменту уже лежит во временных папках.
  if (req.ztlabTmpDirs) {
    for (const d of req.ztlabTmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* не критично */ }
    }
    req.ztlabTmpDirs.clear();
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send(
      `Файл больше ${MAX_FILE_MB} МБ. Загрузите модель в меньшем размере или сожмите архив.`
    );
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT'
      || err.code === 'LIMIT_FIELD_COUNT') {
    return res.status(413).send('Слишком много файлов или полей в запросе.');
  }
  console.error('Ошибка загрузки:', err.code || err.message);
  res.status(400).send('Не удалось загрузить файлы. Проверьте размер и количество файлов.');
});

// Скачивание 3D-файла
app.get('/download/:id', async (req, res) => {
  const fileId = req.params.id;
  const downloader = req.session.user;

  try {
    const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
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
        'UPDATE files SET downloaded = 1, downloaded_by = ?, downloaded_date = ? WHERE id = ? AND lab_id = ?',
        [downloader, downloadDate, fileId, req.session.labId || 1]
      );
    } else {
      const newList = updateDownloaders(file.downloaded_by, downloader);
      if (newList !== file.downloaded_by) {
        query(
          'UPDATE files SET downloaded_by = ? WHERE id = ? AND lab_id = ?',
          [newList, fileId, req.session.labId || 1]
        );
      }
    }

    await storage.sendFile(res, file.lab_id || 1, file.stored_name, file.original_name);
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
    const result = query('SELECT image_name, lab_id FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    // Через storage, а не sendFile: при STORAGE_BACKEND=s3 файла на диске нет.
    await storage.sendFile(res, file.lab_id, file.image_name, file.image_name, true);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка сервера');
  }
});

// Скачивание изображения
app.get('/download-image/:id', async (req, res) => {
  const fileId = req.params.id;
  try {
    const result = query('SELECT image_name, lab_id, original_name FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (result.rows.length === 0 || !result.rows[0].image_name) {
      return res.status(404).send('Изображение не найдено.');
    }
    const file = result.rows[0];
    await storage.sendFile(res, file.lab_id || 1, file.image_name, file.original_name);
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
    const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
    if (fileResult.rows.length === 0) {
      return res.status(404).send('Файл не найден');
    }
    const file = fileResult.rows[0];

    try {
      await storage.remove(file.lab_id || 1, file.stored_name);
      if (file.image_name) {
        await storage.remove(file.lab_id || 1, file.image_name);
      }
    } catch (err) {
      console.error('Ошибка удаления файлов:', err);
    }

    await query('DELETE FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
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
    await query('UPDATE files SET milled = NOT milled WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

app.post('/toggle-baked/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).send('Не авторизован');
  try {
    await query('UPDATE files SET baked = NOT baked WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
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
    await query('UPDATE files SET comment = ? WHERE id = ? AND lab_id = ?', [comment, req.params.id, req.session.labId || 1]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка БД');
  }
});

// Страница добавления пользователя
app.get('/add-user', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const usage = license.usage(db, req.session.labId || 1);
    res.render('add-user', {
      error: null, usage, warning: license.warningFor(usage),
      specializations: SPEC.BY_ROLE,
    });
  });

// Добавление сотрудника в лабораторию. Только администратор.
app.post('/add-user', requireAdmin, async (req, res) => {
    const { password, newUsername, role } = req.body;
    const name = (newUsername || '').trim();
    const labId = req.session.labId || 1;
    // Места в тарифе считаем на каждой попытке добавить человека, а не
    // один раз при загрузке формы: между открытием и отправкой могли
    // завести ещё двоих.
    const usage = license.usage(db, labId);
    const fail = (msg) => res.render('add-user', { error: msg, usage, warning: license.warningFor(usage) });

    if (!name) {
      return fail('Имя не может быть пустым');
    }
    if (!password || password.length < 6) {
      return fail('Пароль должен быть не короче 6 символов');
    }

    const newRole = role === 'admin' ? 'admin' : 'tech';
    // Специализация не выбирает роль и не даёт прав: это подпись «кем
    // работает». Значение из другой роли отбрасываем, иначе через
    // подделанную форму можно было бы записать технику «бухгалтером».
    const specialization = SPEC.fromForm(newRole, req.body.specialization);

    try {
      const existing = query(
        'SELECT id FROM users WHERE name = ? AND lab_id = ?',
        [name, labId]
      ).rows;
      if (existing.length > 0) {
        return fail('Пользователь с таким именем уже существует');
      }
    query(
      'INSERT INTO users (name, password_hash, role, specialization, active, lab_id) VALUES (?, ?, ?, ?, 1, ?)',
      [name, hashPassword(password), newRole, specialization, req.session.labId || 1]
    );
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('add-user', { error: 'Ошибка базы данных', usage, warning: license.warningFor(usage) });
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

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

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

    // Доступ к титановым основаниям — у администратора лаборатории.
    // Раньше это определялось именем «Елена», что не переносилось на другие лаборатории.
    const isAdmin = (req.session.role === 'admin');

    res.render('titan', {
      orders: orders,
      groupedOrders: groupedOrders,
      todayKey: todayKey, // передаём исправленную дату
      currentUser: req.session.user,
      isAdmin: isAdmin,
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
       (order_date, order_number, system_name, size, has_hex, created_by, lab_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
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
          req.session.user,
          req.session.labId || 1
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

// Переключение статуса основания — только для администратора лаборатории
app.post('/titan/toggle-status/:id', requireAdmin, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }
  const id = req.params.id;
  try {
    const current = query('SELECT status FROM titan_orders WHERE id = ? AND lab_id = ?', [id, req.session.labId || 1]);
    if (current.rows.length === 0) return res.status(404).json({ success: false });
    const newStatus = current.rows[0].status === 'pending' ? 'issued' : 'pending';
    await query('UPDATE titan_orders SET status = ? WHERE id = ? AND lab_id = ?', [newStatus, id, req.session.labId || 1]);
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

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

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

    // Фильтр по лаборатории добавляется всегда, до остальных условий.
    conditions.push('lab_id = ?');
    params.push(req.session.labId || 1);

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
//
// HOST: на боевой машине приложение слушает только петлю, а не всю сеть.
// Иначе любой, кто достучится до порта напрямую, обратится к нему в
// обход nginx и без HTTPS.
const HOST = process.env.HOST || '0.0.0.0';
const OPEN_BROWSER = process.env.OPEN_BROWSER !== '0';
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD) {
  // В боевом режиме браузер не открываем, логи идут в systemd.
  console.log(`✅ ZT Lab запущен: http://${HOST}:${PORT}`);
} else {
  console.log(`✅ Сервер запущен на http://${HOST}:${PORT}`);
  console.log('Для доступа с других компьютеров используйте IP-адрес этого компьютера');
}

if (OPEN_BROWSER && !IS_PROD) {
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
// Слушаем только на HOST. В бою это 127.0.0.1: наружу открыт только
// nginx, в разработке — 0.0.0.0, чтобы было видно с других устройств.
app.listen(PORT, HOST, () => {
  console.log(`📡 Слушаем ${HOST}:${PORT}`);
});
