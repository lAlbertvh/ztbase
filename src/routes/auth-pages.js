// Страницы входа и регистрации.
//
// /login, /register, /set-user и /logout — публичные: без них нельзя
// начать работу. /set-user же и есть вход по имени, паролю и адресу
// лаборатории, поэтому здесь же счётчики попыток.

const express = require('express');
const constructions = require('../services/constructions');

module.exports = function createAuthPageRoutes({ db, query, mailer, verifyPassword, registerAttempt, clearAttempts }) {
  const router = express.Router();

  // Страница входа
  router.get('/login', async (req, res) => {
    // Адрес лаборатории можно указать один раз и потом просто входить по паролю.
    // Ссылка вида /login?lab=ivanova приходит из письма или закладки.
    const preslug = String(req.query.lab || '').trim();
    const error = String(req.query.error || '');
    res.render('login', { error: error || null, preslug });
  });

  // Страница регистрации лаборатории
  router.get('/register', async (req, res) => {
    res.render('register', { error: null });
  });

  // Вход по имени и паролю. Раньше пароля не было: на странице входа был
  // выбор имени из списка, что неприемлемо, когда в системе чужие лаборатории.
  router.post('/set-user', async (req, res) => {
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

  router.get('/logout', (req, res) => {
    // Адрес лаборатории запоминаем, чтобы на форме входа он уже был заполнен.
    const slug = req.session.labSlug || '';
    req.session.destroy(() => {
      res.redirect(slug ? `/login?lab=${encodeURIComponent(slug)}` : '/login');
    });
  });

  return router;
};
