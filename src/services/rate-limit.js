// Ограничение частоты попыток по одному ключу.
//
// Счётчик держим в памяти процесса: коды входа и пароли живут в той
// же базе, и переживать перезапуск сервера здесь нечего — после
// перезапуска счётчик обнуляется, что для защиты от перебора
// приемлемо, а лишняя запись в базу на каждую неудачную попытку
// наоборот была бы лишней нагрузкой.
//
// Записи протухают через WINDOW_MS и убираются по таймеру, иначе память
// росла бы бесконечно из-за произвольных ключей от посетителей.

function createLimiter({ limit, windowMs }) {
  const hits = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (now - rec.first > windowMs) hits.delete(key);
    }
  }

  const timer = setInterval(sweep, windowMs);
  // unref нужен, чтобы непрерывающийся таймер не держал процесс живым:
  // сервер должен завершаться по Ctrl-C и по сигналу systemd.
  if (timer.unref) timer.unref();

  /** Сколько попыток уже было по ключу. Новая запись начинает счёт с 1. */
  function count(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.first > windowMs) {
      hits.set(key, { count: 1, first: now });
      return 1;
    }
    rec.count += 1;
    return rec.count;
  }

  /** Превышен ли лимит. */
  function exceeded(key) {
    const rec = hits.get(key);
    if (!rec) return false;
    if (Date.now() - rec.first > windowMs) {
      hits.delete(key);
      return false;
    }
    return rec.count > limit;
  }

  /** Сбросить счётчик — после успешного входа. */
  function clear(key) {
    hits.delete(key);
  }

  return { count, exceeded, clear };
}

module.exports = { createLimiter };