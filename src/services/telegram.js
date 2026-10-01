'use strict';

// Уведомления в Telegram.
//
// Зачем: почта на домене не работает (MX указывает на VPS, а почтового
// сервера там нет), а Telegram работает и доставляет за секунду. Для
// заказ-нарядов это удобнее почты: уведомление о новом заказе приходит
// на телефон мгновенно.
//
// Отправка не должна влиять на работу приложения: если Telegram недоступен,
// наряд всё равно должен сохраниться. Поэтому notify() ничего не бросает
// наружу и не задерживает ответ — ошибка только пишется в лог.

const https = require('https');
const { URL } = require('url');

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const apiHost = 'api.telegram.org';

// У провайдера ноутбука маршрут до адреса, который отдаёт DNS
// (149.154.166.110), не проходит: соединение виснет до таймаута. При этом
// другой адрес того же Telegram (149.154.167.220) отвечает нормально.
// Поэтому адрес задаётся явно: SNI и Host остаются api.telegram.org,
// сертификат проверяется как обычно, меняется только точка подключения.
const apiIp = process.env.TELEGRAM_API_IP || '';

const configured = Boolean(token && chatId);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Telegram не принимает HTML-теги в произвольной разметке без
// parse_mode, поэтому экранируем спецсимволы и отправляем plain text.
function send(text, { timeoutMs = 8000 } = {}) {
  if (!configured) return Promise.resolve({ skipped: true });

  const payload = JSON.stringify({
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });

  return new Promise(resolve => {
    const url = new URL(`https://${apiHost}/bot${token}/sendMessage`);
    const req = https.request(
      {
        // connect через заданный IP, но имя для SNI и Host — настоящее,
        // иначе TLS-сертификат не совпадёт.
        hostname: apiIp || url.hostname,
        servername: apiHost,
        path: url.pathname,
        method: 'POST',
        headers: {
          Host: apiHost,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', err => resolve({ error: err.message }));
    req.write(payload);
    req.end();
  });
}

// fire-and-forget: вызывающий код не ждёт и не может упасть из-за Telegram.
function notify(text) {
  send(text).then(res => {
    if (res.error) console.error('Telegram: не отправлено —', res.error);
    else if (res.status && res.status !== 200) {
      console.error('Telegram: ответ', res.status);
    }
  }).catch(err => console.error('Telegram:', err.message));
  return undefined;
}

function newOrderMessage(order, labName) {
  const lines = [
    'Новый заказ-наряд',
    '',
    `Номер: ${order.order_number || '—'}`,
    `Клиника: ${order.customer || '—'}`,
    `Пациент: ${order.patient || '—'}`,
  ];
  if (order.phone) lines.push(`Телефон: ${order.phone}`);
  if (order.teeth) lines.push(`Зубы: ${order.teeth}`);
  if (order.work_kind) lines.push(`Вид: ${order.work_kind}`);
  if (labName) lines.push('', `Лаборатория: ${labName}`);
  return lines.join('\n');
}

module.exports = { notify, send, newOrderMessage, configured, escapeHtml, apiIp, apiHost };
