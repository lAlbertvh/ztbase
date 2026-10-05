// Хаб: меню разделов с количеством ожидающего.
//
// Вынесено из server.js, где маршруты шли подряд и раздел нельзя было
// прочитать, не держа в голове соседние. Зависимости передаются явно —
// так же, как в остальных модулях src/routes.

const express = require('express');
const { setupPending } = require('../db/setup-schema');
const inbox = require('../services/inbox');


module.exports = function createHubRoutes({ db, license }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const labId = req.session.labId || 1;
    const isDentist = req.session.role === 'dentist';
    const isAdmin = req.session.role === 'admin';

    // Счётчики на плитках: человек должен видеть, что ждёт его внимания,
    // не заходя в каждый раздел по очереди.
    const one = (sql, ...p) => db.prepare(sql).get(labId, ...p).n;

    const orders = isDentist
      ? db.prepare(`
          SELECT COUNT(*) AS n FROM orders
          WHERE lab_id = ?
            AND stage NOT IN ('issued','cancelled')
            AND (clinic_id IS NOT NULL AND clinic_id = (
                  SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?)
                 OR created_by = ?)
        `).get(labId, req.session.userId, labId, req.session.user).n
      : one("SELECT COUNT(*) AS n FROM orders WHERE lab_id = ? AND stage NOT IN ('issued','cancelled')");

    const files = one('SELECT COUNT(*) AS n FROM files WHERE lab_id = ? AND downloaded = 0');

    // Непрочитанные переписки считает тот же сервис, что и инбокс.
    // Дублировать запрос здесь нельзя: счётчик на хабе обязан считать
    // ровно то же, что человек потом увидит в /messages. Иначе врач
    // получает на главной непрочитанные по чужим клиникам, до которых
    // в инбоксе не дотянуться.
    const ownClinic = isDentist
      ? db.prepare('SELECT clinic_id FROM users WHERE id = ? AND lab_id = ?')
        .get(req.session.userId, labId)
      : null;
    const scope = isDentist
      ? { name: req.session.user, clinicId: ownClinic ? ownClinic.clinic_id : null }
      : null;
    const unread = inbox.unreadTotal(db, labId, req.session.userId, scope);

    res.render('hub', {
      currentUser: req.session.user,
      isAdmin, isDentist,
      counters: { orders, files, unread },
      usage: isAdmin ? license.usage(db, labId) : null,
      setupPendingHere: isAdmin && setupPending(db, labId),
      // Сообщение после регистрации показываем один раз и сразу снимаем:
      // иначе оно висело бы на хабе до конца сессии.
      notice: req.session.notice || null,
    });
    if (req.session.notice) delete req.session.notice;
  });

  // Обмен файлами. Раньше этот экран занимал '/', и из-за него навигация
  // начиналась со случайного раздела.

  return router;
};
