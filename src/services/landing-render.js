// Подстановка контактов из site.json в страницы лендинга и в правовые
// документы.
//
// Зачем нужен отдельный шаг. Контакты в разметке лендинга были вписаны
// прямо в HTML, а те же данные редактировались через /admin/content в
// content/site.json. Получалось две независимые копии: правка телефона
// в админке меняла файл в каталоге данных, а сайт оставался со старым
// номером. Теперь в разметке стоят метки {{phone}} и {{email}}, и перед
// показом они заменяются значениями.
//
// Два потока используют один и тот же код:
//
//   - сайт: deploy/landing/render.js перед выкладкой на VPS;
//   - приложение: src/routes/legal.js при отдаче /legal/privacy
//     и /legal/offer, потому что эти документы — те же файлы.
//
// Значение подставляется с экранированием HTML: телефон и почта
// приходят от человека, а попадают в атрибуты href и в текст. Без
// экранирования строка вида "><script>… оказалась бы в странице.

const fs = require('fs');

// Поля, которые подставляются. Порядок важен только для отчёта.
const CONTACTS = ['phone', 'email', 'messengers', 'address', 'workHours'];

// Пустое значение на сайте опаснее: получится ссылка tel: без номера.
// Поэтому отсутствующее поле превращается в видимый текст, и вызывающий
// код может об этом сообщить.
const FALLBACK = {
  phone: 'телефон не задан',
  email: 'почта не задана',
  messengers: 'мессенджеры не заданы',
  address: 'адрес не задан',
  workHours: 'часы работы не заданы',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Телефон в атрибут href идёт без пробелов и скобок:
// tel:+7 923 483-65-94 браузер не считает номером.
function telHref(value) {
  return String(value).replace(/[^\d+]/g, '');
}

/** Читает site.json и возвращает { contacts, missing }. */
function readContacts(siteJson) {
  let raw;
  try {
    raw = JSON.parse(siteJson);
  } catch (err) {
    throw new Error(`site.json не разобрался: ${err.message}`);
  }
  const source = raw.contacts || {};
  const contacts = {};
  const missing = [];
  for (const key of CONTACTS) {
    const value = typeof source[key] === 'string' ? source[key].trim() : '';
    if (value) {
      contacts[key] = value;
    } else {
      contacts[key] = FALLBACK[key];
      missing.push(key);
    }
  }
  return { contacts, missing };
}

/**
 * Подставляет контакты в HTML.
 * @param {string} html исходная разметка с метками
 * @param {object} contacts значения полей (уже без пустых)
 * @returns {string} готовая разметка
 */
function render(html, contacts) {
  let out = html;
  for (const key of CONTACTS) {
    const value = contacts[key] !== undefined ? contacts[key] : FALLBACK[key];
    out = out.split(`{{contacts.${key}}}`).join(escapeHtml(value));
    out = out.split(`{{${key}}}`).join(escapeHtml(value));
  }
  if (out.includes('{{phoneHref}}')) {
    out = out.split('{{phoneHref}}').join(escapeHtml(telHref(contacts.phone || '')));
  }
  if (out.includes('{{emailHref}}')) {
    out = out.split('{{emailHref}}').join(escapeHtml(`mailto:${contacts.email || ''}`));
  }
  return out;
}

/** Читает файл, подставляет, возвращает разметку. */
function renderFile(filePath, contacts) {
  return render(fs.readFileSync(filePath, 'utf8'), contacts);
}

module.exports = {
  readContacts,
  render,
  renderFile,
  escapeHtml,
  telHref,
  CONTACTS,
  FALLBACK,
};