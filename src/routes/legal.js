// Правовые документы: политика конфиденциальности и оферта.
//
// Ссылки на них стоят в форме регистрации, но маршрутов не было:
// запрос уходил в проверку сессии и возвращал 302 на /login. Человек,
// соглашавшийся с обработкой персональных данных, не мог прочитать, о
// чём соглашается.
//
// Документы лежат в deploy/landing/legal — там же их публикует лендинг.
// Приложение читает файлы оттуда, чтобы текст не расходился между
// сайтом и программой: править придётся в одном месте.
//
// В файлах контакты записаны метками {{phone}} и {{email}}: те же
// шаблоны использует лендинг. Подстановка обязательна, иначе человек
// прочитал бы в оферте «Связь: {{email}}» вместо адреса.

const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const landing = require('../services/landing-render');

// Куда смотреть за документами. В разработке это deploy/landing/legal
// рядом с server.js, при установке в /opt/ztlab — тот же путь внутри
// проекта. Если файла нет, страница отдаёт понятный текст, а не 404:
// отсутствие документа о правах выглядит как отказ их показывать.
const LEGAL_DIR = path.join(__dirname, '..', '..', 'deploy', 'landing', 'legal');

// Контакты для подстановки. Читаются из того же site.json, который
// правится через /admin/content, и кэшируются на минуту: документ
// открывают редко, а файл на каждый запрос читать незачем.
let contactsCache = null;
let contactsAt = 0;
const CONTACTS_TTL_MS = 60 * 1000;

function readContacts() {
  const now = Date.now();
  if (contactsCache && now - contactsAt < CONTACTS_TTL_MS) return contactsCache;
  const file = path.join(cfg.contentDir, 'site.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  contactsCache = landing.readContacts(JSON.stringify(raw)).contacts;
  contactsAt = now;
  return contactsCache;
}

module.exports = function createLegalRoutes() {
  const router = express.Router();

  const page = (file, title) => (req, res) => {
    let html = '';
    try {
      const contacts = readContacts();
      html = landing.render(fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8'), contacts);
    } catch (err) {
      console.error('Правовой документ не прочитан:', err.message);
      // Документ о правах должен открываться всегда: отсутствие текста
      // выглядит как отказ их показывать, а человек соглашался на
      // обработку данных именно под этим текстом.
      html = `<p>Документ временно недоступен. Свяжитесь с нами: Telegram, WhatsApp или почта на сайте.</p>`;
    }
    // Обёртка нужна, потому что документы самостоятельные HTML-страницы
    // лендинга: без неё они открылись бы без меню приложения.
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ZT Lab</title>
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<header class="app-header">
  <h1>ZT Lab</h1>
  <span class="who"><a href="/">В меню</a></span>
</header>
<main class="legal">
  ${html}
</main>
</body>
</html>`);
  };

  router.get('/legal/privacy', page('privacy.html', 'Политика конфиденциальности'));
  router.get('/legal/offer', page('offer.html', 'Договор оферты'));

  // Те же документы под адресами лендинга. Нужны потому, что файлы
  // общие: один и тот же offer.html отдаётся и приложением
  // (/legal/offer), и лендингом (/offer.html, скрипт раскладки
  // расплющивает папку legal/). Ссылка внутри документа должна
  // работать в обоих случаях, а относительная не работает: на
  // /legal/offer она превратилась бы в /legal/privacy.html.
  //
  // Поэтому в разметке стоит абсолютный /privacy.html, а эти два
  // маршрута делают его верным и в приложении.
  router.get('/privacy.html', page('privacy.html', 'Политика конфиденциальности'));
  router.get('/offer.html', page('offer.html', 'Договор оферты'));

  return router;
};