// Маршруты заказ-нарядов.
//
// Отдельный модуль с фабрикой, а не блок в server.js: там уже больше
// тысячи строк, и наряды — самостоятельная функциональность со своей
// схемой, справочниками и правилами доступа.
//
// Доступ: администратор лаборатории и техник видят всё по своей
// лаборатории. Стоматолог видит наряды своей клиники и те, что завёл
// сам, но не может менять этапы производства — это внутренний процесс
// лаборатории.

const express = require('express');
const QRCode = require('qrcode');
const R = require('../services/dental-reference');
const O = require('../services/orders');
const M = require('../services/manipulations');
const C = require('../services/constructions');

// Внешний адрес приложения для QR-кодов. Без него ссылка в коде была бы
// внутренней (127.0.0.1), и камера телефона открыла бы её мимо сервера.
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');

const str = (v) => String(v || '').trim();

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {Function} deps.requireAdmin middleware администратора
 */
module.exports = function createOrderRoutes({ db, requireAdmin }) {
  const router = express.Router();

  const labId = (req) => req.session.labId || 1;

  // Имя сотрудника нужно почти во всех шаблонах нарядов. В проекте
  // оно передаётся как currentUser, поэтому кладём его в res.locals
  // один раз здесь, а не в каждый res.render.
  router.use((req, res, next) => {
    res.locals.currentUser = req.session.user;
    next();
  });

  // Стоматолог — внешний клиент. Он заполняет наряд и следит за
  // готовностью, но не вмешивается в производство.
    const isDentist = (req) => req.session.role === 'dentist';
    const isAdmin = (req) => req.session.role === 'admin';

    // Клиника, которой принадлежит вошедший.
    //
    // Читаем из базы, а не из сессии: привязку сотрудника к клинике меняют,
    // и сохранённое в сессии значение разошлось бы с базой до перелогина —
    // врач продолжал бы видеть чужие наряды или потерял бы свои. Сессия
    // живёт днями, а привязку меняют в том же экране.
    function ownClinic(req) {
      if (!req.session.userId) return null;
      return db.prepare('SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?')
        .get(req.session.userId, labId(req)) || null;
    }

    // Кого врач имеет право видеть: свою клинику и свои наряды.
    // Врач без клиники видит только то, что завёл сам — иначе под именем
    // «клиника» он получил бы весь поток лаборатории.
    const dentistScope = (req) => {
      const link = ownClinic(req);
      return { name: req.session.user, clinicId: link ? link.clinic_id : null };
    };

    // Клиники лаборатории для выбора в наряде. Врачу список не нужен:
    // его клиника определяется учётной записью.
    const clinicOptions = (req) => db.prepare(
      'SELECT id, name FROM clinics WHERE lab_id = ? AND active = 1 ORDER BY name'
    ).all(labId(req));

    // Название своей клиники для показа врачу: выбор всё равно не за ним,
    // но подтвердить, чей это наряд, полезно прямо в форме.
    function myClinicName(req) {
      const link = ownClinic(req);
      if (!link || !link.clinic_id) return null;
      const c = db.prepare('SELECT name FROM clinics WHERE id = ? AND lab_id = ?')
        .get(link.clinic_id, labId(req));
      return c ? c.name : null;
    }

    // Клиника, выбранная администратором в форме наряда.
    // Проверяем, что она своя и активная: без проверки в форму можно было
    // бы вписать чужую клинику и получить наряд, невидимый ни для одного
    // врача, — то есть тихо потерянный заказ.
    const bodyClinic = (req) => {
      const id = Number(req.body.clinic_id);
      if (!Number.isInteger(id) || id <= 0) return null;
      const own = db.prepare('SELECT id FROM clinics WHERE id = ? AND lab_id = ? AND active = 1')
        .get(id, labId(req));
      return own ? id : null;
    };

    // Может ли врач открыть этот наряд.
    const maySee = (req, order) => {
      if (!isDentist(req)) return true;
      if (order.created_by === req.session.user) return true;
      const link = ownClinic(req);
      // Клиники сравниваем по id, а не по названию: название можно
      // переименовать, и тогда наряды клиники разъехались бы по спискам.
      return !!(link && link.clinic_id && order.clinic_id === link.clinic_id);
    };

    // Цены вправе назначать администратор: он владелец версии и знает
    // себестоимость. Врач и техник описывают свою конструкцию, но цену
    // не назначают — иначе клиника получила бы счёт по цене, которую
    // техник вписал себе в форме.
    const canSetPrices = (req) => isAdmin(req);

    // Скидку даёт тот, кто выставляет счёт клинике: администратор или
    // врач. Технику в скидке нет — это не его деньги.
    const canDiscount = (req) => isAdmin(req) || isDentist(req);

  // ---- Список нарядов ----
  router.get('/', (req, res) => {
    // Стоматолог видит наряды своей клиники, остальные — все по лаборатории.
    const { rows, total, limit, offset } = O.listOrders(db, labId(req), {
      stage: req.query.stage,
      search: (req.query.search || '').trim(),
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      clinicOf: isDentist(req) ? dentistScope(req) : null,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    res.render('orders/index', {
      orders: rows,
      total,
      limit,
      offset,
        // Счётчики этапов сужаем тем же правилом, что и список: иначе
        // врач видит в шапке объём чужой клиники.
        summary: O.stageSummary(db, labId(req),
          isDentist(req) ? { clinicOf: dentistScope(req) } : {}),
      stages: R.STAGES,
      stageTitle: R.STAGE_TITLE,
      stageShort: R.STAGE_SHORT,
      workTitle: R.WORK_TITLE,
      filters: req.query,
      isDentist: isDentist(req),
    });
  });

  // ---- Форма нового наряда ----
router.get('/new', (req, res) => {
      // Справочник конструкций доступен и врачу, и технику: выбор
      // изготовляемого — часть заказа, а не решение лаборатории.
      C.seed(db, labId(req));
      res.render('orders/form', {
        order: null,
        teethText: '',
        materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? AND active = 1 ORDER BY name').all(labId(req)),
        constructions: C.forOrderSelect(db, labId(req)),
        catalog: R,
        incoming: req.query.incoming || '',
          isDentist: isDentist(req),
          canSetPrices: canSetPrices(req),
          canDiscount: canDiscount(req),
          clinics: isAdmin(req) ? clinicOptions(req) : [],
          // Свою клинику врачу показываем текстом, а не выбором: выбрать
          // всё равно нельзя, а лишний список только путает.
          myClinic: isDentist(req) ? myClinicName(req) : null,
        });
      });
  
    // ---- Карточка наряда ----
  router.get('/catalog/manipulations', requireAdmin, (req, res) => {
    M.seedDefaults(db, labId(req));
    res.render('orders/manipulations-catalog', {
      items: M.listCatalog(db, labId(req)),
      workKinds: R.WORK_KINDS,
      workTitle: R.WORK_TITLE,
      error: req.query.error || null,
    });
  });

  router.post('/catalog/manipulations', requireAdmin, (req, res) => {
    const result = M.createCatalogItem(db, labId(req), req.body);
    res.redirect(result.error
      ? `/orders/catalog/manipulations?error=${encodeURIComponent(result.error)}`
      : '/orders/catalog/manipulations');
  });

  router.post('/catalog/manipulations/:id', requireAdmin, (req, res) => {
    const result = M.updateCatalogItem(db, labId(req), Number(req.params.id), req.body);
    res.redirect(result.error
      ? `/orders/catalog/manipulations?error=${encodeURIComponent(result.error)}`
      : '/orders/catalog/manipulations');
  });

  router.post('/catalog/manipulations/:id/toggle', requireAdmin, (req, res) => {
    M.toggleCatalogActive(db, labId(req), Number(req.params.id));
    res.redirect('/orders/catalog/manipulations');
  });

  // ---- Справочник конструкций ----
  // Таблица-редактор: колонки — группы верхнего уровня, строки —
  // конструкции. Заполняется из справочника по умолчанию, но только
  // при пустой базе, чтобы не затирать правки администратора.
  const constructionsUrl = '/orders/catalog/constructions';
  const constructionsErr = e => `${constructionsUrl}?error=${encodeURIComponent(e)}`;

  router.get('/catalog/constructions', requireAdmin, (req, res) => {
    C.seed(db, labId(req));
    res.render('orders/constructions-catalog', {
      groups: C.listTree(db, labId(req)),
      currentUser: req.user && req.user.name,
      error: req.query.error || null,
    });
  });

  router.post('/catalog/constructions', requireAdmin, (req, res) => {
    const result = C.createConstruction(db, labId(req), req.body);
    res.redirect(result.error ? constructionsErr(result.error) : constructionsUrl);
  });

  router.post('/catalog/constructions/:id', requireAdmin, (req, res) => {
    const result = C.updateConstruction(db, labId(req), Number(req.params.id), req.body);
    res.redirect(result.error ? constructionsErr(result.error) : constructionsUrl);
  });

  router.post('/catalog/constructions/:id/toggle', requireAdmin, (req, res) => {
    C.toggleActive(db, labId(req), Number(req.params.id));
    res.redirect(constructionsUrl);
  });

  router.post('/catalog/constructions/:id/delete', requireAdmin, (req, res) => {
    const result = C.deleteConstruction(db, labId(req), Number(req.params.id));
    res.redirect(result.error ? constructionsErr(result.error) : constructionsUrl);
  });

  // ---- Отчёт по манипуляциям: расчёт зарплаты ----

  // Только администратор: это деньги лаборатории, технику показывать
  // свод по коллегам незачем.
  router.get('/stats/manipulations', requireAdmin, (req, res) => {
    const dateFrom = str(req.query.date_from);
    const dateTo = str(req.query.date_to);
    const report = M.reportByUser(db, labId(req), { dateFrom, dateTo });
    res.render('orders/manipulations-report', {
      report,
      dateFrom,
      dateTo,
      today: new Date().toISOString().slice(0, 10),
      monthStart: new Date().toISOString().slice(0, 8) + '01',
    });
  });

  // ---- Манипуляции: чек-лист наряда ----

  // Страница для телефона: техник открывает её камерой по QR-коду с
  // наряда и отмечает выполненное крупными кнопками. Отдельная
  // страница, а не карточка наряда: на компьютере это мелкий чек-лист,
  // на телефоне — основной рабочий экран.
  router.get('/:id/manipulations', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (!maySee(req, order)) {
      return res.status(403).send('Нет доступа к этому наряду');
    }
    M.seedDefaults(db, labId(req));
    M.addCatalogToOrder(db, labId(req), order.id, M.orderWorkKinds(db, labId(req), order.id));
    res.render('orders/manipulations', {
      order,
      catalog: R,
      isDentist: isDentist(req),
      items: M.listOrderManipulations(db, labId(req), order.id),
      counts: M.orderManipulationCounts(db, labId(req), order.id),
      back: req.query.back === 'order' ? `/orders/${order.id}` : '/orders',
    });
  });

    // Отметка выполнения. Кнопка приходит из мобильной страницы и
    // отвечает редиректом обратно — это работает без JavaScript.
    router.post('/:id/manipulations/:mid', (req, res) => {
      const order = O.getOrder(db, labId(req), Number(req.params.id));
      if (!order) return res.status(404).send('Наряд не найден');
      // Отмечать производство может лаборатория, а не клиент: стоматолог
      // заполняет наряд и следит за готовностью, но не решает, что уже
      // сделано. Иначе он мог бы «выполнить» работу вместо техника и
      // испортить расчёт зарплаты.
      if (isDentist(req)) {
        return res.status(403).send('Отмечать манипуляции может только лаборатория');
      }
      const done = req.body.done === '1' || req.body.done === 'on';
      M.setManipulationDone(db, labId(req), order.id, Number(req.params.mid), done, req.session.user);

    const back = req.body.back === 'order' ? `/orders/${order.id}` : `/orders/${order.id}/manipulations`;
    res.redirect(back);
  });

  // QR-код наряда. Отдаётся SVG, а не PNG: печатается без потери
  // качества и не требует обработки картинок на сервере.
  router.get('/:id/qr.svg', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (!maySee(req, order)) {
      return res.status(403).send('Нет доступа к этому наряду');
    }
    // В QR кодируется абсолютный адрес: камера телефона открывает
    // ссылку с любого устройства, где телефон видит эту сеть.
    const base = PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const url = `${base}/orders/${order.id}/manipulations`;
    QRCode.toString(url, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' })
      .then((svg) => {
        res.type('image/svg+xml');
        res.set('Cache-Control', 'no-store');
        res.send(svg);
      })
      .catch(() => res.status(500).send('Не удалось построить QR-код'));
  });

  // ---- Справочник манипуляций ----

  router.get('/:id', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (!maySee(req, order)) {
      return res.status(403).send('Нет доступа к этому наряду');
    }
    M.seedDefaults(db, labId(req));
    M.addCatalogToOrder(db, labId(req), order.id, M.orderWorkKinds(db, labId(req), order.id));
      // Видимость цен по ролям. Врач видит только цену для клиники,
      // техник — только себестоимость: показывать врачу закупочную
      // стоимость лаборатории незачем, а показывать технику цену для
      // клиники — спойлер в его же расчёте.
      const isTech = req.session.role === 'tech';
      res.render('orders/show', {
        order,
        catalog: R,
        isDentist: isDentist(req),
        isTech,
        // Технику не нужна клиентская часть счёта: ни цена для врача,
        // ни скидка клинике.
        showClientPrices: !isTech,
        showTechPrices: !isDentist,
        manipulations: M.listOrderManipulations(db, labId(req), order.id),
        manipCounts: M.orderManipulationCounts(db, labId(req), order.id),
        // Переписка и справочник для отметки договорённостей: конструкции
        // отмечаются в сообщении, а наряд собирается из отмеченного.
        messages: O.listMessages(db, labId(req), order.id),
        chatCatalog: C.listForChat(db, labId(req)),
        notice: req.query.notice || null,
        error: req.query.error || null,
      });
    });

  // ---- Редактирование ----
      router.get('/:id/edit', (req, res) => {
      const order = O.getOrder(db, labId(req), Number(req.params.id));
      if (!order) return res.status(404).send('Наряд не найден');
      // Свои наряды врач правит, чужие — нет: форма правки содержит
      // состав работ и цены, и отдать её чужой клинике нельзя.
      if (!maySee(req, order)) {
        return res.status(403).send('Нет доступа к этому наряду');
      }
        C.seed(db, labId(req));
      res.render('orders/form', {
        order,
        teethText: order.teeth.map(t => t.tooth).join(' '),
        materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? AND active = 1 ORDER BY name').all(labId(req)),
        constructions: C.forOrderSelect(db, labId(req)),
catalog: R,
        incoming: '',
        isDentist: isDentist(req),
        canSetPrices: canSetPrices(req),
        canDiscount: canDiscount(req),
        clinics: isAdmin(req) ? clinicOptions(req) : [],
        myClinic: isDentist(req) ? myClinicName(req) : null,
      });
    });

  // ---- Сохранение ----
  router.post('/', (req, res) => {
      // Права на цены и скидку передаём в разбор формы, а не проверяем
      // после: сервис обязан сам отбросить то, что ему не положено.
      const parsed = O.parseOrderForm(req.body, {
        canSetPrices: canSetPrices(req),
        canDiscount: canDiscount(req),
        // Врач пишет наряд от имени своей клиники, и подменить её в форме
        // нельзя. Администратор клинику выбирает: он ведёт наряды и за
        // клиники, в том числе принимает работы, пришедшие мимо учётных
        // записей врачей.
        clinicId: isDentist(req) ? dentistScope(req).clinicId : bodyClinic(req),
      });
      if (!parsed.ok) {
        return res.status(400).send(`Ошибка: ${parsed.error}`);
      }
      const data = parsed.data;
      // id приходит формой только при редактировании.
      if (req.body.id) data.id = Number(req.body.id);

      // Врач правит наряды своей клиники. Проверка идёт по наряду из базы,
      // а не по номеру из формы: иначе подставив id чужого наряда, врач
      // переписал бы его состав и цены.
      if (isDentist(req) && data.id) {
        const own = O.getOrder(db, labId(req), data.id);
        if (!own) return res.status(404).send('Наряд не найден');
        if (!maySee(req, own)) {
          return res.status(403).send('Нет доступа к этому наряду');
        }
      }
  
    const result = O.saveOrder(db, labId(req), data, req.session.user);
    if (result.error) return res.status(400).send(`Ошибка: ${result.error}`);

    // Уведомление только о новом наряде: правка старого не должна
    // дёргать сообщениями, иначе чат забивается при работе со списком.
    if (!data.id) {
      const order = O.getOrder(db, labId(req), result.id);
      const lab = db.prepare('SELECT name FROM labs WHERE id = ?').get(labId(req));
      const { newOrderMessage, notify } = require('../services/telegram');
      notify(newOrderMessage(order || { order_number: data.order_number }, lab?.name));
    }

    res.redirect(`/orders/${result.id}`);
  });

  // ---- Журнал: новый этап с заметкой ----
  router.post('/:id/stage', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (isDentist(req)) return res.status(403).send('Этапы производства недоступны');

    const stage = (req.body.stage || '').trim();
    const note = (req.body.note || '').trim().slice(0, 2000);
    if (!R.STAGES.some(s => s.key === stage)) {
      return res.status(400).send('Неизвестный этап');
    }
      O.addStage(db, labId(req), order.id, stage, note, req.session.user);
      res.redirect(`/orders/${order.id}`);
    });

    // ---- Переписка по наряду ----
    //
    // Чат живёт внутри наряда, а не отдельной страницей: врач пишет про
    // пациента и конструкции, техник отвечает, и из этого разговора
    // кнопкой собирается наряд. Все три роли видят переписку, но врач —
    // только в своих нарядах: та же проверка, что и у карточки.
    router.post('/:id/messages', (req, res) => {
      const order = O.getOrder(db, labId(req), Number(req.params.id));
      if (!order) return res.status(404).send('Наряд не найден');
      if (!maySee(req, order)) {
        return res.status(403).send('Нет доступа к этому наряду');
      }

      // Согласованные конструкции приходят списком codes[]: одна и та же
      // форма используется и для обычного сообщения, и для договорённости.
      let codes = req.body.codes;
      if (!Array.isArray(codes)) codes = codes ? [codes] : [];

      const result = O.addMessage(db, labId(req), order.id, {
        id: req.session.userId,
        name: req.session.user,
        role: req.session.role,
      }, req.body.body, codes);

      if (result.error) {
        return res.redirect(`/orders/${order.id}?error=${encodeURIComponent(result.error)}`);
      }
      // Якорь возвращает к последнему сообщению: страница длинная, и без
      // якоря после отправки пользователь оказывался наверху формы.
      res.redirect(`/orders/${order.id}#chat`);
    });

    // «Заполнить наряд» из переписки.
    router.post('/:id/messages/:mid/apply', (req, res) => {
      const order = O.getOrder(db, labId(req), Number(req.params.id));
      if (!order) return res.status(404).send('Наряд не найден');
      if (!maySee(req, order)) {
        return res.status(403).send('Нет доступа к этому наряду');
      }

      const result = O.applyProposal(db, labId(req), order.id, Number(req.params.mid));
      if (result.error) {
        return res.redirect(`/orders/${order.id}?error=${encodeURIComponent(result.error)}`);
      }
      if (!result.added.length) {
        // Всё уже было добавлено раньше. Не ошибка, но и не пустота:
        // сообщаем, чтобы нажатие не выглядело сломанным.
        return res.redirect(`/orders/${order.id}?notice=${encodeURIComponent('Эти позиции уже есть в наряде')}`);
      }
      res.redirect(`/orders/${order.id}?notice=${encodeURIComponent('Добавлено: ' + result.added.join(', '))}`);
    });

  // ---- Добавление материала в наряд ----
  router.post('/:id/material', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');

    const name = (req.body.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).send('Укажите название материала');

    // Техник вправе вписать материал, которого нет в справочнике.
    // Если имя совпало с записью справочника, связываем с ней,
    // иначе material_id остаётся пустым и материал живёт только в наряде.
    const ref = db.prepare('SELECT id, unit FROM materials WHERE lab_id = ? AND name = ? AND active = 1').get(labId(req), name);
    const qty = parseFloat(String(req.body.qty || '1').replace(',', '.'));
    const unit = (req.body.unit || ref?.unit || 'шт').trim().slice(0, 20);

    db.prepare(`
      INSERT INTO order_materials (order_id, lab_id, material_id, name, qty, unit, note)
      VALUES (?,?,?,?,?,?,?)
    `).run(order.id, labId(req), ref ? ref.id : null, name,
      Number.isFinite(qty) && qty > 0 ? qty : 1, unit,
      (req.body.note || '').trim().slice(0, 300));

    res.redirect(`/orders/${order.id}`);
  });

  // ---- Удаление материала из наряда ----
  router.post('/:id/material/:mid/delete', (req, res) => {
    db.prepare('DELETE FROM order_materials WHERE id = ? AND order_id = ? AND lab_id = ?')
      .run(Number(req.params.mid), Number(req.params.id), labId(req));
    res.redirect(`/orders/${req.params.id}`);
  });

  // ---- Удаление наряда: только администратор, с подтверждением ----
  router.post('/:id/delete', requireAdmin, (req, res) => {
    const ok = O.deleteOrder(db, labId(req), Number(req.params.id));
    if (!ok) return res.status(404).send('Наряд не найден');
    res.redirect('/orders');
  });

  // ---- Печатная форма ----
  router.get('/:id/print', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (!maySee(req, order)) {
      return res.status(403).send('Нет доступа');
    }
    res.render('orders/print', { order, catalog: R });
  });

    // ---- Печатная форма нескольких нарядов ----
    //
    // Идентификаторы приходят из строки запроса, поэтому каждый пропускаем
    // через maySee: иначе врач одной клиники подставил бы чужие id и получил
    // бы печатную форму нарядов другой клиники вместе с ценами.
    router.get('/print/batch', (req, res) => {
      const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 200);
      const orders = ids
        .map(id => O.getOrder(db, labId(req), id))
        .filter(Boolean)
        .filter(order => maySee(req, order));
      if (!orders.length) return res.status(404).send('Наряды не найдены');
      res.render('orders/print-batch', { orders, catalog: R });
    });

  // ---- Справочник материалов ----
  router.get('/catalog/materials', (req, res) => {
    if (isDentist(req)) return res.status(403).send('Справочник недоступен');
    res.render('orders/materials', {
      materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? ORDER BY active DESC, name').all(labId(req)),
      isDentist: false,
    });
  });

  router.post('/catalog/materials', requireAdmin, (req, res) => {
    const name = (req.body.name || '').trim().slice(0, 120);
    if (name) {
      db.prepare('INSERT INTO materials (lab_id, name, category, unit, note) VALUES (?,?,?,?,?)')
        .run(labId(req), name, (req.body.category || '').trim().slice(0, 60),
          (req.body.unit || 'шт').trim().slice(0, 20), (req.body.note || '').trim().slice(0, 300));
    }
    res.redirect('/orders/catalog/materials');
  });

router.post('/catalog/materials/:id/toggle', requireAdmin, (req, res) => {
      db.prepare('UPDATE materials SET active = 1 - active WHERE id = ? AND lab_id = ?')
        .run(Number(req.params.id), labId(req));
      res.redirect('/orders/catalog/materials');
    });

    // Правка и удаление справочника. Одного переключения «активен» мало:
    // цена и единица у материала меняются, а опечатку в названии нужно
    // исправить, а не прятать. В учёте уже использованные материалы не
    // трогаются — они копируются в order_materials, поэтому правка
    // справочника не переписывает прошлые наряды.
    router.post('/catalog/materials/:id', requireAdmin, (req, res) => {
      const id = Number(req.params.id);
      const name = (req.body.name || '').trim().slice(0, 120);
      const unit = (req.body.unit || 'шт').trim().slice(0, 20);
      const category = (req.body.category || '').trim().slice(0, 60);
      const note = (req.body.note || '').trim().slice(0, 300);
      if (name) {
        db.prepare('UPDATE materials SET name = ?, category = ?, unit = ?, note = ? WHERE id = ? AND lab_id = ?')
          .run(name, category, unit, note, id, labId(req));
      }
      res.redirect('/orders/catalog/materials');
    });

    // Удаляем не строку, а переводим её в архив: материал из старых
    // нарядов должен оставаться в отчётах, иначе суммы по архиву разъедутся.
    router.post('/catalog/materials/:id/delete', requireAdmin, (req, res) => {
      db.prepare('UPDATE materials SET active = 0 WHERE id = ? AND lab_id = ?')
        .run(Number(req.params.id), labId(req));
      res.redirect('/orders/catalog/materials');
    });

    return router;
  };
