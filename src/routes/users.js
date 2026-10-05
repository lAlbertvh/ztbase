// Сотрудники лаборатории: добавление и учётные данные.
//
// Вынесено из server.js, где маршруты шли подряд и раздел нельзя было
// прочитать, не держа в голове соседние. Зависимости передаются явно —
// так же, как в остальных модулях src/routes.

const express = require('express');
const SPEC = require('../services/specializations');


module.exports = function createUsersRoutes({ db, query, hashPassword, license, SPEC, requireAdmin }) {
  const router = express.Router();

  router.get('/add-user', (req, res) => {
      if (!req.session.user) return res.redirect('/login');
      const usage = license.usage(db, req.session.labId || 1);
      res.render('add-user', {
        error: null, usage, warning: license.warningFor(usage),
        specializations: SPEC.BY_ROLE,
      });
    });

  // Добавление сотрудника в лабораторию. Только администратор.
  router.post('/add-user', requireAdmin, async (req, res) => {
      const { password, newUsername, role } = req.body;
      const name = (newUsername || '').trim();
      const labId = req.session.labId || 1;
      // Места в тарифе считаем на каждой попытке добавить человека, а не
      // один раз при загрузке формы: между открытием и отправкой могли
      // завести ещё двоих.
      const usage = license.usage(db, labId);
      const fail = (msg) => res.render('add-user', { error: msg, usage, warning: license.warningFor(usage) });

      if (!name) {
        return fail('Имя не может быть пустым');
      }
      if (!password || password.length < 6) {
        return fail('Пароль должен быть не короче 6 символов');
      }

      const newRole = role === 'admin' ? 'admin' : 'tech';
      // Специализация не выбирает роль и не даёт прав: это подпись «кем
      // работает». Значение из другой роли отбрасываем, иначе через
      // подделанную форму можно было бы записать технику «бухгалтером».
      const specialization = SPEC.fromForm(newRole, req.body.specialization);

      try {
        const existing = query(
          'SELECT id FROM users WHERE name = ? AND lab_id = ?',
          [name, labId]
        ).rows;
        if (existing.length > 0) {
          return fail('Пользователь с таким именем уже существует');
        }
      query(
        'INSERT INTO users (name, password_hash, role, specialization, active, lab_id) VALUES (?, ?, ?, ?, 1, ?)',
        [name, hashPassword(password), newRole, specialization, req.session.labId || 1]
      );
      res.redirect('/');
    } catch (err) {
      console.error(err);
      res.render('add-user', { error: 'Ошибка базы данных', usage, warning: license.warningFor(usage) });
    }
  });

  return router;
};
