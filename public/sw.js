// Service worker ZT Lab.
//
// Важное правило: авторизованные страницы НЕ кэшируются никогда.
// В приложении видны заказы, имена сотрудников и комментарии клиентов.
// Если закэшировать такую страницу, она переживёт выход из аккаунта
// и следующий сотрудник на том же телефоне увидит чужие данные.
// Поэтому в кэш попадают только статические файлы (иконки, манифест, стили).
const CACHE_NAME = 'ztlab-assets-v1';

const CORE_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Страницы приложения, которые зависят от сессии и данных лаборатории.
const NEVER_CACHE = [
  '/',
  '/login',
  '/register',
  '/titan',
  '/titan/print',
  '/add-user',
  '/logout',
  '/set-user',
  '/register-lab',
  '/upload',
  '/download',
  '/download-image',
  '/image',
  '/delete',
  '/comment',
  '/toggle-milled',
  '/toggle-baked'
];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Только свой сервер: чужие домены не трогаем.
  if (url.origin !== self.location.origin) return;

  // Запросы, изменяющие данные, всегда идут в сеть.
  if (req.method !== 'GET') return;

  // Страницы с данными лаборатории — всегда из сети, без кэша.
  if (NEVER_CACHE.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    return;
  }

  // Кэшируем только статику: иконки, css, js, шрифты.
  const isStatic = /\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname);
  if (!isStatic) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
