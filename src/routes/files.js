// Обмен 3D-файлами: список, загрузка, выдача, статусы.
//
// Вынесено из server.js, где маршруты шли подряд и раздел нельзя было
// прочитать, не держа в голове соседние. Зависимости передаются явно —
// так же, как в остальных модулях src/routes.

const express = require('express');
const path = require('path');
const fs = require('fs');
const inbox = require('../services/inbox');

module.exports = function createFilesRoutes({ db, query, storage, quota, upload }) {
  const router = express.Router();

  router.get('/files', async (req, res) => {
    const { date, uploader, downloaded, filename } = req.query;

    let sql = 'SELECT * FROM files';
    const params = [];
    const conditions = [];

    // Ограничение по лаборатории добавляется первым условием и всегда:
    // без него заказы других лабораторий были бы видны.
    const labId = req.session.labId || 1;
    conditions.push('lab_id = ?');
    params.push(labId);

    if (date) {
      conditions.push('substr(upload_date, 1, 10) = ?');
      params.push(date);
    }
    if (uploader) {
      conditions.push('uploader = ?');
      params.push(uploader);
    }
    if (downloaded !== undefined && downloaded !== '') {
      conditions.push('downloaded = ?');
      params.push(downloaded === 'true' ? 1 : 0);
    }
    if (filename && filename.trim() !== '') {
      conditions.push('original_name LIKE ?');
      params.push('%' + filename + '%');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY upload_date DESC';

    try {
      const filesResult = query(sql, params);
      const files = filesResult.rows;

      const today = new Date().toISOString().slice(0, 10);
      const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
      const monthNamesGen = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      const byMonth = {};
      files.forEach(f => {
        const d = (f.upload_date || '').slice(0, 10);
        if (!d) return;
        const [y, m] = d.split('-').map(Number);
        const monthKey = `${y}-${String(m).padStart(2, '0')}`;
        if (!byMonth[monthKey]) {
          byMonth[monthKey] = { monthKey, monthLabel: `${monthNames[m - 1]} ${y}`, days: {} };
        }
        if (!byMonth[monthKey].days[d]) {
          byMonth[monthKey].days[d] = { dateKey: d, isToday: d === today, files: [] };
        }
        byMonth[monthKey].days[d].files.push(f);
      });
      const groupedFiles = Object.keys(byMonth)
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

      const uploadersResult = query('SELECT DISTINCT uploader FROM files WHERE lab_id = ?', [req.session.labId || 1]);
      const uploaders = uploadersResult.rows.map(row => row.uploader);

      // Занятое место показываем на странице загрузки: там человек и
      // решает, что грузить. Обход папки дёшево, но ошибку чтения глотать
      // нельзя — иначе вместо суммы в шаблон уехал бы ноль.
      let storageUsage = null;
      try {
        storageUsage = await quota.status(labId);
      } catch (e) {
        // Сбой подсчёта не должен ронять страницу: загрузка всё равно
        // получит отказ на проверке места.
        console.error('Не удалось посчитать занятое место:', e.message);
      }

      res.render('index', {
        files,
        groupedFiles,
        todayKey: today,
        users: uploaders,
        currentUser: req.session.user,
        isAdmin: req.session.role === 'admin',
        filters: { date, uploader, downloaded, filename },
        storageUsage
      });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка базы данных');
    }
  });

  // Загрузка файлов
  router.post('/upload', upload.fields([
    { name: 'stlFiles', maxCount: 20 },
    { name: 'imageFile', maxCount: 1 }
  ]), async (req, res) => {
    if (!req.files || !req.files['stlFiles'] || req.files['stlFiles'].length === 0) {
      return res.status(400).send('Не выбрано ни одного 3D-файла.');
    }

    const stlFiles = req.files['stlFiles'];
    const imageFile = req.files['imageFile'] ? req.files['imageFile'][0] : null;

    const uploader = req.session.user;
    const labId = req.session.labId || 1;
    const uploadDate = new Date().toISOString();
    const milled = req.body.milled === 'on';
    const baked = req.body.baked === 'on';
    const comment = req.body.comment || '';

    const tmpDirs = new Set();
    const collectTmp = (f) => {
      if (f && f.path) {
        tmpDirs.add(path.dirname(f.path));
        if (f.filename) f.savedAs = f.filename;
      }
    };
    stlFiles.forEach(collectTmp);
    collectTmp(imageFile);

    try {
      // Проверяем место ДО переноса файлов: если лимит уже выбран, файл
      // не должен даже на секунду ложиться на диск. 507 — честный код
      // «не хватило места», клиент покажет текст ошибки как есть.
      const incomingBytes = stlFiles.reduce((sum, f) => sum + (f.size || 0), 0)
        + (imageFile ? imageFile.size || 0 : 0);
      const verdict = await quota.check({ labId, bytes: incomingBytes });
      if (!verdict.ok) {
        return res.status(507).send(verdict.message);
      }

      // Переносим файлы из временной папки в хранилище лаборатории.
      // При STORAGE_BACKEND=s3 это единственное место, где идёт загрузка.
      let imageName = null;
      if (imageFile) {
        imageName = await storage.put(imageFile.path, labId, imageFile.savedAs);
      }
      const stlRows = [];
      for (const f of stlFiles) {
        const savedAs = await storage.put(f.path, labId, f.savedAs);
        stlRows.push([Buffer.from(f.originalname, 'latin1').toString('utf8'), savedAs]);
      }

      const insertStmt = db.prepare(
        `INSERT INTO files
         (original_name, stored_name, image_name, uploader, upload_date, downloaded, milled, baked, comment, lab_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertAll = db.transaction((rows) => {
        for (const [decodedStlName, storedStlName] of rows) {
          insertStmt.run(decodedStlName, storedStlName, imageName, uploader, uploadDate, 0, milled ? 1 : 0, baked ? 1 : 0, comment, labId);
        }
      });
      insertAll(stlRows);
      res.redirect('/');
    } catch (err) {
      console.error('Ошибка при загрузке файлов:', err);
      res.status(500).send('Ошибка при сохранении в БД.');
    } finally {
      // Временные папки убираем в любом случае, иначе они разрастаются.
      for (const d of tmpDirs) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch (e) {
          console.error('Не удалось убрать временную папку:', d, e.message);
        }
      }
    }
  });

  // Скачивание 3D-файла
  router.get('/download/:id', async (req, res) => {
    const fileId = req.params.id;
    const downloader = req.session.user;

    try {
      const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
      if (fileResult.rows.length === 0) {
        return res.status(404).send('Файл не найден.');
      }
      const file = fileResult.rows[0];

      const updateDownloaders = (currentList, newUser) => {
        if (!currentList) return newUser;
        const users = currentList.split(',').map(u => u.trim());
        if (users.includes(newUser)) return currentList;
        return currentList + ', ' + newUser;
      };

      if (!file.downloaded) {
        const downloadDate = new Date().toISOString();
        query(
          'UPDATE files SET downloaded = 1, downloaded_by = ?, downloaded_date = ? WHERE id = ? AND lab_id = ?',
          [downloader, downloadDate, fileId, req.session.labId || 1]
        );
      } else {
        const newList = updateDownloaders(file.downloaded_by, downloader);
        if (newList !== file.downloaded_by) {
          query(
            'UPDATE files SET downloaded_by = ? WHERE id = ? AND lab_id = ?',
            [newList, fileId, req.session.labId || 1]
          );
        }
      }

      await storage.sendFile(res, file.lab_id || 1, file.stored_name, file.original_name);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка сервера');
    }
  });

  // MIME-типы для изображений
  const imageMime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml'
  };

  // Просмотр изображения
  router.get('/image/:id', async (req, res) => {
    const fileId = req.params.id;
    try {
      const result = query('SELECT image_name, lab_id FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
      if (result.rows.length === 0 || !result.rows[0].image_name) {
        return res.status(404).send('Изображение не найдено.');
      }
      const file = result.rows[0];
      // Через storage, а не sendFile: при STORAGE_BACKEND=s3 файла на диске нет.
      await storage.sendFile(res, file.lab_id, file.image_name, file.image_name, true);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка сервера');
    }
  });

  // Скачивание изображения
  router.get('/download-image/:id', async (req, res) => {
    const fileId = req.params.id;
    try {
      const result = query('SELECT image_name, lab_id, original_name FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
      if (result.rows.length === 0 || !result.rows[0].image_name) {
        return res.status(404).send('Изображение не найдено.');
      }
      const file = result.rows[0];
      await storage.sendFile(res, file.lab_id || 1, file.image_name, file.original_name);
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка сервера');
    }
  });

  // Удаление файла
  router.post('/delete/:id', async (req, res) => {
    const fileId = req.params.id;
    const { code } = req.body;

    if (code !== '78') {
      return res.status(403).send('Неверный код');
    }

    try {
      const fileResult = query('SELECT * FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
      if (fileResult.rows.length === 0) {
        return res.status(404).send('Файл не найден');
      }
      const file = fileResult.rows[0];

      try {
        await storage.remove(file.lab_id || 1, file.stored_name);
        if (file.image_name) {
          await storage.remove(file.lab_id || 1, file.image_name);
        }
      } catch (err) {
        console.error('Ошибка удаления файлов:', err);
      }

      await query('DELETE FROM files WHERE id = ? AND lab_id = ?', [fileId, req.session.labId || 1]);
      res.redirect('/');
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка при удалении из БД');
    }
  });

  // Переключение статусов
  router.post('/toggle-milled/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Не авторизован');
    try {
      await query('UPDATE files SET milled = NOT milled WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка БД');
    }
  });

  router.post('/toggle-baked/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Не авторизован');
    try {
      await query('UPDATE files SET baked = NOT baked WHERE id = ? AND lab_id = ?', [req.params.id, req.session.labId || 1]);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка БД');
    }
  });

  router.post('/comment/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Не авторизован');
    const { comment } = req.body;
    try {
      await query('UPDATE files SET comment = ? WHERE id = ? AND lab_id = ?', [comment, req.params.id, req.session.labId || 1]);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).send('Ошибка БД');
    }
  });

  // Страница добавления пользователя

  return router;
};
