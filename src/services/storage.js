// ------ Хранилище файлов ------
// Два режима: локальный диск (по умолчанию) и S3-совместимое облако.
// Переключается переменной окружения STORAGE_BACKEND, код приложения
// при этом не меняется.
//
// Почему нельзя грузить файл целиком в память: STL полной дуги весит
// 50-150 МБ, при загрузке нескольких таких файлов Node упадёт по памяти.
// Поэтому multer всегда пишет во временный файл на диск, а уже потом
// storage.put() переносит его в конечное место.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const BACKEND = process.env.STORAGE_BACKEND || 'local';
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

// Уникальное имя файла на диске, сохраняем расширение оригинала.
function uniqueName(originalName) {
  const safe = path.basename(originalName).replace(/[^\w.\- ]+/g, '_');
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safe}`;
}

// Путь внутри хранилища. Раньше было uploads/<user>/<file>, теперь
// uploads/<labId>/<file> — это и есть разделение по лабораториям.
function keyFor(labId, fileName) {
  return path.join(String(labId), fileName);
}

function localPathFor(key) {
  return path.join(uploadDir, key);
}

// Папка лаборатории. Это то же разделение, что и в keyFor, только без
// имени файла: по ней считается занятое место в квоте.
function labDir(labId) {
  return path.join(uploadDir, String(labId));
}

// Сумма размеров файлов в папке лаборатории.
//
// Считаем по диску, а не по таблице files: в ней нет колонки размера,
// а на диске лежат ещё и «осиротевшие» файлы — загруженные, но без
// записи в базе. Для ограничения диска важно видеть и их.
//
// Ошибку чтения не глотаем: если посчитать не удалось, молчаливый ноль
// разрешил бы загрузить файлы в забитый диск. Лучше отказать в загрузке.
async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      total += (await fsp.stat(full)).size;
    }
    // Симлинки пропускаем: stat по ссылке мог бы уйти за пределы
    // хранилища и посчитать чужой файл дважды.
  }
  return total;
}

// ------ Локальный диск ------
const localBackend = {
  async put(tmpPath, labId, fileName) {
    const dest = localPathFor(keyFor(labId, fileName));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(tmpPath, dest);
    } catch (e) {
      // EXDEV: временная папка и uploads на разных файловых системах
      // (например, tmpfs или отдельный том). Тогда rename невозможен.
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(tmpPath, dest);
      await fsp.unlink(tmpPath);
    }
    return fileName;
  },

  async pathFor(labId, fileName) {
    const p = localPathFor(keyFor(labId, fileName));
    await fsp.access(p, fs.constants.R_OK);
    return p;
  },

  async exists(labId, fileName) {
    try {
      await fsp.access(localPathFor(keyFor(labId, fileName)));
      return true;
    } catch {
      return false;
    }
  },

  async remove(labId, fileName) {
    try {
      await fsp.unlink(localPathFor(keyFor(labId, fileName)));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  },

  async stat(labId, fileName) {
    try {
      return await fsp.stat(localPathFor(keyFor(labId, fileName)));
    } catch {
      return null;
    }
  },

  // Поддерживает докачку (Range) — важно для просмотра больших STL.
  // inline = true показывает файл в браузере (картинки), иначе скачивает.
  async sendFile(res, labId, fileName, downloadName, inline = false) {
    const p = await this.pathFor(labId, fileName);
    if (inline) {
      // sendFile сам подставит Content-Type по расширению и поддержит Range.
      return res.sendFile(p, { headers: { 'Content-Disposition': 'inline' } });
    }
    return res.download(p, downloadName);
  },

  // Поток для пересчёта размера при удалении старых файлов.
  async createReadStream(labId, fileName) {
    return fs.createReadStream(await this.pathFor(labId, fileName));
  },

  // Занятое место лаборатории — для квоты (src/services/quota.js).
  async usage(labId) {
    try {
      return await dirSize(labDir(labId));
    } catch (e) {
      // Нет папки — лаборатория ещё ничего не загружала.
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
  }
};

// ------ S3-совместимое облако (Yandex, Selectel, Timeweb, VK Cloud) ------
// Включается переменными окружения, код приложения не меняется.
let s3Client = null;

function getS3() {
  if (s3Client) return s3Client;
  if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET) {
    throw new Error(
      'STORAGE_BACKEND=s3, но не заданы S3_ENDPOINT и S3_BUCKET. ' +
      'Задай их в .env или верни STORAGE_BACKEND=local.'
    );
  }
  // Пакет подключается лениво, чтобы не тянуть его в обычном режиме.
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: process.env.S3_REGION || 'ru-central1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_KEY_ID,
      secretAccessKey: process.env.S3_KEY_SECRET
    },
    forcePathStyle: true
  });
  return s3Client;
}

const s3Backend = {
  async put(tmpPath, labId, fileName) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { createReadStream } = require('fs');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    await getS3().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: createReadStream(tmpPath)
    }));
    await fsp.unlink(tmpPath);
    return fileName;
  },

  async pathFor() {
    throw new Error('pathFor недоступен для S3: используй sendFile или createReadStream');
  },

  async exists(labId, fileName) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    try {
      await getS3().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  },

  async remove(labId, fileName) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    await getS3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  },

  async stat(labId, fileName) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    try {
      const r = await getS3().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      return { size: r.ContentLength, mtime: r.LastModified };
    } catch {
      return null;
    }
  },

  async sendFile(res, labId, fileName, downloadName, inline = false) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    const r = await getS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    const disposition = inline ? 'inline' : 'attachment';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodeURIComponent(downloadName || fileName)}`
    );
    if (r.ContentLength !== undefined) {
      res.setHeader('Content-Length', r.ContentLength);
    }
    res.setHeader('Content-Type', r.ContentType || 'application/octet-stream');
    r.Body.pipe(res);
  },

  async createReadStream(labId, fileName) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    const r = await getS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return r.Body;
  },

  // Занятое место считаем листингом по префиксу лаборатории. Страницы
  // перебираем циклом: у бакета может быть больше 1000 объектов, и
  // сумма только первой страницы занизила бы занятое место.
  async usage(labId) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prefix = `${String(labId)}/`;
    let bytes = 0;
    let token;
    do {
      const r = await getS3().send(new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: token
      }));
      for (const o of r.Contents || []) bytes += o.Size || 0;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return bytes;
  }
};

const storage = BACKEND === 's3' ? s3Backend : localBackend;

module.exports = { storage, uniqueName, BACKEND, uploadDir, localBackend, s3Backend };
