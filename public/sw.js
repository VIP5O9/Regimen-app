/* REGIMEN service worker — offline shell + push */
const CACHE = 'regimen-v6';
const AUTH_CACHE = 'regimen-auth'; // token store — survives every shell version bump
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== AUTH_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // API is always network
  // The first load arrives as /?token=… — never let that URL become a cache key.
  if (url.searchParams.has('token')) return;
  // network-first: updates always land; cache only as offline fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'REGIMEN', body: 'Check the app.', tag: 'regimen' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
    })
  );
});

/* the browser can rotate a subscription on its own — re-subscribe and re-register
   it, otherwise reminders go silently dead until the user taps Arm again */
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* The API needs a bearer token and a worker can't read localStorage, so the
   page mirrors the token into this cache for us. */
async function authHeaders(extra) {
  try {
    const hit = await caches.open(AUTH_CACHE).then((c) => c.match('/__regimen_token'));
    if (hit) {
      const token = (await hit.text()).trim();
      if (token) return { ...extra, Authorization: 'Bearer ' + token };
    }
  } catch { /* fall through — the request will 401 and be logged */ }
  return extra;
}

self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    authHeaders({})
      .then((headers) =>
        fetch('/api/vapid', { headers })
          .then((r) => r.json())
          .then(({ key }) =>
            self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlB64ToUint8(key),
            })
          )
          .then((sub) =>
            fetch('/api/subscribe', {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(sub.toJSON()),
            })
          )
      )
      .catch((err) => console.error('resubscribe failed', err))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('/');
    })
  );
});
