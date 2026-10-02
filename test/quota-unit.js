// Лимит хранилища: подсчёт занятого места и отказ при превышении.
//
// Проверка работает с настоящими файлами во временной папке, потому
// что подсчёт идёт по диску, а не по таблице files: ошибка здесь
// молчаливая — приложение посчитает неверно и разрешит забить диск.
//
// Диск заполнить нельзя, поэтому проверка свободного места
// подставляется числом — ровно так же, как её подставил бы реальный
// statfs на почти полном томе.
//
// Запуск:  node test/quota-unit.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// UPLOAD_DIR задаётся ДО загрузки модулей: путь читается один раз при
// их инициализации, и подмена позже уже не подействует.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ztlab-quota-'));
process.env.UPLOAD_DIR = TMP;
delete process.env.STORAGE_BACKEND;
delete process.env.STORAGE_QUOTA_GB;
delete process.env.STORAGE_MIN_FREE_GB;

const quota = require(path.join(ROOT, 'src', 'services', 'quota'));
const { uploadDir } = require(path.join(ROOT, 'src', 'services', 'storage'));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

const KB = 1024;
const MB = 1024 * 1024;

// Подмена переменных окружения на время await.
//
// Именно await: quota.js читает настройки при каждом вызове, но
// происходит это уже после того, как синхронная часть check() вернула
// промис. Без await finally откатывал бы переменные слишком рано, и
// проверка уходила бы с запасными значениями по умолчанию — молча,
// без всякой ошибки.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Файл известного размера в папке лаборатории.
function makeFile(labId, name, bytes) {
  const dir = path.join(uploadDir, String(labId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x41));
  return path.join(dir, name);
}

// Гигабайты в байты — так же, как это делает сервис.
const GB = 1024 * MB;

// Квота задаётся в гигабайтах, а проверять границы удобнее в байтах.
// 0,001 ГБ — это мегабайт, а не килобайт: путать эти величины легко,
// поэтому тест сам переводит нужное число байт в формат конфига.
function quotaForBytes(n) {
  return String(n / GB);
}

// --- Подсчёт занятого места ---

(async () => {
  // Лаборатория без папки ещё ничего не загружала: это не ошибка.
  check('у новой лаборатории занято 0 байт', await quota.usedBytes(777) === 0);

  makeFile(1, 'a.stl', 2000);
  makeFile(1, 'b.stl', 3000);
  check('занятое место лаборатории суммируется', await quota.usedBytes(1) === 5000,
    `получено ${await quota.usedBytes(1)}`);

  // Главная ошибка была бы здесь: считать чужие файлы. Разделение по
  // лабораториям держится на имени папки, а не на таблице в базе.
  makeFile(2, 'c.stl', 9000);
  check('файлы другой лаборатории не считаются', await quota.usedBytes(1) === 5000);
  check('у другой лаборатории своё занятое место', await quota.usedBytes(2) === 9000);

  // Файл в подпапке тоже занимает место.
  makeFile(3, 'deep.stl', 1500);
  fs.mkdirSync(path.join(uploadDir, '3', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, '3', 'nested', 'd.stl'), Buffer.alloc(700));
  check('файлы во вложенных папках тоже считаются', await quota.usedBytes(3) === 2200);

  // Ссылки не разворачиваем: иначе файл из другого места (например
  // бэкап) посчитался бы дважды и квота сходила бы не туда.
  const outside = path.join(TMP, 'outside.bin');
  fs.writeFileSync(outside, Buffer.alloc(50 * KB));
  fs.symlinkSync(outside, path.join(uploadDir, '3', 'link.bin'));
  fs.symlinkSync(path.join(uploadDir, '3', 'nested'), path.join(uploadDir, '3', 'linkdir'));
  check('симлинки не учитываются', await quota.usedBytes(3) === 2200,
    `получено ${await quota.usedBytes(3)}`);

  // --- Квота лаборатории ---
  // Границу удобнее задавать прямо в байтах: квота в конфиге в
  // гигабайтах, а файлы в тестах — килобайты.
  const limit = 2000;

  const verdictOk = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(limit) }, () =>
    quota.check({ labId: 4, bytes: 0 }));
  check('пустая загрузка проходит при любой квоте', verdictOk.ok === true);

  const verdictFree = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(limit) }, () =>
    quota.check({ labId: 4, bytes: limit }));
  check('загрузка ровно в квоту проходит', verdictFree.ok === true);

  const verdictOver = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(limit) }, () =>
    quota.check({ labId: 4, bytes: limit + 1 }));
  check('загрузка сверх квоты отклоняется', verdictOver.ok === false);
  check('причина отказа — квота', verdictOver.code === 'quota', verdictOver.code);
  check('сообщение объясняет, что делать',
    typeof verdictOver.message === 'string'
    && verdictOver.message.includes('занято')
    && verdictOver.message.includes('место'));

  // Квота считается по лаборатории, а не по всему хранилищу: в папке
  // уже лежит 22 КБ чужих файлов, но это не мешает другой лаборатории.
  const verdictForeign = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(limit) }, () =>
    quota.check({ labId: 5, bytes: limit }));
  check('квота другой лаборатории не расходуется', verdictForeign.ok === true);

  // Квота ровно под занятое место (2200 байт в папке 3): ещё байт не
  // влезает, а ровно под квоту — проходит. Граница с обеих сторон.
  const verdictBusy = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(2200) }, () =>
    quota.check({ labId: 3, bytes: 1 }));
  check('почти исчерпанная квота отклоняет долибайт', verdictBusy.ok === false
    && verdictBusy.code === 'quota', verdictBusy.code);

  const verdictExact = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(2200) }, () =>
    quota.check({ labId: 3, bytes: 0 }));
  check('занятое место ровно под квоту ещё проходит', verdictExact.ok === true);

  // --- Запас свободного места на диске ---
  // Квоты нет, места на диске тоже почти нет: должен сработать второй
  // ограничитель. Без него лаборатория с пустой квотой заняла бы том.
  const big = 10 * MB;
  const verdictDisk = await withEnv({ STORAGE_MIN_FREE_GB: '2' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + MB }));
  check('мало свободного места отклоняет загрузку', verdictDisk.ok === false);
  check('причина отказа — диск', verdictDisk.code === 'disk', verdictDisk.code);
  check('в сообщении про диск есть запас',
    typeof verdictDisk.message === 'string' && verdictDisk.message.includes('запас'));

  const verdictDiskOk = await withEnv({ STORAGE_MIN_FREE_GB: '2' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + 3 * GB }));
  check('места с запасом хватает', verdictDiskOk.ok === true);

  // Ровно на границе: свободного места ровно на файл и запас.
  const verdictEdge = await withEnv({ STORAGE_MIN_FREE_GB: '2' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + 2 * GB }));
  check('на самой границе запаса ещё пропускаем', verdictEdge.ok === true);

  // Ноль в запасе — это «держать запас не нужно», а не «проверять
  // нечего»: файл, который физически не влезает, отклоняется и так.
  const verdictNoReserve = await withEnv({ STORAGE_MIN_FREE_GB: '0' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big }));
  check('без запаса хватает ровно на файл', verdictNoReserve.ok === true);

  const verdictNoRoom = await withEnv({ STORAGE_MIN_FREE_GB: '0' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big - 1 }));
  check('даже без запаса не влезающий файл отклоняется', verdictNoRoom.ok === false);

  // --- Мусор в конфиге ---
  // Ноль или пустое значение в квоте обнулили бы лимит и запретили бы
  // любую загрузку. Лучше тихо взять запасной вариант.
  const verdictGarbage = await withEnv({ STORAGE_QUOTA_GB: '0' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + 3 * GB }));
  check('нулевая квота не запрещает загрузку', verdictGarbage.ok === true);

  const verdictText = await withEnv({ STORAGE_QUOTA_GB: 'много' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + 3 * GB }));
  check('нечисловая квота не ломает загрузку', verdictText.ok === true);

  const verdictEmpty = await withEnv({ STORAGE_QUOTA_GB: '' }, () =>
    quota.check({ labId: 6, bytes: big, freeBytes: big + 3 * GB }));
  check('пустая квота не ломает загрузку', verdictEmpty.ok === true);

  // --- Показания для интерфейса ---
  const st = await quota.status(3);
  check('статус показывает занятое и лимит', st.used === 2200 && st.limit > 0,
    `used=${st.used} limit=${st.limit}`);
  check('занятый текст без дробей', st.usedText === '2 КБ', st.usedText);
  check('у лаборатории с местом предупреждения нет', st.nearLimit === false);

  const nearSt = await withEnv({ STORAGE_QUOTA_GB: quotaForBytes(2444) }, () => quota.status(3));
  check('при 90% квоты включается предупреждение', nearSt.nearLimit === true,
    `used=${nearSt.used} limit=${nearSt.limit}`);

  // --- Реальное чтение диска ---
  const free = quota.probeFreeBytes();
  check('свободное место на диске читается', typeof free === 'number' && free > 0,
    `${free} байт`);
  check('форматирование мегабайтов', quota.formatGb(150 * MB) === '150,0 МБ',
    quota.formatGb(150 * MB));
  check('форматирование гигабайтов через запятую',
    quota.formatGb(2.5 * GB) === '2,5 ГБ', quota.formatGb(2.5 * GB));
  // Пустое хранилище должно показывать ноль, а не «1 КБ»: иначе
  // сотрудник видит, будто что-то уже загружено.
  check('пустое хранилище показывает 0 КБ', quota.formatGb(0) === '0 КБ',
    quota.formatGb(0));

  // --- Отказ вместо тихого нуля ---
  // Если папку не читать, сервис обязан упасть, а не вернуть 0: нулевое
  // занятое место разрешило бы загрузку в забитый диск. Под root папка
  // читается всегда, поэтому проверка имеет смысл только не под root.
  if (process.getuid && process.getuid() !== 0) {
    const locked = path.join(uploadDir, '8');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'x.stl'), Buffer.alloc(10));
    fs.chmodSync(locked, 0o000);
    let threw = false;
    try {
      await quota.usedBytes(8);
    } catch (e) {
      threw = true;
    }
    fs.chmodSync(locked, 0o755);
    check('нечитаемая папка роняет подсчёт, а не возвращает 0', threw);
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  const failed = results.filter(r => !r.ok);
  console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
  if (failed.length) {
    failed.forEach(f => console.log('  ПРОВАЛЕНО: ' + f.name));
    process.exit(1);
  }
})().catch(e => {
  console.error('\n  Тест упал с ошибкой:', e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});