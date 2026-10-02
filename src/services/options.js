// Редактируемые списки интерфейса: этапы заказа и отметки по работе.
//
// Оба списка раньше жили в dental-reference.js как константы. Это
// означало, что добавить этап «Сканирование» или отметку «Антагонист»
// можно было только правкой файла и деплоем — а человек, который
// настраивает лабораторию, кода не касается.
//
// Теперь список принадлежит лаборатории и живёт в таблице lab_options.
// Значения по умолчанию из dental-reference используются только при
// первом обращении: дальше администратор правит их в /admin/options, и
// приложение читает именно то, что настроил он.
//
// Коды этапов и отметок остаются текстовыми и неизменяемыми: по ним
// пишется история в order_stages и во флагах зубов. Переименовать
// этап можно, сменить его код — нет, иначе старая переписка и журнал
// перестали бы читаться.

const R = require('./dental-reference');

const KINDS = {
  stage: {
    title: 'Этапы заказа',
    defaults: () => R.STAGES.map((s, i) => ({ key: s.key, title: s.title, sort: i * 10 })),
    // Этап, с которого наряд появляется в списке. Отменить заказ можно
    // всегда, поэтому этап нельзя убрать из списка совсем.
    locked: ['new'],
  },
  frame_flag: {
    title: 'Отметки по работе',
    defaults: () => R.FRAME_FLAGS.map((f, i) => ({ key: f.key, title: f.title, sort: i * 10 })),
    locked: [],
  },
};

const keyRe = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Список элементов вида для лаборатории.
 *
 * Первый вызов заполняет lab_options значениями по умолчанию, дальше
 * отдаёт настроенное. Это позволяет удалять устаревшие отметки и
 * переименовывать этапы, не ломая ничего в коде.
 */
function list(db, labId, kind) {
  const spec = KINDS[kind];
  if (!spec) return [];

  const rows = db.prepare(
    'SELECT key, title, sort, active FROM lab_options WHERE lab_id = ? AND kind = ? ORDER BY sort, key'
  ).all(labId, kind);

  if (!rows.length) {
    seed(db, labId, kind);
    return db.prepare(
      'SELECT key, title, sort, active FROM lab_options WHERE lab_id = ? AND kind = ? ORDER BY sort, key'
    ).all(labId, kind);
  }
  return rows;
}

/** Активные элементы — их и показывают в наряде. */
function activeList(db, labId, kind) {
  return list(db, labId, kind).filter(r => r.active);
}

function seed(db, labId, kind) {
  const spec = KINDS[kind];
  if (!spec) return;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO lab_options (lab_id, kind, key, title, sort, active) VALUES (?,?,?,?,?,1)'
  );
  const run = db.transaction(() => {
    for (const item of spec.defaults()) {
      ins.run(labId, kind, item.key, item.title, item.sort);
    }
  });
  run();
}

/** key -> title, как это делает toTitle() в dental-reference. */
function titleMap(db, labId, kind) {
  return Object.fromEntries(activeList(db, labId, kind).map(r => [r.key, r.title]));
}

/** Множество активных ключей — для проверки значения из формы. */
function keySet(db, labId, kind) {
  return new Set(activeList(db, labId, kind).map(r => r.key));
}

/** Есть ли такой активный ключ. */
function isValid(db, labId, kind, key) {
  return keySet(db, labId, kind).has(key);
}

function get(db, labId, kind, key) {
  return db.prepare(
    'SELECT key, title, sort, active FROM lab_options WHERE lab_id = ? AND kind = ? AND key = ?'
  ).get(labId, kind, key) || null;
}

/**
 * Создание или переименование элемента.
 *
 * Создать новый этап можно: код выбирает администратор, и он же его
 * потом увидит в наряде. Код нельзя менять у существующего — от него
 * зависят записи в order_stages.
 */
function upsert(db, labId, kind, data) {
  const spec = KINDS[kind];
  if (!spec) return { error: 'Неизвестный список' };

  const title = String(data.title || '').trim().slice(0, 120);
  if (!title) return { error: 'Введите название' };

  const key = String(data.key || '').trim().toLowerCase();
  if (!keyRe.test(key)) {
    return { error: 'Код — латинскими буквами, цифрами и «_», до 24 знаков' };
  }
  if (title.length > 120) return { error: 'Название слишком длинное' };

  const existing = get(db, labId, kind, key);
  if (existing) {
    if (data.key !== undefined && String(data.key).trim().toLowerCase() !== existing.key) {
      return { error: 'Код уже занят другим пунктом' };
    }
    db.prepare('UPDATE lab_options SET title = ?, sort = ? WHERE lab_id = ? AND kind = ? AND key = ?')
      .run(title, Number(data.sort) || 0, labId, kind, existing.key);
    return { key: existing.key };
  }

  if (spec.locked.includes(key)) return { error: 'Такой код уже зарезервирован' };

  const next = Number(data.sort) || (
    (db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM lab_options WHERE lab_id = ? AND kind = ?')
      .get(labId, kind).m) + 10
  );
  db.prepare('INSERT INTO lab_options (lab_id, kind, key, title, sort, active) VALUES (?,?,?,?,?,1)')
    .run(labId, kind, key, title, next);
  return { key };
}

/**
 * Скрытие или возвращение пункта.
 *
 * Удалять нельзя: по ключу написана история. Скрытый пункт не
 * предлагается в новых нарядах, но остаётся в старых — иначе этап
 * «Спекание» из прошлого наряда превратился бы в пустую строку.
 */
function setActive(db, labId, kind, key, active) {
  const spec = KINDS[kind];
  if (!spec) return { error: 'Неизвестный список' };
  if (spec.locked.includes(key)) return { error: 'Этот пункт нельзя скрыть' };

  const row = get(db, labId, kind, key);
  if (!row) return { error: 'Пункт не найден' };

  db.prepare('UPDATE lab_options SET active = ? WHERE lab_id = ? AND kind = ? AND key = ?')
    .run(active ? 1 : 0, labId, kind, key);
  return {};
}

function update(db, labId, kind, key, data) {
  const spec = KINDS[kind];
  if (!spec) return { error: 'Неизвестный список' };
  const row = get(db, labId, kind, key);
  if (!row) return { error: 'Пункт не найден' };

  const title = String(data.title || '').trim().slice(0, 120);
  if (!title) return { error: 'Введите название' };

  db.prepare('UPDATE lab_options SET title = ?, sort = ? WHERE lab_id = ? AND kind = ? AND key = ?')
    .run(title, Number(data.sort) || row.sort, labId, kind, key);
  return {};
}

module.exports = {
  KINDS, list, activeList, seed, titleMap, keySet, isValid,
  get, upsert, setActive, update,
};
