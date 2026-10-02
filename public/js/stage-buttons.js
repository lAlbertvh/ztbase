// Отметка этапа работы кнопкой вместо выпадающего списка.
//
// Кнопки — потому что список был источником ошибок: выбрать этап
// требовало двух действий, и на втором («а не тот ли?») наряд
// оставался на предыдущем этапе. Теперь нажал кнопку — этап выбран.
//
// Заметка обязательна. Раньше можно было нажать «Записать» с пустым
// полем, и в журнале появлялась строка без следа: спросить, что
// сделано, было нечем, а наряд считался сделанным.

(function () {
  'use strict';

  function setup(form) {
    const buttons = form.querySelectorAll('[data-stage]');
    const note = form.querySelector('[data-stage-note]');
    const submit = form.querySelector('[data-stage-submit]');
    const hint = form.querySelector('[data-stage-hint]');
    if (!buttons.length || !submit) return;

    // Ключ отправляется скрытым полем: <button name="stage"> отправил бы
    // значение только своей кнопки, а выбранный этап задаётся нажатием,
    // и до отправки он ни в одном поле не записан.
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'stage';
    form.appendChild(field);

    function pick(btn) {
      buttons.forEach(function (b) {
        const on = b === btn;
        b.classList.toggle('is-picked', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      field.value = btn.dataset.stage;
      // Заметка фокусируется сразу: без неё переход не запишется, и
      // человек уйдёт со страницы, не заметив подсказки.
      if (note) note.focus();
      submit.disabled = false;
      if (hint) hint.hidden = true;
    }

    form.addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-stage]');
      if (!btn || btn.classList.contains('is-current')) return;
      ev.preventDefault();
      pick(btn);
    });

    // Enter в поле заметки отправляет форму — кнопка может быть не в
    // зоне видимости на телефоне.
    if (note) {
      note.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !submit.disabled) submit.click();
      });
    }

    // Пустая заметка не отправляется: сервер принимает пустую, и в
    // журнале появилась бы строка без содержания.
    form.addEventListener('submit', function (ev) {
      if (!field.value) return; // сервер ответит «Неизвестный этап»
      if (note && !note.value.trim()) {
        ev.preventDefault();
        note.focus();
        if (hint) hint.hidden = false;
      }
    });
  }

  function init() {
    document.querySelectorAll('[data-stage-form]').forEach(setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();