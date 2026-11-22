/* 홈 화면 앱(PWA)용 서비스 워커
 * - 화면(HTML)은 항상 서버에서 새로 받고, 인터넷이 안 될 때만 저장해 둔 화면을 씁니다.
 * - 아이콘 같은 정적 파일은 저장해 두고 씁니다.
 * - /api/, /auth/ 요청(로그인·데이터)은 건드리지 않습니다.
 * - 관리자 푸시 알림을 받아서 보여 주고, 누르면 해당 화면을 엽니다.
 */
const CACHE = 'shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && url.pathname === '/') { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '예배팀 스케줄', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    const w = wins.find(x => new URL(x.url).origin === self.location.origin);
    if (w) return w.focus().then(f => (f || w).navigate(url)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
