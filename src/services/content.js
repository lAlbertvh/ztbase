'use strict';

// Хранилище содержимого сайта.
//
// Идея: тексты лежат в JSON, а не в коде, чтобы владелец лаборатории
// менял их сам через /admin/content, без правок исходников и без
// перезапуска сервиса.
//
// Почему JSON, а не таблица в SQLite: содержимое сайта редактируют
// редко и целиком, поштучный SQL здесь не нужен, а JSON легко
// положить в git рядом с остальным проектом и посмотреть глазами
// при необходимости. Побочный плюс — сайт не падает, если база
// приложения недоступна.
//
// Файл пишется через временный файл с последующим переименованием:
// иначе при сбое питания в момент записи остался бы обрезанный JSON.

const fs = require('fs');
const path = require('path');

const contentDir = path.resolve(
  process.env.CONTENT_DIR || path.join(__dirname, '..', '..', 'content')
);
const contentFile = path.join(contentDir, 'site.json');

// Значения по умолчанию повторяют текущий текст лендинга. Нужны в двух
// случаях: файл ещё не создан, и поле добавили в модель позже — тогда
// старое содержимое доедет с дефолтом, а не останется пустым.
const DEFAULTS = {
  site: {
    title: 'ZT Lab — зуботехническая лаборатория',
    description:
      'Ортопедические конструкции из цифровых моделей: коронки, мосты, ' +
      'виниры, протезы. Срок от 2 дней, срочно за 1 день.',
    keywords: 'зуботехническая лаборатория, коронки из цифровых моделей, ' +
      'зубные протезы, ортопедические конструкции',
  },
  contacts: {
    phone: '+7 923 483-65-94',
    email: 'alik_alikovich@mail.ru',
    messengers: 'Telegram, WhatsApp',
    // Адрес здесь пустой намеренно. Раньше стоял «Санкт-Петербург» —
    // выдуманный город, который показывался бы посетителям, если бы
    // site.json потерялся или приехал без этого поля. Пустая строка
    // честнее: на сайте будет «адрес не задан», и это видно.
    address: '',
    workHours: 'Пн–Пт, 9:00–19:00',
  },
  hero: {
    title: 'Ортопедические конструкции без срывов сроков',
    subtitle:
      'Принимаем STL и цифровые модели, возвращаем готовую конструкцию ' +
      'за 2–5 рабочих дней. Срочные заказы делаем за 1 день.',
    ctaText: 'Рассчитать стоимость',
  },
  services: [
    { title: 'Коронки и мосты', text: 'Циркониевые, литий-дисиликатные, фарфоровые.' },
    { title: 'Виниры и накладки', text: 'Эстетика с проверкой контактов и цвета.' },
    { title: 'Съёмные протезы', text: 'Бюгельные, акриловые, с металлическим каркасом.' },
    { title: 'Хирургические шаблоны', text: 'Изготовление по цифровому сканированию.' },
  ],
  steps: [
    { title: 'Заявка', text: 'Присылаете STL или 3MF, уточняете материал и срок.' },
    { title: 'Подтверждение', text: 'Менеджер проверяет модель и называет точную цену.' },
    { title: 'Производство', text: 'Фрезерование, обжиг, коррекция — этапы видно в кабинете.' },
    { title: 'Отгрузка', text: 'Передаём файлы или отправляем курьером.' },
  ],
  advantages: [
    { title: 'Прозрачные этапы', text: 'Статус заказа виден в личном кабинете.' },
    { title: 'Срочные заказы', text: 'Работаем ночью и в выходные.' },
    { title: 'Точность цифры', text: 'Сканирование, совпадение с рентгеном и слепочным шаблоном.' },
    { title: 'Контроль качества', text: 'Проверка окклюзии, контактов и цвета до отправки.' },
    { title: 'Один менеджер', text: 'Один контакт по всем заказам лаборатории.' },
    { title: 'Комплектующие', text: 'Диски, материалы и инструмент в наличии.' },
  ],
  tariffs: [
    { title: 'Коронка из диоксида циркония', price: 'уточняется', text: 'Одиночная коронка, включая фрезерование и обжиг.' },
    { title: 'Винир E.max', price: 'уточняется', text: 'Эстетическая керамика, подбор оттенка.' },
    { title: 'Бюгельный протез', price: 'уточняется', text: 'Каркас и базис, индивидуальная подгонка.' },
    { title: 'Срочный заказ', price: 'уточняется', text: 'От 1 рабочего дня, доплата за срочность.' },
  ],
  images: {
    // Загружаются через админку, хранятся в public/content/.
    logo: '',
    hero: '',
    ogImage: '',
  },
  legal: {
    companyName: 'ООО «ЗТ Лаб»',
    inn: '',
    ogrn: '',
    ogrnip: '',
    legalAddress: '',
  },
  // Отметка последней публикации. Показывается в админке, чтобы было
  // видно, что файл действительно обновился, а не сохранился вхолостую.
  publishedAt: '',
};

function ensureDir() {
  fs.mkdirSync(contentDir, { recursive: true });
}

// Доливание недостающих ключей рекурсивно. Нужно, потому что модель
// со временем расширяется: старый site.json не знает про новые поля.
function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!override || typeof override !== 'object') return out;
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function read() {
  try {
    const raw = fs.readFileSync(contentFile, 'utf8');
    return merge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    // Битый JSON не должен ронять сайт: отдаём значения по умолчанию,
    // а проблему оставляем в логе, чтобы её заметили.
    if (err.code !== 'ENOENT') {
      console.error('content.json не прочитан, беру значения по умолчанию:', err.message);
    }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

// Собирает только те поля, которые форма действительно прислала.
// Иначе форма без изменений затёрла бы, например, загруженные картинки.
function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = String(source[key] ?? '').trim();
  }
  return out;
}

function save(next) {
  ensureDir();
  const tmp = contentFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, contentFile);
  return next;
}

// Списки (services, steps, advantages, tariffs) приходят из формы как
// повторяющиеся поля name="services[0][title]". Разбираем их обратно
// в массив, выбрасывая пустые строки.
function pickList(body, key) {
  const raw = body[key];
  if (!raw) return [];
  const out = [];
  for (const item of raw) {
    const row = pick(item || {}, ['title', 'text', 'price', 'badge']);
    if (!row.title && !row.text && !row.price) continue;
    out.push(row);
  }
  return out;
}

function saveFromForm(body) {
  const current = read();

  const next = {
    site: { ...current.site, ...pick(body.site || {}, ['title', 'description', 'keywords']) },
    contacts: { ...current.contacts, ...pick(body.contacts || {}, ['phone', 'email', 'messengers', 'address', 'workHours']) },
    hero: { ...current.hero, ...pick(body.hero || {}, ['title', 'subtitle', 'ctaText']) },
    images: { ...current.images, ...pick(body.images || {}, ['logo', 'hero', 'ogImage']) },
    legal: { ...current.legal, ...pick(body.legal || {}, ['companyName', 'inn', 'ogrn', 'ogrnip', 'legalAddress']) },
    services: pickList(body, 'services'),
    steps: pickList(body, 'steps'),
    advantages: pickList(body, 'advantages'),
    tariffs: pickList(body, 'tariffs'),
  };

  // Пустой список сносок услуг ломает вёрстку, поэтому держим минимум одну
  // карточку и подставляем заглушку вместо пустоты.
  if (!next.services.length) next.services = DEFAULTS.services.slice();
  if (!next.tariffs.length) next.tariffs = DEFAULTS.tariffs.slice();

  return save(next);
}

module.exports = { read, save, saveFromForm, contentFile, contentDir, DEFAULTS };
