// ------ Лимит хранилища ------
// Два независимых ограничителя. Оба нужны, потому что закрывают
// разные беды:
//
//   1. Квота лаборатории (STORAGE_QUOTA_GB) — чтобы отдельно взятая
//      лаборатория не съела место, на которое рассчитывают другие.
//   2. Свободное место на диске (STORAGE_MIN_FREE_GB) — то, что реально
//      спасает сервер. На VPS диск общий с системой, базой и бэкапами:
//      если файлы займут его целиком, встанет всё, включая таймер
//      бэкапа, который не сможет записать копию.
//
// Раньше STORAGE_QUOTA_GB был в конфиге, но не читался кодом: лимита
// не существовало вовсе. Теперь значение проверяется.
//
// Проверка идёт ДО переноса файлов в хранилище. Иначе превышение
// обнаружится уже после того, как файл лёг на диск, и придётся его
// убирать, оставляя запись в базе без файла.
const fs = require('fs');
const { storage, BACKEND, uploadDir } = require('./storage');

const GB = 1024 * 1024 * 1024;

// Значения по умолчанию. Квоту читаем при каждом вызове, а не один раз
// при загрузке модуля: переменные окружения выставляет systemd, и в
// тестах их удобно менять на ходу.
const DEFAULT_QUOTA_GB = 100;
// Сколько свободного места держим про запас. На диске в 25 ГБ два
// гигабайта — это несколько бэкапов базы и запас на распаковку.
const DEFAULT_MIN_FREE_GB = 2;

function gbSetting(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback * GB;
  const gb = Number(raw);
  // Мусор в конфиге не должен молча превращать лимит в ноль и обрушить
  // загрузки: при нечисловом значении берём запасной вариант.
  if (!Number.isFinite(gb) || gb < 0 || (!allowZero && gb === 0)) return fallback * GB;
  return gb * GB;
}

function quotaBytes() {
  return gbSetting('STORAGE_QUOTA_GB', DEFAULT_QUOTA_GB);
}

function minFreeBytes() {
  return gbSetting('STORAGE_MIN_FREE_GB', DEFAULT_MIN_FREE_GB, { allowZero: true });
}

// Свободное место на диске, где лежат файлы. bavail, а не bfree:
// зарезервированное ядром место (для root и экстренных нужд) нам
// недоступно — процесс идёт от пользователя ztlab без прав админа.
// Для S3 своего диска нет, там смысла в проверке нет.
function probeFreeBytes() {
  if (BACKEND !== 'local') return null;
  const st = fs.statfsSync(uploadDir);
  return st.bavail * st.bsize;
}

function formatGb(bytes) {
  const mb = bytes / (1024 * 1024);
  // Ноль показываем нулём: округление вверх превратило бы пустое
  // хранилище в «1 КБ», и сотрудник думал бы, что что-то загружено.
  if (bytes <= 0) return '0 КБ';
  // Единица меняется на границах, а не по произвольному порогу:
  // раньше 150 МБ превращались в «0,1 ГБ», а это выглядит так, будто
  // на сервере почти ничего не лежит.
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (mb < 1024) return `${mb.toFixed(1).replace('.', ',')} МБ`;
  return `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`;
}

// Занятое место лаборатории в байтах.
function usedBytes(labId) {
  return storage.usage(labId);
}

/**
 * Можно ли принять bytes байт сверх уже занятого места.
 * Возвращает { ok: true } либо { ok: false, code, message }.
 *
 * freeBytes можно передать, когда значение уже известно: в тестах
 * диск заполнить нельзя, а в бою его читает probeFreeBytes.
 */
async function check({ labId, bytes, freeBytes }) {
  if (!(bytes > 0)) return { ok: true };

  const used = await usedBytes(labId);
  const limit = quotaBytes();

  if (used + bytes > limit) {
    return {
      ok: false,
      code: 'quota',
      message: 'В хранилище лаборатории закончилось место: '
        + `занято ${formatGb(used)} из ${formatGb(limit)}. `
        + 'Файл не сохранён. Удалите старые файлы или попросите администратора '
        + 'увеличить квоту.'
    };
  }

  const free = freeBytes === undefined ? probeFreeBytes() : freeBytes;
  // null — облачное хранилище, места на своём диске не тратится.
  if (free !== null && free !== undefined) {
    const keep = minFreeBytes();
    if (free - bytes < keep) {
      return {
        ok: false,
        code: 'disk',
        message: 'На сервере не хватает свободного места: '
          + `осталось ${formatGb(Math.max(0, free))}, `
          + `а нужно ${formatGb(bytes)} и ещё ${formatGb(keep)} про запас. `
          + 'Файл не сохранён. Сообщите администратору — нужна чистка старых файлов.'
      };
    }
  }

  return { ok: true, used, limit, free };
}

// Данные для интерфейса: сколько занято и сколько можно.
async function status(labId) {
  const used = await usedBytes(labId);
  const limit = quotaBytes();
  const free = probeFreeBytes();
  const keep = minFreeBytes();
  return {
    used,
    limit,
    free,
    // Ближе к концу квоты строка становится предупреждением.
    nearLimit: limit > 0 && used / limit >= 0.9,
    usedText: formatGb(used),
    limitText: formatGb(limit),
    // Что показывать вместо «свободно на диске»: для S3 места нет.
    freeText: free === null ? null : `${formatGb(free)} свободно на сервере`
  };
}

module.exports = {
  GB,
  quotaBytes,
  minFreeBytes,
  usedBytes,
  probeFreeBytes,
  formatGb,
  check,
  status
};