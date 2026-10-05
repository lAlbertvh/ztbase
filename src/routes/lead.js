// Заявка с лендинга.
//
// Отдельный маршрут потому, что он единственный принимает заявку без
// сессии: посетитель сайта ещё не работал в приложении. Собственных
// проверок почти нет — секретность здесь не нужна, а вот спам-защита
// нужна, поэтому стоит простой счётчик по адресу.

const express = require('express');

module.exports = function createLeadRoutes() {
  const router = express.Router();

  // Форма на ztbase.ru обещает, что заявки придут в мессенджер, поэтому
  // заявка уходит в Telegram: почта на домене не работает, а бот работает.
  router.post('/lead', (req, res) => {
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

    const { send, configured } = require('../services/telegram');

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

  return router;
};
