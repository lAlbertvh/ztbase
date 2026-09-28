// Хранилище сессий в той же базе SQLite.
//
// Зачем: express-session из коробки держит сессии в памяти. Тогда после
// каждого перезапуска Node (деплой, падение, перезагрузка ноутбука)
// все сотрудники выходят из аккаунтов и теряют несохранённое состояние.
// Хранилище в SQLite переживает перезапуск.
//
// Таблица очищается сама: записи старше 30 дней удаляются при чтении,
// иначе база росла бы бесконечно.
const session = require('express-session');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;   // раз в час
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 дней

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
    `);
    this.timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Не мешаем процессу завершиться: сервер должен выключаться по Ctrl+C.
    if (this.timer.unref) this.timer.unref();
  }

  cleanup() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    } catch (e) {
      console.error('Ошибка очистки сессий:', e.message);
    }
  }

  _expiryFor(sess) {
    const ms = sess && sess.cookie && sess.cookie.originalMaxAge
      ? sess.cookie.originalMaxAge
      : MAX_AGE_MS;
    return Date.now() + ms;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      this.db.prepare(
        'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
      ).run(sid, JSON.stringify(sess), this._expiryFor(sess));
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?')
        .run(this._expiryFor(sess), sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  length(cb) {
    try {
      const r = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      cb(null, r.n);
    } catch (e) {
      cb(e);
    }
  }

  clear(cb) {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
}

module.exports = SqliteStore;
