// Восстановление пароля по одноразовой ссылке.
//
// Два ответа — на запрос ссылки и на её использование — намеренно
// выглядят одинаково независимо от того, существует ли учётная запись.
// Иначе форма превращается в способ перебрать имена сотрудников.
//
// Письмо уходит на адрес, который уже записан у лаборатории, и на
// адрес из формы мы не смотрим: иначе любой мог бы слать письма на
// чужие ящики и проверять, кому они дошли.

const express = require('express');
const RESET = require('../services/password-reset');
const mailer = require('../services/mailer');
const { createLimiter } = require('../services/rate-limit');

// Письмо на запрос ссылки. Столько же, сколько входных попыток на
// пару «адрес + сотрудник»: иначе форма рассылала бы письма без
// ограничения, то есть была бы почтовым комбайном.
const MAX_RESET_ATTEMPTS = 5;
// Отдельно считаем по лаборатории: имя сотрудника в запросе можно
// менять, а письмо всё равно уходит на одну почту лаборатории.
const MAX_RESET_PER_LAB = 10;
const RESET_WINDOW_MS = 15 * 60 * 1000;

module.exports = function createPasswordRoutes({ db, hashPassword }) {
  const router = express.Router();

  // Счётчики живут в памяти процесса и обнуляются при перезапуске.
  // Для ограничения рассылки этого достаточно: перезапуск сервера
  // не должен открывать новую возможность слать письма, но и не
  // обязан переживать перезапуск.
  const resetByUser = createLimiter({ limit: MAX_RESET_ATTEMPTS, windowMs: RESET_WINDOW_MS });
  const resetByLab = createLimiter({ limit: MAX_RESET_PER_LAB, windowMs: RESET_WINDOW_MS });

  const labMail = lab => (lab.trial_email || lab.contact || '').trim();

  router.get('/password/reset', (req, res) => {
    res.render('password-reset', {
      error: null,
      sent: false,
      lab: String(req.query.lab || '').trim().toLowerCase(),
      username: String(req.query.username || '').trim(),
    });
  });

  router.post('/password/reset', async (req, res) => {
    const labSlug = (req.body.lab_slug || '').trim().toLowerCase();
    const username = (req.body.username || '').trim();

    if (!labSlug || !username) {
      return res.status(400).render('password-reset', {
        error: 'Укажите адрес лаборатории и имя', sent: false, lab: labSlug, username,
      });
    }

    // Счётчики намеренно не сбрасываются после успеха. Сброс выглядел
    // бы вежливо, но ровно он и позволял завалить ящик письмами: зная
    // адрес лаборатории и имя сотрудника, можно было просить ссылку
    // снова и снова, и каждый раз письмо уходило. Здесь счётчик — это
    // ограничение рассылки, а не защита от подбора пароля, поэтому
    // жить он должен всё окно.
    const userKey = `reset:${req.ip}:${labSlug}:${username}`;
    const labKey = `reset:${req.ip}:${labSlug}`;
    if (resetByUser.count(userKey) > MAX_RESET_ATTEMPTS
        || resetByLab.count(labKey) > MAX_RESET_PER_LAB) {
      return res.status(429).render('password-reset', {
        error: 'Слишком много попыток. Подождите 15 минут.', sent: false, lab: labSlug, username,
      });
    }

    const lab = db.prepare('SELECT * FROM labs WHERE slug = ?').get(labSlug);
    const user = lab
      ? db.prepare('SELECT * FROM users WHERE name = ? AND lab_id = ?').get(username, lab.id)
      : null;

    if (lab && user && user.active) {
      const to = labMail(lab);
      if (to) {
        const { token } = RESET.createReset(db, user.id);
        await mailer.send(mailer.resetMail({
          to,
          labSlug,
          username,
          link: `${mailer.originFor(req)}/password/set?token=${encodeURIComponent(token)}`,
        }));
      } else {
        // Лаборатория зарегистрировалась без почты. Молчание здесь
        // выглядит как успех — так же, как у настоящего ответа, — но
        // в журнал пишем, чтобы это было видно при разборе.
        console.warn(`У лаборатории «${labSlug}» нет почты: ссылка для восстановления не отправлена.`);
      }
    }

    res.render('password-reset', {
      error: null,
      sent: true,
      lab: labSlug,
      username,
    });
  });

  router.get('/password/set', (req, res) => {
    const token = String(req.query.token || '');
    if (!RESET.findValid(db, token)) {
      return res.status(400).render('password-set', {
        error: 'Ссылка недействительна или уже использована. Запросите новую.',
        token: null,
        done: false,
      });
    }
    res.render('password-set', { error: null, token, done: false });
  });

  router.post('/password/set', (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    const repeat = String(req.body.password2 || '');
    const row = RESET.findValid(db, token);
    // Ссылка не годна: пароль не сохраняем, а в форме оставляем только
    // прошлое состояние, чтобы не подсказывать, что именно сломалось.
    const fail = error => res.status(400).render('password-set', {
      error, token: null, done: false,
    });

    if (!row) return fail('Ссылка недействительна или уже использована. Запросите новую.');
    if (password.length < 6) return res.status(400).render('password-set', {
      error: 'Пароль короче 6 символов', token, done: false,
    });
    if (password !== repeat) return res.status(400).render('password-set', {
      error: 'Пароли не совпадают', token, done: false,
    });

    // Помечаем ссылку использованной до смены пароля: если что-то
    // упадёт, она уже не сработает второй раз, и это безопаснее, чем
    // ссылка, которой можно воспользоваться повторно.
    if (!RESET.consume(db, row)) return fail('Ссылка уже использована.');

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(password), row.user_id);

    res.render('password-set', { error: null, token: null, done: true });
  });

  return router;
};
