// Маршруты заказ-нарядов.
//
// Отдельный модуль с фабрикой, а не блок в server.js: там уже больше
// тысячи строк, и наряды — самостоятельная функциональность со своей
// схемой, справочниками и правилами доступа.
//
// Доступ: администратор лаборатории и техник видят всё. Стоматолог
// видит только свои наряды и не может менять этапы производства —
// это внутренний процесс лаборатории.

const express = require('express');
const R = require('../services/dental-reference');
const O = require('../services/orders');

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

  // Свои наряды для стоматолога, все для остальных.
  const ownerFilter = (req, where, params) => {
    if (isDentist(req)) {
      where.push('o.created_by = ?');
      params.push(req.session.user);
    }
  };

  // ---- Список нарядов ----
  router.get('/', (req, res) => {
    // Стоматолог видит только свои наряды, остальные — все по лаборатории.
    const { rows, total, limit, offset } = O.listOrders(db, labId(req), {
      stage: req.query.stage,
      search: (req.query.search || '').trim(),
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      owner: isDentist(req) ? req.session.user : '',
      limit: req.query.limit,
      offset: req.query.offset,
    });

    res.render('orders/index', {
      orders: rows,
      total,
      limit,
      offset,
      summary: O.stageSummary(db, labId(req)),
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
    res.render('orders/form', {
      order: null,
      teethText: '',
      materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? AND active = 1 ORDER BY name').all(labId(req)),
      catalog: R,
      incoming: req.query.incoming || '',
      isDentist: isDentist(req),
    });
  });

  // ---- Карточка наряда ----
  router.get('/:id', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (isDentist(req) && order.created_by !== req.session.user) {
      return res.status(403).send('Нет доступа к этому наряду');
    }
    res.render('orders/show', { order, catalog: R, isDentist: isDentist(req) });
  });

  // ---- Редактирование ----
  router.get('/:id/edit', (req, res) => {
    const order = O.getOrder(db, labId(req), Number(req.params.id));
    if (!order) return res.status(404).send('Наряд не найден');
    if (isDentist(req)) return res.status(403).send('Редактирование недоступно');
    res.render('orders/form', {
      order,
      teethText: order.teeth.map(t => t.tooth).join(' '),
      materials: db.prepare('SELECT * FROM materials WHERE lab_id = ? AND active = 1 ORDER BY name').all(labId(req)),
      catalog: R,
      incoming: '',
      isDentist: false,
    });
  });

  // ---- Сохранение ----
  router.post('/', (req, res) => {
    const parsed = O.parseOrderForm(req.body);
    if (!parsed.ok) {
      return res.status(400).send(`Ошибка: ${parsed.error}`);
    }
    const data = parsed.data;
    // id приходит формой только при редактировании.
    if (req.body.id) data.id = Number(req.body.id);

    const result = O.saveOrder(db, labId(req), data, req.session.user);
    if (result.error) return res.status(400).send(`Ошибка: ${result.error}`);

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
    if (isDentist(req) && order.created_by !== req.session.user) {
      return res.status(403).send('Нет доступа');
    }
    res.render('orders/print', { order, catalog: R });
  });

  // ---- Печатная форма нескольких нарядов ----
  router.get('/print/batch', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 200);
    const orders = ids.map(id => O.getOrder(db, labId(req), id)).filter(Boolean);
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

  return router;
};
