// Письма.
//
// Пароль по почте не уходит никогда — ни сам, ни его хэш. В письме
// только то, что человек и так знает: адрес лаборатории, своё имя и
// одноразовая ссылка, по которой пароль задаётся заново.
//
// Провайдер не зашит: SMTP-настройки берутся из окружения, поэтому
// смена ящика — это правка env, а не кода. MAIL_DRY_RUN=1 печатает
// письма в журнал вместо отправки: этим пользуются проверки и
// настройка, чтобы не слать настоящие письма по-настоящему.

const nodemailer = require('nodemailer');
const RESET = require('./password-reset');

const HOST = (process.env.SMTP_HOST || '').trim();
const PORT = Number(process.env.SMTP_PORT) || 465;
const SECURE = process.env.SMTP_SECURE === '1';
const USER = (process.env.SMTP_USER || '').trim();
const PASS = process.env.SMTP_PASSWORD || '';
const FROM = (process.env.SMTP_FROM || USER).trim();
const DRY_RUN = process.env.MAIL_DRY_RUN === '1';
const BRAND = 'ZT Lab';

// Короткие таймауты намеренно: если почта недоступна, регистрация не
// должна висеть на соединении, а человек — ждать.
const TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 };

function configured() {
  return Boolean(FROM) && (DRY_RUN || Boolean(HOST && USER && PASS));
}

let transport = null;
function getTransport() {
  if (!transport) {
    transport = DRY_RUN
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({ host: HOST, port: PORT, secure: SECURE, auth: { user: USER, pass: PASS }, ...TIMEOUTS });
  }
  return transport;
}

/**
 * Отправляет письмо. Никогда не бросает: ошибка почты не должна
 * превращать успешную регистрацию в 500 — человек уже заведён, а
 * письмо только подсказывает, как в себя войти.
 */
async function send({ to, subject, text }) {
  if (!configured()) {
    console.warn(`Письмо «${subject}» не отправлено: SMTP не настроен (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).`);
    return { sent: false, reason: 'not-configured' };
  }
  try {
    const info = await getTransport().sendMail({ from: FROM, to, subject, text });
    if (DRY_RUN) console.log(`[MAIL_DRY_RUN] ${subject} → ${to}\n${text}`);
    console.log(`Письмо отправлено: ${subject} → ${to}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`Письмо «${subject}» не отправлено:`, err && err.message ? err.message : err);
    return { sent: false, reason: 'smtp-error' };
  }
}

// Адрес для ссылок в письмах. Без PUBLIC_ORIGIN берёмся адрес текущего
// запроса: за nginx там именно публичный, а вот при прямом заходе на
// порт 3000 в ссылку попал бы адрес без домена — поэтому в бою
// переменная обязательна.
function originFor(req) {
  const configuredOrigin = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  if (configuredOrigin) return configuredOrigin;
  return `${req.protocol}://${req.get('host')}`;
}

function welcomeMail({ to, labSlug, username, link }) {
  return {
    to,
    subject: `${BRAND}: вход для вашей лаборатории`,
    text: [
      `Здравствуйте, ${username}!`,
      '',
      `Лаборатория «${labSlug}» зарегистрирована. Данные для входа:`,
      '',
      `  Адрес лаборатории: ${labSlug}`,
      `  Имя: ${username}`,
      '  Пароль: тот, что вы задали при регистрации',
      '',
      'Сменить пароль или войти заново, если забудете:',
      link,
      '',
      `Ссылка работает один раз в течение ${RESET.TTL_HOURS} часов.`,
      '',
      `Если пароль потерян, на этой же странице есть форма восстановления.`,
      `--`,
      BRAND,
    ].join('\n'),
  };
}

function resetMail({ to, labSlug, username, link }) {
  return {
    to,
    subject: `${BRAND}: ссылка для входа`,
    text: [
      `Здравствуйте, ${username}!`,
      '',
      `По запросу восстановления пароля для лаборатории «${labSlug}»:`,
      '',
      link,
      '',
      `Ссылка работает один раз в течение ${RESET.TTL_HOURS} часов.`,
      'Если её не запрашивали — просто проигнорируйте письмо.',
      '',
      `Пароль письмо не содержит: по ссылке вы зададите новый.`,
      `--`,
      BRAND,
    ].join('\n'),
  };
}

module.exports = { configured, send, originFor, welcomeMail, resetMail };
