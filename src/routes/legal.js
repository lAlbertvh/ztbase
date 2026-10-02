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

const express = require('express');
const fs = require('fs');
const path = require('path');

// Куда смотреть за документами. В разработке это deploy/landing/legal
// рядом с server.js, при установке в /opt/ztlab — тот же путь внутри
// проекта. Если файла нет, страница отдаёт понятный текст, а не 404:
// отсутствие документа о правах выглядит как отказ их показывать.
const LEGAL_DIR = path.join(__dirname, '..', '..', 'deploy', 'landing', 'legal');

module.exports = function createLegalRoutes() {
  const router = express.Router();

  const page = (file, title) => (req, res) => {
    let html = '';
    try {
      html = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8');
    } catch (err) {
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

  return router;
};