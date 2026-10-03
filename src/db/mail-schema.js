// Одноразовые ссылки для входа и восстановления пароля.
//
// Пароль по почте не пересылаем никогда: письмо несёт ссылку, по
// которой человек сам задаёт пароль. Поэтому в базе лежит только
// SHA-256 от ссылки — восстановить по ней пароль нельзя даже тому,
// кто читает копию базы.
//
// Ссылка одноразовая и срок ограничен: пользоваться можно один раз в
// течение суток. Хранить хэш без срока нельзя, ссылка из старого
// письма годами работала бы как вечный вход в чужую лабораторию.

/**
 * Накатывает схему писем.
 * @param {import('better-sqlite3').Database} db
 */
function migrateMail(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user
      ON password_resets (user_id);
  `);

  // Протухшие и использованные ссылки не нужны: они всё равно не
  // работают, а таблица иначе растёт вместе с числом регистраций.
  db.prepare("DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at <= ?")
    .run(new Date().toISOString());
}

module.exports = { migrateMail };
