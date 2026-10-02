// Зубная формула: выбор зубов кликом.
//
// Форма и ряд — две стороны одного значения. Ряд удобен, но иногда
// номера переносят с бумажного бланка, и вводить их вручную быстрее,
// чем кликать по 32 кнопкам. Поэтому поле остаётся, и оба элемента
// синхронизированы в обе стороны.
//
// Хранение выбранных зубов — в скрытом поле teeth: его единственный
// получатель сервер. Видимое поле — просто представление, и на отправку
// не идёт, иначе сервер получил бы два разных значения из одной формы.
//
// Файл подключается один раз через defer и инициализирует все формулы
// на странице: нарядов с формулой может быть не один.

(function () {
  'use strict';

  // Порядок записи в поле. Не порядок нажатия: если выбрать 16, потом
  // 15, в наряде должно быть «15 16» — так читает врач. Порядок по
  // стоматологической формуле, сверху слева направо.
  const ORDER = [
    18, 17, 16, 15, 14, 13, 12, 11,
    21, 22, 23, 24, 25, 26, 27, 28,
    38, 37, 36, 35, 34, 33, 32, 31,
    41, 42, 43, 44, 45, 46, 47, 48,
  ];

  function parse(raw) {
    return String(raw || '')
      .split(/[^0-9]+/)
      .map(Number)
      .filter(function (n) { return Number.isInteger(n) && n >= 11 && n <= 48; });
  }

  function sorted(list) {
    const set = new Set(list);
    return ORDER.filter(function (n) { return set.has(n); });
  }

  function setup(chart) {
    const hidden = document.getElementById(chart.dataset.field || 'teeth');
    const input = chart.parentElement.querySelector('[data-teeth-input]');
    if (!hidden) return;

    function selected() {
      return Array.prototype.slice
        .call(chart.querySelectorAll('.tooth.is-on'))
        .map(function (b) { return Number(b.dataset.tooth); });
    }

    function render() {
      const list = sorted(selected());
      const text = list.join(' ');

      // Видимое поле — только представление, сервер его не читает.
      // readonly вместо hidden, иначе при ошибке не видно, что выбрано.
      if (input) input.value = text;
      hidden.value = text;

      chart.querySelectorAll('.tooth').forEach(function (b) {
        const on = b.classList.contains('is-on');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function set(list) {
      const set = new Set(list);
      chart.querySelectorAll('.tooth').forEach(function (b) {
        b.classList.toggle('is-on', set.has(Number(b.dataset.tooth)));
      });
      render();
    }

    chart.addEventListener('click', function (ev) {
      const tooth = ev.target.closest('.tooth');
      if (tooth) {
        tooth.classList.toggle('is-on');
        render();
        return;
      }
      if (ev.target.closest('[data-teeth-all]')) {
        // «Все зубы» выбирает весь ряд. Нужен редко, но при полной
        // конструкции кликать 32 раза невозможно.
        set(ORDER.slice());
        return;
      }
      if (ev.target.closest('[data-teeth-clear]')) {
        set([]);
      }
    });

    // Ввод в поле двигает ряд. Так можно и выбрать, и снять зуб,
    // не заходя мышкой, — при работе планшетом или с телефона.
    if (input) {
      input.addEventListener('input', function () { set(parse(input.value)); });
      // Правка значения из кода обязана дойти до скрытого поля.
      input.addEventListener('change', function () { set(parse(input.value)); });
    }

    render();
  }

  function init() {
    document.querySelectorAll('.teeth-chart').forEach(setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();