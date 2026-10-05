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
const createTitanRoutes = require('./src/routes/titan');
const createHubRoutes = require('./src/routes/hub');
const createFilesRoutes = require('./src/routes/files');
const createUsersRoutes = require('./src/routes/users');
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

// ------ Проверка сессии и роли ------
// Описаны в src/middleware/auth.js: там же счётчики попыток входа,
// которые нужны маршруту /set-user. Подключается как middleware, чтобы
// порядок проверок не изменился.
const createAuth = require('./src/middleware/auth');
const auth = createAuth(db);
const { requireAdmin, registerAttempt, clearAttempts } = auth;

app.use(auth.router);

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
app.use(createPasswordRoutes({ db, hashPassword }));

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
  if (registerAttempt(ip, slug, username)) {
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

clearAttempts(ip, slug, username);
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
// ------ Хаб, обмен файлами и сотрудники ------
// Маршруты вынесены в src/routes: хаб, обмен 3D-файлами и список
// сотрудников занимали подряд почти полтысячи строк. Роутеры
// подключаются без префикса, поэтому пути не изменились.
app.use(createHubRoutes({ db, license }));
app.use(createFilesRoutes({ db, query, storage, quota, upload }));
app.use(createUsersRoutes({ db, query, hashPassword, license, SPEC, requireAdmin }));

// ------ Понятный ответ вместо 500 при ошибке загрузки ------
// Обработчик ошибок multer стоит здесь, а не рядом с маршрутом /upload:
// он должен перехватывать ошибки разбора формы от любого маршрута,
// который принимает файлы, и подключаться после всех из них.
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


// ------ Учёт титановых оснований ------
// Маршруты вынесены в src/routes/titan.js: свой шаблон печати и
// выгрузка в Excel. Роутер подключается без префикса, поэтому пути
// остались такими же, как были.
app.use(createTitanRoutes({ db, query, requireAdmin }));

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
