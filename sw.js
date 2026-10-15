// Jelly Critters offline helper: lets the game open with no internet.
// Made By Cat At War: offline helper for Jelly Critters.
// The game page is fetched fresh whenever you're online (so updates arrive right away)
// and falls back to the saved copy when you're offline.
const V = 'jelly-critters-v4';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  // Firebase sign-in and database traffic always goes straight to the network.
  if (u.hostname.endsWith('firebaseio.com') || u.hostname.endsWith('firebasedatabase.app') || u.hostname.endsWith('firebaseapp.com') ||
      (u.hostname.endsWith('googleapis.com') && u.hostname !== 'fonts.googleapis.com')) return;

  const sdk = u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/');
  const font = u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
  if (sdk || font) {
    // Versioned files never change: serve the saved copy, fetch once.
    e.respondWith(caches.open(V).then(async c => {
      const hit = await c.match(r);
      if (hit) return hit;
      const res = await fetch(r);
      if (res.ok || res.type === 'opaque') c.put(r, res.clone());
      return res;
    }));
    return;
  }

  if (u.origin === location.origin) {
    // Network first, saved copy when offline.
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const cl = res.clone(); caches.open(V).then(c => c.put(r, cl)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then(h => h || caches.match('./index.html'))));
  }
});

// ---- notifications
// Pushes from the notification server (when the game is closed) and notes from an open but hidden game tab.
const ICON = './icon-192.png';
function show(d) {
  d = d || {};
  return self.registration.showNotification(String(d.title || 'Jelly Critters').slice(0, 80), {
    body: String(d.body || 'Something new is waiting for you.').slice(0, 200),
    icon: ICON, badge: ICON, tag: String(d.tag || 'jelly'), renotify: true,
    data: { url: d.url || './', kind: d.kind || '' }
  });
}
self.addEventListener('push', e => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(show(d));
});
self.addEventListener('message', e => {
  const d = e.data;
  if (d && d.type === 'notify') e.waitUntil(show(d));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});
self.addEventListener('pushsubscriptionchange', e => {
  // the browser rotated the subscription: the game re-subscribes and saves it the next time it opens
});
