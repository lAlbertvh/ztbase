// Мастер первичной настройки: /setup
//
// Показывается администратору лаборатории, который её зарегистрировал,
// пока настройка не пройдена. Задача мастера — за один проход ввести
// то, без чего работать нельзя: кто владелец, какие клиники-партнёры,
// какие услуги и цены, кто в команде.
//
// Отдельный модуль по той же причине, что и наряды: server.js и так
// перевалил за полторы тысячи строк, а мастер — самостоятельный
// сценарий со своим состоянием и своей вёрсткой.

const express = require('express');
const S = require('../db/setup-schema');
const L = require('../services/license');
  const C = require('../services/constructions');
  const SPEC = require('../services/specializations');
  
  const ROLE_LABELS = SPEC.ROLE_LABELS;

module.exports = function createSetupRoutes({ db, requireAdmin, hashPassword }) {
  const router = express.Router();

  // Мастер доступен только администратору: заводит сотрудников и цены
  // тот, кто купил приложение.
  router.use(requireAdmin);

  const own = req => Number(req.session.labId || 1);

    // ---- Шаг 1. Представьтесь ----
    // После прохождения или пропуска мастер закрывается, поэтому /
    // setup больше не показывается сам. Прямой заход на /setup всё же
    // оставляем: администратору нужно вернуться и дописать клиник или
    // сотрудников позже.
    router.get('/', (req, res) => {
      if (!S.setupPending(db, own(req))) return res.redirect('/orders');
      const lab = db.prepare('SELECT * FROM labs WHERE id = ?').get(own(req));
      res.render('setup/welcome', { lab, ownerName: lab.owner_name || '' });
    });

    // Пропуск настройки. Раньше кнопка вела прямо в /orders, а middleware
    // видел незавершённую настройку и возвращал в мастер — администратор
    // застревал в круге. Здесь помечаем настройку завершённой и уходим
    // в работу.
    router.post('/skip', (req, res) => {
      S.finish(db, own(req));
      res.redirect('/orders');
    });

  // ---- Шаг 2. Кто вы ----
  router.get('/about', (req, res) => {
    const lab = db.prepare('SELECT * FROM labs WHERE id = ?').get(own(req));
    res.render('setup/about', {
      lab,
      ownerName: lab.owner_name || '',
      ownerRole: S.getSetting(db, own(req), 'owner_role', 'lab_admin'),
      error: req.query.error || null,
    });
  });

  router.post('/about', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const labName = String(req.body.lab_name || '').trim().slice(0, 120);
    const contact = String(req.body.contact || '').trim().slice(0, 120);
    const role = req.body.role === 'dentist_owner' ? 'dentist_owner' : 'lab_admin';

    // Имя обязательно: по нему человек входит в систему. Название
    // лаборатории обязательно тоже — без него наряды выходят без
    // адресата, а пустая шапка в печатном бланке хуже, чем лишний вопрос.
    if (!name) {
      return res.redirect('/setup/about?error=' + encodeURIComponent('Укажите, как вас зовут'));
    }
    if (!labName) {
      return res.redirect('/setup/about?error=' + encodeURIComponent('Укажите название лаборатории'));
    }

    db.prepare('UPDATE labs SET name = ?, owner_name = ?, contact = ? WHERE id = ?')
      .run(labName, name, contact || null, own(req));

    // Имя владельца должно работать и как логин: администратор заводил
    // себя при регистрации под другим именем, а менять пароль и заодно
    // логин посреди мастера неудобно.
    const me = db.prepare('SELECT id, name FROM users WHERE name = ? AND lab_id = ?')
      .get(req.session.user, own(req));
    if (me) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, me.id);
      req.session.user = name;
    }

    S.setSetting(db, own(req), 'about_filled', '1');
    S.setSetting(db, own(req), 'owner_role', role);
    S.setStep(db, own(req), 2);
    res.redirect('/setup/clinics');
  });

  // ---- Шаг 3. Клиники и представители ----
    // Вернуть отключённую клинику в работу. Наряды и врачи на месте —
    // достаточно снять флаг, поэтому отдельного восстановления данных не
    // требуется.
    router.post('/clinics/:id/restore', (req, res) => {
      db.prepare('UPDATE clinics SET active = 1 WHERE id = ? AND lab_id = ?')
        .run(Number(req.params.id), own(req));
      res.redirect('/setup/clinics');
    });

    router.get('/clinics', (req, res) => {
      res.render('setup/clinics', {
        clinics: listClinics(db, own(req)),
        // Отключённые клиники показываем отдельной строкой: их наряды и
        // врачи остались в базе, и молча исчезнувшая клиника выглядела бы
        // как ошибка.
        hidden: db.prepare(`
          SELECT id, name FROM clinics WHERE lab_id = ? AND active = 0 ORDER BY name
        `).all(own(req)),
        roles: ROLE_LABELS,
        // Специализации представителя — по профилю врача.
        specializations: SPEC.BY_ROLE,
        // Врачи без клиники: их наряд виден только им, и пока клиника не
        // выбрана, лаборатория не знает, кому этот заказ. Сюда же попадают
        // врачи отключённой клиники: перепривязать их нужно так же.
        unattached: db.prepare(`
          SELECT u.id, u.name FROM users u
          LEFT JOIN clinics c ON c.id = u.clinic_id
          WHERE u.lab_id = ? AND u.role = 'dentist' AND u.active = 1
            AND (u.clinic_id IS NULL OR c.active = 0)
          ORDER BY u.name
        `).all(own(req)),
        error: req.query.error || null,
      });
    });

  router.post('/clinics', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) return res.redirect('/setup/clinics?error=' + encodeURIComponent('Укажите название клиники'));
    try {
      db.prepare('INSERT INTO clinics (lab_id, name, contact) VALUES (?,?,?)')
        .run(own(req), name, String(req.body.contact || '').trim().slice(0, 120) || null);
    } catch (e) {
      // UNIQUE(lab_id, name) — повторное добавление той же клиники.
      return res.redirect('/setup/clinics?error=' + encodeURIComponent('Такая клиника уже есть'));
    }
    res.redirect('/setup/clinics');
  });

  router.post('/clinics/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const clinic = db.prepare('SELECT id FROM clinics WHERE id = ? AND lab_id = ?').get(id, own(req));
    if (!clinic) return res.redirect('/setup/clinics');

    // Клиника, у которой уже есть наряды или врачи, не удаляется: её наряды
    // остались бы без владельца, а врачи — с привязкой в никуда. Такую
    // клинику отключают, и она уходит из списков, но история нарядов
    // сохраняется. Каскад представителей при этом не срабатывает — они
    // остаются видимыми вместе с отключённой клиникой.
    const inUse = db.prepare(`
      SELECT (SELECT COUNT(*) FROM orders WHERE lab_id = ? AND clinic_id = ?) AS orders_n,
             (SELECT COUNT(*) FROM users     WHERE lab_id = ? AND clinic_id = ?) AS users_n
    `).get(own(req), id, own(req), id);

    if (inUse.orders_n > 0 || inUse.users_n > 0) {
      db.prepare('UPDATE clinics SET active = 0 WHERE id = ? AND lab_id = ?').run(id, own(req));
      return res.redirect('/setup/clinics?error=' + encodeURIComponent(
        'Клиника отключена, а не удалена: у неё есть наряды или врачи'));
    }

    // Пустую клинику можно удалить целиком: каскад уберёт представителей,
    // и в справочнике не останется строк-сирот.
    db.prepare('DELETE FROM clinics WHERE id = ? AND lab_id = ?').run(id, own(req));
    res.redirect('/setup/clinics');
  });

  // Представитель клиники может сразу получить учётную запись.
  //
  // Без неё клиника остаётся строчкой в справочнике: наряды от неё видно,
  // но зайти в систему и заказать работу нельзя. С записью представитель
  // входит как врач своей клиники и видит её наряды.
  router.post('/contacts', (req, res) => {
    const clinicId = Number(req.body.clinic_id);
    const name = String(req.body.name || '').trim().slice(0, 60);
    const role = ROLE_LABELS[req.body.role] ? req.body.role : 'other';
    const clinic = db.prepare('SELECT id FROM clinics WHERE id = ? AND lab_id = ?').get(clinicId, own(req));
    if (!clinic || !name) {
      return res.redirect('/setup/clinics?error=' + encodeURIComponent('Нужны клиника и имя представителя'));
    }

    // Специализация врача по его профилю из формы; чужое значение
    // отбрасывается — см. services/specializations.
    const specialization = SPEC.fromForm('dentist', req.body.specialization);

    const password = String(req.body.password || '');
    const makeAccount = password.length >= 6;

    let userId = null;
    if (makeAccount) {
      const exists = db.prepare('SELECT id FROM users WHERE name = ? AND lab_id = ?')
        .get(name, own(req));
      if (exists) {
        return res.redirect('/setup/clinics?error=' +
          encodeURIComponent(`Имя «${name}» уже занято — введите другое или уберите пароль`));
      }
      // Роль врача: представитель клиники и есть врач. Специализация
      // профиль работы, а не уровень доступа.
      const info = db.prepare(`
        INSERT INTO users (name, lab_id, password_hash, role, specialization, clinic_id, active)
        VALUES (?,?,?,'dentist',?,?,1)
      `).run(name, own(req), hashPassword(password), specialization, clinicId);
      userId = info.lastInsertRowid;
    }

    // Связываем контакт с учётной записью, иначе тариф посчитал бы
    // человека дважды: один раз сотрудником, второй — представителем.
    db.prepare(`
      INSERT INTO clinic_contacts (lab_id, clinic_id, name, role, contact, user_id)
      VALUES (?,?,?,?,?,?)
    `).run(own(req), clinicId, name, role,
      String(req.body.contact || '').trim().slice(0, 120) || null, userId);

    res.redirect('/setup/clinics');
  });

  router.post('/contacts/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const contact = db.prepare('SELECT * FROM clinic_contacts WHERE id = ? AND lab_id = ?')
      .get(id, own(req));
    if (!contact) return res.redirect('/setup/clinics');
    // Учётную запись врача не удаляем вместе с контактом: на её нарядах
    // может остаться работа, и она станет видна только лаборатории.
    db.prepare('DELETE FROM clinic_contacts WHERE id = ? AND lab_id = ?').run(id, own(req));
    res.redirect('/setup/clinics');
  });

  // Привязать уже существующую учётную запись к клинике.
  //
  // Нужно, когда врача завели через «Добавить сотрудника», а клиника
  // появилась позже: без привязки он видит только свои наряды и никто
  // не может понять, что он работает в этой клинике.
  router.post('/clinic/:id/link', (req, res) => {
    const clinicId = Number(req.params.id);
    const userId = Number(req.body.user_id);
    const clinic = db.prepare('SELECT id FROM clinics WHERE id = ? AND lab_id = ?').get(clinicId, own(req));
    const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND lab_id = ?').get(userId, own(req));
    if (!clinic || !user) {
      return res.redirect('/setup/clinics?error=' + encodeURIComponent('Клиника или сотрудник не найден'));
    }
    // Привязать можно только врача: техник клинике не принадлежит, и его
    // наряды от этого не должны стать видны постороннему врачу.
    if (user.role !== 'dentist') {
      return res.redirect('/setup/clinics?error=' +
        encodeURIComponent('Привязать клинике можно только врача'));
    }
    db.prepare('UPDATE users SET clinic_id = ? WHERE id = ? AND lab_id = ?')
      .run(clinicId, userId, own(req));
    res.redirect('/setup/clinics');
  });

  // ---- Шаг 4. Какие услуги ----
  router.get('/services', (req, res) => {
    res.render('setup/services', {
      materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? AND active = 1 ORDER BY name').all(own(req)),
      colors: (S.getSetting(db, own(req), 'colors', '') || '').split(',').map(s => s.trim()).filter(Boolean),
      usage: L.usage(db, own(req)),
      error: req.query.error || null,
    });
  });

  // Конструкция из мастера попадает в общий справочник под группу
  // «Свои услуги»: она сразу доступна в наряде, а перенести её в
  // профильную группу администратор сможет позже из админки.
  router.post('/services/construction', (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) {
      return res.redirect('/setup/services?error=' + encodeURIComponent('Укажите название работы'));
    }
      const price = parsePrice(req.body.price);
      const priceTech = parsePrice(req.body.price_tech);
      try {
          C.seed(db, own(req));
          ownGroup(db);
          const code = nextCode(db, own(req));
          db.prepare(`
            INSERT INTO constructions (lab_id, group_id, section, code, title, price, price_tech, sort)
            VALUES (?, (SELECT id FROM construction_groups WHERE code = 'own'), NULL, ?, ?, ?, ?, 0)
          `).run(own(req), code, title, price, priceTech);
    } catch (e) {
      return res.redirect('/setup/services?error=' + encodeURIComponent('Не удалось добавить: ' + e.message));
    }
    res.redirect('/setup/services');
  });

  router.post('/services/material', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) {
      return res.redirect('/setup/services?error=' + encodeURIComponent('Укажите материал'));
    }
    db.prepare('INSERT INTO materials (lab_id, name, category, unit, note) VALUES (?,?,?,?,?)')
      .run(own(req), name, String(req.body.category || '').trim().slice(0, 60) || null,
        String(req.body.unit || 'шт').trim().slice(0, 20), null);
    res.redirect('/setup/services');
  });

  router.post('/services/materials/:id/delete', (req, res) => {
    db.prepare('UPDATE materials SET active = 0 WHERE id = ? AND lab_id = ?')
      .run(Number(req.params.id), own(req));
    res.redirect('/setup/services');
  });

  // Цвета хранятся одной строкой: их список короткий и постоянный,
  // отдельная таблица ради него усложнила бы бэкап без пользы.
  router.post('/services/colors', (req, res) => {
    const raw = String(req.body.colors || '')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    S.setSetting(db, own(req), 'colors', raw.join(','));
    S.setStep(db, own(req), 4);
    res.redirect('/setup/staff');
  });

  // ---- Шаг 5. Команда ----
  router.get('/staff', (req, res) => {
    res.render('setup/staff', {
      usage: L.usage(db, own(req)),
      staff: db.prepare('SELECT id, name, role, specialization, active FROM users WHERE lab_id = ? ORDER BY id').all(own(req)),
      // Списки специализаций отдаём шаблону: он сам подставит подходящий
      // набор под выбранную роль, и править список в разметке не нужно.
      specializations: SPEC.BY_ROLE,
      specLabel: SPEC.describe,
      roleLabels: ROLE_LABELS,
      currentUserId: req.session.userId || null,
      error: req.query.error || null,
    });
  });

  router.post('/staff', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const password = String(req.body.password || '');
    const role = ['admin', 'dentist', 'tech'].includes(req.body.role) ? req.body.role : 'tech';
    // Специализация проверяется по своей роли: значение «терапевт» в форме
    // техника — ошибка ввода, а не повод завести техника-терапевта.
    const specialization = SPEC.fromForm(role, req.body.specialization);

    if (!name) return res.redirect('/setup/staff?error=' + encodeURIComponent('Укажите имя'));
    if (password.length < 6) {
      return res.redirect('/setup/staff?error=' + encodeURIComponent('Пароль от 6 символов'));
    }
    const exists = db.prepare('SELECT id FROM users WHERE name = ? AND lab_id = ?').get(name, own(req));
    if (exists) {
      return res.redirect('/setup/staff?error=' + encodeURIComponent('Такое имя уже занято'));
    }

    db.prepare('INSERT INTO users (name, lab_id, password_hash, role, specialization, active) VALUES (?,?,?,?,?,1)')
      .run(name, own(req), hashPassword(password), role, specialization);
    res.redirect('/setup/staff');
  });

  router.post('/staff/:id/disable', (req, res) => {
    const id = Number(req.params.id);
    const me = db.prepare('SELECT id FROM users WHERE id = ? AND lab_id = ?').get(id, own(req));
    // Нельзя отключить самого себя: иначе лаборатория остаётся
    // без администратора и настройку уже не завершить.
    if (me && me.id === Number(req.session.userId)) {
      return res.redirect('/setup/staff?error=' + encodeURIComponent('Нельзя отключить самого себя'));
    }
    db.prepare('UPDATE users SET active = 1 - active WHERE id = ? AND lab_id = ?').run(id, own(req));
    res.redirect('/setup/staff');
  });

  // ---- Финал ----
  router.post('/finish', (req, res) => {
    S.finish(db, own(req));
    res.redirect('/admin');
  });

  return router;
};

function listClinics(db, labId) {
  return db.prepare('SELECT * FROM clinics WHERE lab_id = ? AND active = 1 ORDER BY name').all(labId)
    .map(c => ({
      ...c,
      contacts: db.prepare(
        'SELECT * FROM clinic_contacts WHERE clinic_id = ? AND active = 1 ORDER BY name'
      ).all(c.id),
    }));
}

function ownGroup(db) {
  const found = db.prepare('SELECT id FROM construction_groups WHERE code = ?').get('own');
  if (found) return found.id;
  db.prepare(`INSERT INTO construction_groups (code, title, sort) VALUES ('own','Свои услуги',900)`).run();
  return db.prepare('SELECT id FROM construction_groups WHERE code = ?').get('own').id;
}

// Код позиции из мастера не должен совпасть с прайсом: префикс 9
// зарезервирован под услуги, введённые при настройке.
function nextCode(db, labId) {
  // Код уникален внутри лаборатории, поэтому и следующий считаем по
  // своей лаборатории: иначе нумерация упиралась бы в чужой справочник.
  const row = db.prepare(
    `SELECT code FROM constructions WHERE lab_id = ? AND code LIKE '9%' ORDER BY code DESC LIMIT 1`
  ).get(labId);
  const n = row ? parseInt(String(row.code).replace(/^9/, ''), 10) + 1 : 10;
  return '9' + String(n).padStart(3, '0');
}

// Цена из формы: пусто и мусор — это отсутствие цены, а не ноль.
function parsePrice(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

