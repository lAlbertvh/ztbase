// Учёт титановых оснований: список, выдача, выгрузка в Excel, печать наряда.
//
// Отдельный модуль потому, что это самостоятельный раздел со своим
// шаблоном titan_print и выгрузкой в Excel. Маршруты собираются в
// роутер, который подключается на префиксе /titan — но пути внутри
// пришлось бы переименовать, поэтому роутер подключается без префикса,
// а пути остаются такими же, как были.
//
// Зависимости передаются явно: тот же приём, что в остальных модулях
// src/routes, чтобы маршруты не зависели от того, что происходит
// в server.js.

const express = require('express');
const ExcelJS = require('exceljs');

module.exports = function createTitanRoutes({ db, query, requireAdmin }) {
  const router = express.Router();

  // ===== МАРШРУТЫ ДЛЯ УЧЁТА ТИТАНОВЫХ ОСНОВАНИЙ =====

  // Страница со списком оснований (ИСПРАВЛЕННАЯ)
  router.get('/titan', async (req, res) => {
    try {
      const { order_number, status, date_from, date_to } = req.query;
      let sql = 'SELECT * FROM titan_orders';
      const params = [];
      const conditions = [];

      // Фильтр по лаборатории добавляется всегда, до остальных условий.
      conditions.push('lab_id = ?');
      params.push(req.session.labId || 1);

      if (order_number && order_number.trim() !== '') {
        conditions.push(`order_number LIKE ?`);
        params.push(`%${order_number}%`);
      }
      if (status && status !== 'all') {
        conditions.push(`status = ?`);
        params.push(status);
      }
      if (date_from) {
        conditions.push(`order_date >= ?`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`order_date <= ?`);
        params.push(date_to);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY order_date DESC, created_at DESC';

      const result = query(sql, params);
      const orders = result.rows;

      // ИСПРАВЛЕНО: используем локальную дату
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const todayKey = `${year}-${month}-${day}`;

      const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
      const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      const byMonth = {};

      orders.forEach(o => {
        let dateStr = o.order_date;
        if (!dateStr) return;
        if (typeof dateStr === 'object' && dateStr.toISOString) {
          const d = new Date(dateStr);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const dday = String(d.getDate()).padStart(2, '0');
          dateStr = `${y}-${m}-${dday}`;
        } else {
          dateStr = String(dateStr).slice(0, 10);
        }
        const [y, m] = dateStr.split('-').map(Number);
        const monthKey = `${y}-${String(m).padStart(2, '0')}`;
        if (!byMonth[monthKey]) {
          byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m-1]} ${y}`, days: {} };
        }
        if (!byMonth[monthKey].days[dateStr]) {
          byMonth[monthKey].days[dateStr] = { dateKey: dateStr, isToday: dateStr === todayKey, orders: [] };
        }
        byMonth[monthKey].days[dateStr].orders.push(o);
      });

      const groupedOrders = Object.keys(byMonth)
        .sort((a, b) => b.localeCompare(a))
        .map(k => {
          const month = byMonth[k];
          const dayKeys = Object.keys(month.days).sort((a, b) => b.localeCompare(a));
          month.daysList = dayKeys.map(dk => {
            const day = month.days[dk];
            const [, mm, dd] = dk.split('-');
            const mi = parseInt(mm, 10) - 1;
            day.dayLabel = `${parseInt(dd, 10)} ${monthNamesGen[mi]} ${month.monthLabel.split(' ')[1]}`;
            return day;
          });
          return month;
        });

      // Доступ к титановым основаниям — у администратора лаборатории.
      // Раньше это определялось именем «Елена», что не переносилось на другие лаборатории.
      const isAdmin = (req.session.role === 'admin');

      res.render('titan', {
        orders: orders,
        groupedOrders: groupedOrders,
        todayKey: todayKey, // передаём исправленную дату
        currentUser: req.session.user,
        isAdmin: isAdmin,
        filters: { order_number, status, date_from, date_to }
      });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка базы данных');
    }
  });

  // Добавление записей (несколько позиций)
  router.post('/titan/add', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { order_date, order_number, items } = req.body;
    let itemsArray = [];
    if (items) {
      if (Array.isArray(items)) {
        itemsArray = items;
      } else {
        itemsArray = [items];
      }
    } else {
      const { system_name, size, has_hex } = req.body;
      if (system_name && size) {
        itemsArray.push({ system_name, size, has_hex: has_hex === 'on' });
      }
    }

    if (itemsArray.length === 0) {
      return res.status(400).send('Нет данных для добавления');
    }

    const client = db;
    try {
      const insertStmt = db.prepare(
        `INSERT INTO titan_orders 
         (order_date, order_number, system_name, size, has_hex, created_by, lab_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertAll = db.transaction((rows) => {
        for (const item of rows) {
          const sizeValue = parseFloat(item.size);
          if (isNaN(sizeValue)) {
            throw new Error(`Некорректное значение размера: ${item.size}`);
          }
          insertStmt.run(
            order_date || new Date().toISOString().slice(0,10),
            order_number,
            item.system_name,
            sizeValue,
            item.has_hex === true || item.has_hex === 'on' ? 1 : 0,
            req.session.user,
            req.session.labId || 1
          );
        }
      });
      insertAll(itemsArray);
      res.redirect('/titan');
    } catch (err) {
      console.error('Ошибка при добавлении:', err);
      res.status(500).send('Ошибка при добавлении: ' + err.message);
    }
  });

  // Переключение статуса основания — только для администратора лаборатории
  router.post('/titan/toggle-status/:id', requireAdmin, async (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Доступ запрещён' });
    }
    const id = req.params.id;
    try {
      const current = query('SELECT status FROM titan_orders WHERE id = ? AND lab_id = ?', [id, req.session.labId || 1]);
      if (current.rows.length === 0) return res.status(404).json({ success: false });
      const newStatus = current.rows[0].status === 'pending' ? 'issued' : 'pending';
      await query('UPDATE titan_orders SET status = ? WHERE id = ? AND lab_id = ?', [newStatus, id, req.session.labId || 1]);
      res.json({ success: true, newStatus });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false });
    }
  });

  // Экспорт в Excel (с учётом текущих фильтров)
  router.get('/titan/export', async (req, res) => {
    try {
      const { order_number, status, date_from, date_to } = req.query;
      let sql = 'SELECT * FROM titan_orders';
      const params = [];
      const conditions = [];

      // Фильтр по лаборатории добавляется всегда, до остальных условий.
      conditions.push('lab_id = ?');
      params.push(req.session.labId || 1);

      if (order_number && order_number.trim() !== '') {
        conditions.push(`order_number LIKE ?`);
        params.push(`%${order_number}%`);
      }
      if (status && status !== 'all') {
        conditions.push(`status = ?`);
        params.push(status);
      }
      if (date_from) {
        conditions.push(`order_date >= ?`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`order_date <= ?`);
        params.push(date_to);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY order_date, order_number';

      const result = query(sql, params);
      const rows = result.rows;

      const groups = {};
      rows.forEach(row => {
        let dateStr = row.order_date;
        if (typeof dateStr === 'object' && dateStr.toISOString) {
          const d = new Date(dateStr);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const dday = String(d.getDate()).padStart(2, '0');
          dateStr = `${y}-${m}-${dday}`;
        } else {
          dateStr = String(dateStr).slice(0, 10);
        }
        const key = `${row.order_number}_${row.system_name}_${row.size}_${row.has_hex}`;
        if (!groups[key]) {
          groups[key] = {
            order_date: dateStr,
            order_number: row.order_number,
            system_name: row.system_name,
            size: row.size,
            has_hex: row.has_hex ? 'Да' : 'Нет',
            count: 0
          };
        }
        groups[key].count++;
      });

      const data = Object.values(groups).sort((a, b) => {
        if (a.order_number !== b.order_number) return a.order_number.localeCompare(b.order_number);
        return a.order_date.localeCompare(b.order_date);
      });

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Титановые основания');

      worksheet.columns = [
        { header: 'Дата', key: 'order_date', width: 12 },
        { header: 'Наряд', key: 'order_number', width: 15 },
        { header: 'Система', key: 'system_name', width: 25 },
        { header: 'Размер', key: 'size', width: 10 },
        { header: 'Позиционер', key: 'has_hex', width: 12 },
        { header: 'Количество', key: 'count', width: 10 }
      ];

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4CAF50' }
      };

      worksheet.addRows(data);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=titan_export.xlsx');
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('Ошибка при создании Excel:', err);
      res.status(500).send('Ошибка при создании Excel: ' + err.message);
    }
  });

  // Печать (поддерживает фильтр по номеру наряда и диапазону дат)
  router.get('/titan/print', async (req, res) => {
    try {
      const { order_number, date_from, date_to } = req.query;
      let sql = 'SELECT * FROM titan_orders';
      const params = [];
      const conditions = [];

      // Фильтр по лаборатории добавляется всегда, до остальных условий.
      conditions.push('lab_id = ?');
      params.push(req.session.labId || 1);

      if (order_number) {
        conditions.push(`order_number LIKE ?`);
        params.push(`%${order_number}%`);
      }
      if (date_from) {
        conditions.push(`order_date >= ?`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`order_date <= ?`);
        params.push(date_to);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY order_date, order_number';

      const result = query(sql, params);
      const orders = result.rows;
      orders.forEach(o => {
        if (o.order_date && typeof o.order_date === 'object') {
          const d = new Date(o.order_date);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const dday = String(d.getDate()).padStart(2, '0');
          o.order_date = `${y}-${m}-${dday}`;
        }
      });

      let title = 'Печать нарядов';
      if (order_number) {
        title = `Наряд № ${order_number}`;
      } else if (date_from && date_to) {
        title = `Период с ${date_from} по ${date_to}`;
      } else if (date_from) {
        title = `С ${date_from}`;
      } else if (date_to) {
        title = `По ${date_to}`;
      }

      res.render('titan_print', { 
        orders, 
        title: 'Печать нарядов',
        subtitle: title,
        order_number: order_number || null,
        date_from: date_from || null,
        date_to: date_to || null
      });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка при загрузке данных для печати');
    }
  });

  // Запуск сервера
  //
  // HOST: на боевой машине приложение слушает только петлю, а не всю сеть.
  // Иначе любой, кто достучится до порта напрямую, обратится к нему в
  // обход nginx и без HTTPS.
  return router;
};
