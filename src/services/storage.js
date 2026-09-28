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

// ------ Локальный диск ------
const localBackend = {
  async put(tmpPath, labId, fileName) {
    const dest = localPathFor(keyFor(labId, fileName));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(tmpPath, dest);
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
  async sendFile(res, labId, fileName, downloadName) {
    res.download(await this.pathFor(labId, fileName), downloadName);
  },

  // Поток для пересчёта размера при удалении старых файлов.
  async createReadStream(labId, fileName) {
    return fs.createReadStream(await this.pathFor(labId, fileName));
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

  async sendFile(res, labId, fileName, downloadName) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    const r = await getS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    if (downloadName) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );
    }
    res.setHeader('Content-Length', r.ContentLength);
    res.setHeader('Content-Type', r.ContentType || 'application/octet-stream');
    r.Body.pipe(res);
  },

  async createReadStream(labId, fileName) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = keyFor(labId, fileName).split(path.sep).join('/');
    const r = await getS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return r.Body;
  }
};

const storage = BACKEND === 's3' ? s3Backend : localBackend;

module.exports = { storage, uniqueName, BACKEND, uploadDir, localBackend, s3Backend };
