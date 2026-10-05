// Пробный период: экран закончившегося триала и заявка на продление.
//
// Маршруты должны работать без действующей подписки — иначе человек,
// которому истёк пробный период, не смог бы ни заплатить, ни выйти.
// Поэтому /trial пропущен в общей проверке сессии в src/middleware/auth.js.

const express = require('express');
const TRIAL = require('../services/trial');
const mailer = require('../services/mailer');
const constructions = require('../services/constructions');
const RESET = require('../services/password-reset');

module.exports = function createTrialRoutes({ db, query, hashPassword }) {
  const router = express.Router();

  // ---- Пробный период: закончился ----
  //
  // Экран показывает, что произошло, и куда писать. Функционал при этом
  // закрыт целиком, но данные на месте: после оплаты человек возвращается
  // к своим нарядам, а не начинает заново.
  router.get('/trial', (req, res) => {
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
  router.post('/trial/renew', (req, res) => {
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

    const { send, configured } = require('../services/telegram');
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
    router.post('/register-lab', async (req, res) => {
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

  return router;
};
