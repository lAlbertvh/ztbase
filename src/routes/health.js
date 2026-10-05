// Проверка живости для мониторинга и deploy-проверок.
//
// Не требует входа и не отдаёт никаких данных: только «жив» или «база
// недоступна». Наружу маршрут не закрыт — иначе проверка после
// развёртывания потребовала бы сессии, ради которой и проверяет.

const express = require('express');
const cfg = require('../config');

module.exports = function createHealthRoutes({ db }) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch (e) {
      dbOk = false;
    }
    const ok = dbOk ? 'ok' : 'db-error';
    // Видимый адрес нужен только при настройке: по нему видно, проходит ли
    // nginx и какой реальный IP сотрудника. В бою адрес не отдаём.
    const body = { status: ok, uptime: Math.round(process.uptime()) };
    if (cfg.NODE_ENV !== 'production') body.ip = req.ip;
    res.status(dbOk ? 200 : 503).json(body);
  });

  return router;
};