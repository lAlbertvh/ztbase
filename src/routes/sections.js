// Разделы, которые не про заказ: переписка, пользователи и коды,
// уведомления.
//
// Всё это лежало по одному экрану в разных местах, и добраться до
// них можно было, только зная адрес. Здесь они собраны по разделам
// хаба: /messages, /users, /notifications, /join, /options.

const express = require('express');
const INBOX = require('../services/inbox');
const INV = require('../services/invites');
const OPT = require('../services/options');
const L = require('../services/license');
const SPEC = require('../services/specializations');
const { createLimiter } = require('../services/rate-limit');

// Попытки входа по коду: по адресу проходят все сотрудники лаборатории
// (часто сидят за одним роутером), по коду — конкретная попытка угадать.
const joinLimits = {
  ip: createLimiter({ limit: 30, windowMs: 15 * 60 * 1000 }),
  code: createLimiter({ limit: INV.MAX_ATTEMPTS, windowMs: 15 * 60 * 1000 }),
};

module.exports = function createSectionRoutes({ db, requireAdmin, hashPassword, labId, dentistScope, isDentist }) {
  const router = express.Router();

  // ---- Сообщения: инбокс по всем нарядам ----
  //
  // Раньше переписка открывалась только из карточки наряда. Найти
  // наряд, где ждут ответа, можно было лишь перебором: непрочитанных
  // не отмечал никто, а список диалогов не существовал.
  router.get('/messages', (req, res) => {
    const lab = labId(req);
    const scope = isDentist(req) ? dentistScope(req) : null;
    const userId = req.session.userId;

    res.render('messages', {
      currentUser: req.session.user,
      isAdmin: req.session.role === 'admin',
      isDentist: isDentist(req),
      threads: INBOX.threads(db, lab, userId, scope),
      unread: INBOX.recentUnread(db, lab, userId, scope),
    });
  });

  // «Прочитать всё» — снимает отметку сразу, потому что человек,
  // открывший инбокс, обычно и правда всё посмотрел.
  router.post('/messages/seen-all', (req, res) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const scope = isDentist(req) ? dentistScope(req) : null;
    INBOX.seenAll(db, labId(req), req.session.userId, now, scope);
    res.redirect('/messages');
  });

  // ---- Пользователи и коды ----
  //
  // Администратору доступны и список сотрудников, и выдача кодов.
  // Код нужен, чтобы не выбирать пароль за человека: сотрудник сам
  // приходит на /join и ставит свой.
  router.get('/users', requireAdmin, (req, res) => {
    const lab = labId(req);
    res.render('users', {
      currentUser: req.session.user,
      usage: L.usage(db, lab),
      warning: L.warningFor(L.usage(db, lab)),
      specializations: SPEC.BY_ROLE,
      roleLabels: SPEC.ROLE_LABELS,
      staff: db.prepare(`
        SELECT id, name, role, specialization, phone, active
        FROM users WHERE lab_id = ? ORDER BY active DESC, role, name
      `).all(lab),
      codes: INV.list(db, lab),
      codeTtlDays: INV.CODE_TTL_DAYS,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  });

  // Выдать код. Ответ с самим кодом показываем один раз, на странице:
  // в базе лежит только хэш, восстановить код позже нельзя.
  router.post('/users/codes', requireAdmin, (req, res) => {
    const result = INV.create(db, labId(req), {
      role: req.body.role === 'admin' ? 'admin' : 'tech',
      specialization: SPEC.fromForm(req.body.role === 'admin' ? 'admin' : 'tech', req.body.specialization),
      note: req.body.note,
      createdBy: req.session.userId,
    });
    if (result.error) {
      return res.redirect(`/users?error=${encodeURIComponent(result.error)}`);
    }
    res.redirect(`/users?notice=${encodeURIComponent('Код: ' + result.code + '. Действует ' + INV.CODE_TTL_DAYS + ' дней.')}`);
  });

  router.post('/users/codes/:id/revoke', requireAdmin, (req, res) => {
    db.prepare(`UPDATE invite_codes SET used_at = datetime('now'), used_name = 'отозван' WHERE id = ? AND lab_id = ? AND used_at IS NULL`)
      .run(Number(req.params.id), labId(req));
    res.redirect('/users');
  });

  // Включение и выключение сотрудника. Отключение безопаснее удаления:
  // наряды и сообщения остаются с его именем, и история не рвётся.
  router.post('/users/:id/toggle', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const lab = labId(req);
    const row = db.prepare('SELECT id, name, role, active FROM users WHERE id = ? AND lab_id = ?').get(id, lab);
    if (!row) return res.status(404).send('Пользователь не найден');
    // Последнего администратора отключать нельзя: иначе в лаборатории
    // не останется никого, кто может зайти в настройки.
    if (row.active && row.role === 'admin') {
      const others = db.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE lab_id = ? AND role = 'admin' AND active = 1 AND id <> ?`
      ).get(lab, id).n;
      if (!others) return res.redirect('/users?error=Это единственный активный администратор — его нельзя отключить');
    }
    db.prepare('UPDATE users SET active = 1 - active WHERE id = ? AND lab_id = ?').run(id, lab);
    res.redirect('/users');
  });

  // Смена роли. Специализация проверяется по роли: иначе через форму
  // можно было бы записать технику «бухгалтером».
  router.post('/users/:id/role', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const lab = labId(req);
    const role = req.body.role === 'admin' ? 'admin' : 'tech';
    const spec = SPEC.fromForm(role, req.body.specialization);
    if (role === 'tech') {
      const others = db.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE lab_id = ? AND role = 'admin' AND active = 1 AND id <> ?`
      ).get(lab, id).n;
      if (!others) return res.redirect('/users?error=В лаборатории должен остаться хотя бы один администратор');
    }
    db.prepare('UPDATE users SET role = ?, specialization = ? WHERE id = ? AND lab_id = ?')
      .run(role, spec, id, lab);
    res.redirect('/users');
  });

  // ---- Вход по коду ----
  //
  // Страница публичная: человек приходит по ссылке из мессенджера, ещё
  // без сессии. Код проверяется внутри лаборатории, к которой он
  // принадлежит, а lab в форме выбирать нельзя — иначе можно было бы
  // вписать чужой.
  router.get('/join', (req, res) => {
    res.render('join', {
      error: req.query.error || null,
      // Код приходит в ссылке: /join?code=ABCD2345. Так его можно
      // переслать одним нажатием.
      code: String(req.query.code || '').toUpperCase().slice(0, 24),
    });
  });

  router.post('/join', (req, res) => {
    const name = (req.body.username || '').trim().slice(0, 60);
    const password = req.body.password || '';
    const code = req.body.code || '';

    const fail = (msg) => res.status(400).render('join', { error: msg, code: String(code).toUpperCase().slice(0, 24) });

    // Подбор кода ограничиваем. Код одноразовый и короткий, поэтому без
    // счётчика страницу можно было бы долбить перебором, не зная даже
    // того, что код существует. Считаем по адресу и по самому коду:
    // один человек не должен блокировать сотруднику лаборатории за
    // соседним компьютером, но и перебор по одному коду должен
    // останавливаться.
    const ipKey = `join:ip:${req.ip || '?'}`;
    const codeKey = `join:code:${String(code).trim().toUpperCase()}`;
    if (joinLimits.ip.exceeded(ipKey) || joinLimits.code.exceeded(codeKey)) {
      return res.status(429).render('join', {
        error: 'Слишком много попыток. Попробуйте позже.',
        code: String(code).toUpperCase().slice(0, 24),
      });
    }

    if (!name) return fail('Введите имя');
    if (password.length < 6) return fail('Пароль короче 6 символов');

    const found = INV.resolveAny(db, code);
    if (!found.ok) {
      joinLimits.ip.count(ipKey);
      joinLimits.code.count(codeKey);
      return fail(found.error);
    }

    joinLimits.ip.clear(ipKey);
    joinLimits.code.clear(codeKey);

    const created = INV.redeem(db, found.code.lab_id, code, {
      name,
      passwordHash: hashPassword(password),
    });
    if (created.error) return fail(created.error);

    req.session.user = name;
    req.session.userId = created.userId;
    req.session.labId = found.code.lab_id;
    req.session.role = created.role;
    const lab = db.prepare('SELECT slug FROM labs WHERE id = ?').get(found.code.lab_id);
    req.session.labSlug = lab ? lab.slug : '';
    res.redirect('/');
  });

  // ---- Уведомления ----
  //
  // Подключение каналов: Telegram, ВКонтакте, SMS. Сейчас это
  // сохранённые настройки — отправка в Telegram уже работает, остальные
  // каналы включаются здесь и используются, когда появится провайдер.
  router.get('/notifications', (req, res) => {
    const lab = labId(req);
    const s = (k) => db.prepare('SELECT value FROM lab_settings WHERE lab_id = ? AND key = ?')
      .get(lab, k)?.value || '';
    res.render('notifications', {
      currentUser: req.session.user,
      isAdmin: req.session.role === 'admin',
      isDentist: isDentist(req),
      settings: {
        tg_chat_id: s('notify_tg_chat_id'),
        vk_chat_id: s('notify_vk_chat_id'),
        sms_number: s('notify_sms_number'),
        notify_new_order: s('notify_new_order') || '1',
        notify_new_message: s('notify_new_message') || '1',
      },
      notice: req.query.notice || null,
      error: req.query.error || null,
    });
  });

  router.post('/notifications', requireAdmin, (req, res) => {
    const lab = labId(req);
    const put = (k, v) => db.prepare(`
      INSERT INTO lab_settings (lab_id, key, value) VALUES (?,?,?)
      ON CONFLICT(lab_id, key) DO UPDATE SET value = excluded.value
    `).run(lab, k, v == null ? '' : String(v).trim().slice(0, 200));

    put('notify_tg_chat_id', req.body.tg_chat_id);
    put('notify_vk_chat_id', req.body.vk_chat_id);
    put('notify_sms_number', req.body.sms_number);
    put('notify_new_order', req.body.notify_new_order ? '1' : '0');
    put('notify_new_message', req.body.notify_new_message ? '1' : '0');
    res.redirect('/notifications?notice=' + encodeURIComponent('Настройки сохранены'));
  });

  // ---- Этапы и отметки: редактор ----
  router.get('/options', requireAdmin, (req, res) => {
    res.render('options', {
      currentUser: req.session.user,
      kinds: Object.entries(OPT.KINDS).map(([key, spec]) => ({
        key, title: spec.title,
        items: OPT.list(db, labId(req), key),
      })),
      notice: req.query.notice || null,
      error: req.query.error || null,
    });
  });

  const optErr = (msg) => `/options?error=${encodeURIComponent(msg)}`;
  const optOk = (msg) => `/options?notice=${encodeURIComponent(msg)}`;

  router.post('/options', requireAdmin, (req, res) => {
    const kind = req.body.kind;
    if (!OPT.KINDS[kind]) return res.redirect(optErr('Неизвестный список'));
    const lab = labId(req);

    const action = req.body.action;
    if (action === 'add') {
      const result = OPT.upsert(db, lab, kind, {
        key: req.body.key, title: req.body.title, sort: req.body.sort,
      });
      return res.redirect(result.error ? optErr(result.error) : optOk('Пункт добавлен'));
    }
    if (action === 'hide' || action === 'show') {
      const result = OPT.setActive(db, lab, kind, req.body.key, action === 'show');
      return res.redirect(result.error ? optErr(result.error) : optOk('Сохранено'));
    }
    if (action === 'rename') {
      const result = OPT.update(db, lab, kind, req.body.key, {
        title: req.body.title, sort: req.body.sort,
      });
      return res.redirect(result.error ? optErr(result.error) : optOk('Сохранено'));
    }
    res.redirect(optErr('Неизвестное действие'));
  });

  return router;
};
