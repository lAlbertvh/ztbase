#!/usr/bin/env node
// Подстановка контактов в страницы лендинга перед выкладкой.
//
// Запуск:
//   node deploy/landing/render.js <site.json> <вход.html> <выход.html>
//
// site.json берётся с VPS (каталог данных /var/lib/ztlab/content) —
// это тот файл, который правится через /admin/content приложения. Если
// брать его из репозитория, правка телефона в админке снова перестала бы
// влиять на сайт: это был бы третий источник.
//
// Выходной файл собирается во временном каталоге: в репозитории
// лежат шаблоны с метками {{phone}}, а готовые страницы с номерами
// не должны попадать в историю.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readContacts, render } = require('../../src/services/landing-render');

const [sitePath, inputPath, outputPath] = process.argv.slice(2);

if (!sitePath || !inputPath || !outputPath) {
  console.error('Использование: node deploy/landing/render.js <site.json> <вход.html> <выход.html>');
  process.exit(1);
}

let contacts;
let missing = [];
try {
  const { contacts: c, missing: m } = readContacts(fs.readFileSync(sitePath, 'utf8'));
  contacts = c;
  missing = m;
} catch (err) {
  console.error(`ОШИБКА: ${err.message}`);
  process.exit(1);
}

const html = render(fs.readFileSync(inputPath, 'utf8'), contacts);

if (html.includes('{{')) {
  // Незакрытая метка: значит, в разметке опечатка и на сайте останется
  // «{{phone}}» буквально. Молча выкладывать такое нельзя.
  // Шаблон не латиница: метку могли назвать по-русски, и обычная
  // регулярка на буквы латиницы такое пропустила бы.
  const left = [...new Set((html.match(/\{\{[^}]*\}\}/g) || []))];
  console.error(`ОШИБКА: в разметке остались метки: ${left.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html, 'utf8');

console.log(`  ${path.basename(outputPath)} — готово`);
if (missing.length) {
  console.log(`  ВНИМАНИЕ: в site.json не заполнено — ${missing.join(', ')}`);
  console.log('  На сайте появится «не задан». Заполните через /admin/content.');
}
