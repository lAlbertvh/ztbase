// Подстановка контактов в страницы лендинга.
//
// Проверка закрывает реальную ошибку, из-за которой правка телефона
// не доходила до сайта: контакты существовали в двух независимых
// копиях — вписанными в разметку и в site.json. Админка сообщала, что
// значения подставляются на сайт, а не подставлялись: человек правил
// телефон и не видел изменений.
//
// Здесь проверяется именно подстановка: метки заменяются, незакрытая
// метка не уходит на сайт, незаполненное поле заметно, а значение
// экранируется — телефон вставляется в атрибуты href, и строка вида
// "><script> не должна стать разметкой.
//
// Запуск:  node test/landing-unit.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landing = require(path.join(ROOT, 'src', 'services', 'landing-render'));

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'СБОЙ'} ${name}${extra ? ' — ' + extra : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ztlab-landing-'));

function contactsOf(overrides = {}) {
  return {
    phone: '+7 923 483-65-94',
    email: 'alik_alikovich@mail.ru',
    messengers: 'Telegram, WhatsApp',
    address: 'Москва',
    workHours: 'Пн–Пт, 9:00–19:00',
    ...overrides,
  };
}

(async () => {
  // --- Чтение site.json ---
  const { contacts, missing } = landing.readContacts(JSON.stringify({
    contacts: contactsOf(),
  }));
  check('телефон прочитан', contacts.phone === '+7 923 483-65-94', contacts.phone);
  check('почта прочитана', contacts.email === 'alik_alikovich@mail.ru');
  check('заполненных полей — все', missing.length === 0, missing.join(',') || 'нет');

  const partial = landing.readContacts(JSON.stringify({
    contacts: contactsOf({ address: '', phone: '   ' }),
  }));
  check('пустое поле попало в missing', partial.missing.includes('address')
    && partial.missing.includes('phone'), partial.missing.join(','));
  check('пустое поле заменено на заметный текст',
    partial.contacts.address === landing.FALLBACK.address, partial.contacts.address);
  check('пробелы считаются пустым значением',
    !partial.contacts.phone.includes('не задан') === false);

  const noContacts = landing.readContacts(JSON.stringify({}));
  check('отсутствующий раздел contacts не роняет чтение',
    noContacts.missing.length === landing.CONTACTS.length);
  check('битый JSON роняет чтение с понятной ошибкой', (() => {
    try {
      landing.readContacts('{ это не json');
      return false;
    } catch (e) {
      return /не разобрался/.test(e.message);
    }
  })());

  // --- Подстановка ---
  const out = landing.render(
    '<a href="tel:{{phoneHref}}">{{phone}}</a><a href="{{emailHref}}">{{email}}</a>',
    contactsOf()
  );
  check('текст телефона подставлен', out.includes('+7 923 483-65-94'));
  check('href телефона без пробелов', out.includes('href="tel:+79234836594"'),
    (out.match(/href="[^"]*"/) || [''])[0]);
  check('href почты собран', out.includes('href="mailto:alik_alikovich@mail.ru"'));
  check('сырых меток не осталось', !out.includes('{{'), out.match(/\{\{[^}]*\}\}/g) || '');

  const long = landing.render('<p>{{contacts.phone}}</p>', contactsOf());
  check('длинная форма метки поддержана', long.includes('+7 923 483-65-94'));

  // --- Экранирование ---
  const xss = landing.render('<p>{{phone}}</p>', contactsOf({ phone: '"><script>alert(1)</script>' }));
  check('кавычка экранирована', !xss.includes('"><script>'));
  check('тег экранирован', xss.includes('&lt;script&gt;'), xss.trim());
  check('экранирование не ломает атрибут href',
    !landing.render('<a href="{{phoneHref}}">x</a>',
      contactsOf({ phone: '" onclick="alert(1)' })).includes('onclick="alert'));

  // --- Реальные файлы проекта ---
  const landingHtml = path.join(ROOT, 'deploy', 'landing', 'index.html');
  if (fs.existsSync(landingHtml)) {
    const rendered = landing.renderFile(landingHtml, contactsOf());
    check('в index.html нет незакрытых меток', !rendered.includes('{{'),
      rendered.match(/\{\{[^}]*\}\}/g) || '');
    check('в index.html телефон из contacts, а не вписанный',
      rendered.includes('href="tel:+79234836594"'));
  } else {
    check('index.html найден', false, 'нет файла');
  }

  // Правовые документы отдаются приложением и лендингом из одних и тех
  // же файлов, поэтому незакрытая метка в них видна посетителю.
  for (const file of ['offer.html', 'privacy.html']) {
    const p = path.join(ROOT, 'deploy', 'landing', 'legal', file);
    if (!fs.existsSync(p)) {
      check(`${file} найден`, false);
      continue;
    }
    const rendered = landing.renderFile(p, contactsOf());
    check(`в ${file} нет меток`, !rendered.includes('{{'),
      rendered.match(/\{\{[^}]*\}\}/g) || '');
    check(`в ${file} телефон подставлен`, rendered.includes('+7 923 483-65-94'));
  }

  // Ссылки внутри документов. Проверка важна по конкретной причине:
  // оферта отдаётся и приложением (/legal/offer), и лендингом
  // (/offer.html), поэтому ссылка должна быть абсолютной — и адрес
  // должен открываться в обоих контекстах. Ссылка текстом без href
  // тоже ломает смысл: документ отсылает к другому, а перейти нельзя.
  const offerPath = path.join(ROOT, 'deploy', 'landing', 'legal', 'offer.html');
  if (fs.existsSync(offerPath)) {
    const offer = landing.renderFile(offerPath, contactsOf());
    const refs = [...offer.matchAll(/(политик[а-я]*\s+конфиденциальности)/gi)]
      .map(m => m[0]);
    const links = [...offer.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
      .map(m => ({ href: m[1], text: m[2] }));

    check('политика упомянута в оферте', refs.length > 0, `упоминаний: ${refs.length}`);
    const refLinked = links.filter(l => /конфиденциальност/i.test(l.text));
    check('каждое упоминание политики — ссылка',
      refs.length > 0 && refLinked.length === refs.length,
      `упоминаний ${refs.length}, ссылок ${refLinked.length}`);
    check('ссылка на политику абсолютная',
      refLinked.every(l => l.href.startsWith('/')),
      refLinked.map(l => l.href).join(', '));
    check('ссылка ведёт на существующий документ',
      refLinked.every(l => /^\/(legal\/)?privacy\.html$/.test(l.href)),
      refLinked.map(l => l.href).join(', '));

    // Относительная ссылка не выжила бы в приложении: на /legal/offer
    // она превратилась бы в /legal/privacy.html, которого нет.
    check('нет относительных ссылок на документы',
      !links.some(l => /^(privacy|offer)\.html$/.test(l.href)));
  }

  // Алиасы в приложении обязаны совпадать с адресами лендинга, иначе
  // ссылка из документа уведёт на 404 или на /login.
  const authSrc = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'auth.js'), 'utf8');
  const legalSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'legal.js'), 'utf8');
  for (const doc of ['privacy.html', 'offer.html']) {
    check(`${doc} публичен без сессии`, authSrc.includes(`'/${doc}'`));
    check(`${doc} отдаётся приложением`, legalSrc.includes(`'/${doc}'`));
  }

  // --- Настоящий site.json проекта ---
  const sitePath = path.join(ROOT, 'content', 'site.json');
  if (fs.existsSync(sitePath)) {
    const real = landing.readContacts(fs.readFileSync(sitePath, 'utf8'));
    check('в site.json проекта телефон заполнен', !real.missing.includes('phone'),
      real.contacts.phone);
    check('в site.json проекта нет заглушек вида «Ваш город»',
      !/ваш город|здесь будет|xxx/i.test(fs.readFileSync(sitePath, 'utf8')));
  } else {
    check('site.json проекта найден', false);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n  Итог: успешно ${results.length - failed.length} из ${results.length}`);
  if (failed.length) {
    failed.forEach(f => console.log('  ПРОВАЛЕНО: ' + f.name));
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => {
  console.error('\n  Тест упал с ошибкой:', e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
