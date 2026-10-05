// Проверка сессии, роль администратора и счётчики попыток входа.
//
// Раньше это был блок прямо в server.js, а маршруты входа брали
// счётчики оттуда по замыканию. Здесь они живут рядом с правилами,
// которые их используют, и создаются один раз на процесс.
//
// Порядок проверок важен и задан осознанно:
//
//   1. публичные адреса — пропускаем, иначе страница входа сама
//      потребовала бы входа;
//   2. наличие сессии — неавторизованный посетитель получает /login,
//      а не экран оплаты чужой лаборатории;
//   3. пробный период — проверка после сессии по той же причине;
//   4. незавершённая настройка — только администратору, иначе врача
//      уводило бы с чужой настройки.

const express = require('express');
const { createLimiter } = require('../services/rate-limit');
const { trialExpired } = require('../services/trial');
const { setupPending } = require('../db/setup-schema');

// Публичные по существу: страницы, куда человек приходит без сессии.
const PUBLIC_PATHS = new Set([
  '/login', '/set-user', '/register', '/register-lab', '/health', '/lead', '/logout',
  '/join', '/legal/privacy', '/legal/offer',
  // Восстановление пароля приходит по ссылке из письма, то есть
  // до всякой сессии. Саму ссылку проверяет маршрут, а форма запроса
  // открыта всем: иначе забытый пароль нельзя было бы восстановить.
  '/password/reset', '/password/set',
]);

// Экран продления и его форма должны работать без действующей подписки.
// Это не ослабление проверки: внутри /trial нет ни одного рабочего
// раздела, там только текст и заявка на продление.
const TRIAL_PATHS = ['/trial'];

// Редактор содержимого пропускается мимо общей проверки, иначе запрос
// без сессии ушёл бы на /login и до маршрута не дошёл. Свою проверку
// раздел всё равно делает: пароль, если он задан, и роль администратора.
// /public и обе админки должны доходить до своих обработчиков без
// сессии: там своя проверка — пароль администратора. Иначе глобальный
// редирект на /login перехватывал бы запрос раньше Basic-аутентификации,
// и вместо ответа 401 клиент получал бы 302 и не понимал, что нужен пароль.
const PUBLIC_PREFIXES = ['/public', '/admin/content'];

// Защита от подбора пароля.
//
// Счётчика два, потому что лаборатория обычно сидит за одним роутером,
// и один счётчик на весь адрес блокировал бы вход сразу всем сотрудникам.
//
//  1) на пару «адрес + сотрудник» — 10 попыток. Защищает конкретную учётку.
//  2) на адрес — 100 попыток. Ловит перебор с перебором имён подряд,
//     но обычных сотрудников не задевает.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_PER_IP = 100;

module.exports = function createAuth(db) {
  const byIp = createLimiter({ limit: MAX_ATTEMPTS_PER_IP, windowMs: ATTEMPT_WINDOW_MS });
  const byUser = createLimiter({ limit: MAX_ATTEMPTS, windowMs: ATTEMPT_WINDOW_MS });

  /**
   * Считает попытку и возвращает, не превышен ли лимит.
   * Счётчики раздельные: превышение по сотруднику не должно
   * блокировать вход остальным, даже если адрес тот же.
   */
  function registerAttempt(ip, slug, username) {
    const ipKey = `ip:${ip}`;
    const userKey = `user:${ip}:${slug}:${username}`;
    return byIp.count(ipKey) > MAX_ATTEMPTS_PER_IP
        || byUser.count(userKey) > MAX_ATTEMPTS;
  }

  /** Сбросить счётчики после успешного входа. */
  function clearAttempts(ip, slug, username) {
    byIp.clear(`ip:${ip}`);
    byUser.clear(`user:${ip}:${slug}:${username}`);
  }

  /** Пропуск middleware для администратора лаборатории. */
  function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.role !== 'admin') {
      return res.status(403).send('Недостаточно прав');
    }
    next();
  }

  /** Основная проверка: сессия, роль, пробный период, настройка. */
  function guard(req, res, next) {
    if (PUBLIC_PATHS.has(req.path) ||
        PUBLIC_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }
    if (!req.session.user) {
      return res.redirect('/login');
    }
    // Роль и пользователь нужны каждому экрану, а не только главному:
    // навигация решает по роли, какие плитки вообще показывать.
    // Явные параметры res.render по-прежнему имеют приоритет.
    res.locals.currentUser = req.session.user;
    res.locals.isAdmin = req.session.role === 'admin';
    res.locals.isDentist = req.session.role === 'dentist';

    // Пробный период закончился: весь функционал закрыт, лаборатория
    // видит экран продления. Данные не удаляются — после оплаты всё
    // вернётся как было.
    if (!TRIAL_PATHS.some((prefix) => req.path.startsWith(prefix)) &&
        trialExpired(db, req.session.labId)) {
      return res.redirect('/trial');
    }

    // Незавершённая настройка: показываем мастер вместо рабочих
    // экранов. Это только первый запуск лаборатории — после «пропустить»
    // флаг снимается и мастер больше не появляется сам. Проверяем
    // администратора, а не любого вошедшего.
    if (req.session.role === 'admin' &&
        !req.path.startsWith('/setup') &&
        req.path !== '/logout' &&
        setupPending(db, req.session.labId)) {
      return res.redirect('/setup');
    }
    next();
  }

  // router нужен, чтобы подключить guard обычным app.use(router):
  // так порядок сохраняется, а сам guard остаётся доступным для тестов.
  const router = express.Router();
  router.use(guard);

  return {
    router,
    guard,
    requireAdmin,
    registerAttempt,
    clearAttempts,
    MAX_ATTEMPTS,
    MAX_ATTEMPTS_PER_IP,
  };
};