// Справочники и конструкции заказ-наряда.
//
// Значения хранятся в коде, а не в таблице, потому что набор задан
// технологией: зубная формула по FDI, стандартные виды работ и этапы
// производства не меняются от заказа к заказу. Это позволяет печатать
// бланк и валидировать форму без обращения к БД.

// Зубная формула FDI: квадрант + номер. 18-11 верхняя справа,
// 21-28 верхняя левая, 31-38 нижняя левая, 41-48 нижняя справа.
const QUADRANTS = [
  { key: '1', title: 'Верхняя правая (1x)', teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { key: '2', title: 'Верхняя левая (2x)', teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { key: '3', title: 'Нижняя левая (3x)', teeth: [31, 32, 33, 34, 35, 36, 37, 38] },
  { key: '4', title: 'Нижняя правая (4x)', teeth: [41, 42, 43, 44, 45, 46, 47, 48] },
];

// Основные виды работ. kind — короткий код, попадает в печатный бланк
// и в подсчёт статистики по лаборатории.
const WORK_KINDS = [
  { kind: 'crown',        title: 'Коронка' },
  { kind: 'bridge',       title: 'Мост' },
  { kind: 'removable',    title: 'Съёмная конструкция' },
  { kind: 'fixed',        title: 'Несъёмная конструкция' },
  { kind: 'implant',      title: 'Конструкция на имплантах' },
  { kind: 'abutment',     title: 'Абатмент' },
  { kind: 'model_gypsum', title: 'Гипсовая модель' },
  { kind: 'model_print',  title: 'Печатная модель' },
  { kind: 'screw',        title: 'Винт' },
  { kind: 'titan_base',   title: 'Титановое основание' },
  { kind: 'other',        title: 'Прочее' },
];

// Этапы производства. Именно они задают путь заказа от приёма до выдачи,
// поэтому вынесены отдельно: изменение порядка этапов не должно
// требовать правок в логике приложения.
const STAGES = [
  { key: 'new',         title: 'Новый',            short: 'Новый' },
  { key: 'taken',       title: 'Взято в работу',   short: 'В работе' },
  { key: 'review',      title: 'Проверка врачом',  short: 'Проверка' },
  { key: 'milled',      title: 'Фрезерование',     short: 'Фрезеровка' },
  { key: 'baked',       title: 'Спекание',         short: 'Спекание' },
  { key: 'finished',    title: 'Готово',           short: 'Готово' },
  { key: 'issued',      title: 'Выдано',           short: 'Выдано' },
  { key: 'cancelled',   title: 'Отменено',         short: 'Отменено' },
];

// Обработка индивидуального абатмента и общие флаги работ.
// Взяты из бланка заказ-наряда фрезерного центра: такие пометки
// техник проставляет постоянно, и в бумажном виде они идут отдельной
// строкой печати.
//
// Список отдаётся приложению по умолчанию и копируется в lab_options
// при первом запуске: дальше администратор правит его сам в
// /admin/options. Правьте там, а не здесь.
const ABUTMENT_OPTIONS = [
  { key: 'final',    title: 'Финальная обработка' },
  { key: 'shoulder05', title: 'Погружение уступа 0,5 мм' },
  { key: 'shoulder10', title: 'Погружение уступа 1,0 мм' },
];

const FRAME_FLAGS = [
  { key: 'repeat',      title: 'Повторение' },
  { key: 'antagonist',  title: 'Антагонист' },
  { key: 'processing',  title: 'Обработка' },
  { key: 'reduce',      title: 'Редуцировать под каркас' },
  { key: 'try_in',      title: 'Припасовка' },
  { key: 'glaze',       title: 'Нанесение глазури' },
  { key: 'consultation', title: 'Желательна консультация' },
  { key: 'approval',    title: 'Согласование работы' },
];

// Что поступило вместе с заказом: слепок, модель, ключ переноса и т.д.
const INCOMING_OPTIONS = [
  { key: 'impression',  title: 'Слепок' },
  { key: 'model',       title: 'Модель' },
  { key: 'tray',        title: 'Регистратор' },
  { key: 'transfer_key', title: 'Ключ переноса' },
  { key: 'wax_model',   title: 'Восковая модель' },
  { key: 'articulator',  title: 'Артикулятор' },
  { key: 'gingiva',     title: 'Искусственная десна' },
  { key: 'transfer',    title: 'Трансфер' },
  { key: 'matrix',      title: 'Матрицы' },
  { key: 'titan_base',  title: 'Титановое основание' },
  { key: 'analog',      title: 'Аналоги' },
  { key: 'clinic_screw', title: 'Винт клинический' },
  { key: 'lab_screw',   title: 'Винт лабораторный' },
  { key: 'ct_scan',     title: 'Диск КТ' },
];

// Форма отдачи: что именно требуется изготовить из полученной модели.
const DELIVERY_OPTIONS = [
  { key: 'plaster',    title: 'Гипсовая модель' },
  { key: 'printed',    title: 'Печатная модель' },
  { key: 'working',    title: 'Рабочая модель' },
  { key: 'splint',     title: 'Съёмный шаблон' },
];

const COLOR_SYSTEMS = ['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4', 'D2', 'D4', 'BL1', 'BL2', 'BL3', 'BL4'];

// Приватные адреса: пользователь набирает минимум символов,
// адрес скрывается до конца.
const toTitle = (arr) => Object.fromEntries(arr.map(o => [o.key, o.title]));
const toShort = (arr) => Object.fromEntries(arr.map(o => [o.key, o.short]));

module.exports = {
  QUADRANTS,
  WORK_KINDS,
  STAGES,
  ABUTMENT_OPTIONS,
  FRAME_FLAGS,
  INCOMING_OPTIONS,
  DELIVERY_OPTIONS,
  COLOR_SYSTEMS,
  WORK_TITLE: toTitle(WORK_KINDS),
  STAGE_TITLE: toTitle(STAGES),
  STAGE_SHORT: toShort(STAGES),
  ABUTMENT_TITLE: toTitle(ABUTMENT_OPTIONS),
  FRAME_FLAG_TITLE: toTitle(FRAME_FLAGS),
  INCOMING_TITLE: toTitle(INCOMING_OPTIONS),
  DELIVERY_TITLE: toTitle(DELIVERY_OPTIONS),
};
