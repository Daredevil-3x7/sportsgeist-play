/* Sportsgeist service worker — wave 3b · Track X2 (P10.26 installation, P8.31 web push).
 *
 * Shell only. Cached: the page itself (index.html, network-first, the copy is the offline start) and the hashed build
 * files (/_expo/static/*, /assets/* — cache-first: a new build has new names). Never cached or touched: Supabase and
 * every other origin (all game data, RPCs, auth), /api/* and /og/* (link previews), non-GET requests. So an installed
 * app that starts offline opens the app's own offline state (the opening's gate), not the browser's error page — and
 * no score, pick or balance is ever served from a cache.
 *
 * Updates: the cache name carries the build id (scripts/postbuild-web.mjs stamps it below), skipWaiting + claim. The
 * opening's update gate stays the authority: it reloads, the network-first navigation brings the new index.html and
 * with it the new bundle; the old cache is dropped when this worker activates.
 *
 * Push (P8.31, inert until the edge function send-push has Pat's VAPID keys): every push shows one notification
 * (iOS revokes a subscription that receives silent pushes), with the badge-96 glyph; a tap focuses an open app window
 * and routes it there (lib/pwa.ts listens for 'sg-open'), else opens a new one.
 */
const BUILD = 'cfe74aa7dfb9';
const CACHE = 'sg-shell-' + BUILD;
// '' on play.sportsgeist.app, '/sportsgeist-play' on the GitHub Pages build — read from where this worker lives
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const SHELL = BASE + '/index.html';
const CACHE_FIRST = [BASE + '/_expo/static/', BASE + '/assets/'];
const NEVER = [BASE + '/api/', BASE + '/og/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch(SHELL, { cache: 'no-cache' });
      if (res.ok) await (await caches.open(CACHE)).put(SHELL, res);
    } catch {
      // installed while offline: the next navigation fills the shell
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.indexOf('sg-shell-') === 0 && k !== CACHE).map((k) => caches.delete(k)));
    // the page request starts while the worker boots (no extra wait on a cold start)
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

async function navigate(event) {
  const req = event.request;
  try {
    const pre = await Promise.resolve(event.preloadResponse).catch(() => null);
    const res = pre || (await fetch(req));
    if (res.ok && (res.headers.get('content-type') || '').indexOf('text/html') >= 0) {
      // one entry: the app is the same page on every route
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = (await caches.match(SHELL, { cacheName: CACHE })) || (await caches.match(SHELL));
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((p) => url.pathname.indexOf(p) === 0)) return;
  if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  if (CACHE_FIRST.some((p) => url.pathname.indexOf(p) === 0)) event.respondWith(cacheFirst(req));
});

// ───────────── P8.31 · web push ─────────────
/** an in-app path from our own server: '/duel/<id>', '/cup/<id>?x=1' — never another origin or a protocol-relative URL */
function safePath(p) {
  return typeof p === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(p) ? p : '/';
}

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  const tag = typeof d.tag === 'string' && d.tag ? d.tag.slice(0, 64) : undefined;
  const opts = {
    body: typeof d.body === 'string' ? d.body : '',
    icon: BASE + '/icons/icon-192.png',
    badge: BASE + '/icons/badge-96.png',
    data: { url: safePath(d.url) },
    // silent only when the server asks for it (08 §7: the option, never a missing sound by accident)
    silent: d.silent === true,
    timestamp: typeof d.ts === 'number' ? d.ts : Date.now(),
  };
  if (tag) {
    opts.tag = tag;
    // a newer reminder for the same contest replaces the old one and alerts again
    opts.renotify = d.renotify !== false;
  }
  if (typeof d.lang === 'string') opts.lang = d.lang;
  // the one action ('Pick now', 'Open') as a button where the platform shows them (Chrome, Android); it opens the
  // same place as a tap on the notification
  if (typeof d.action === 'string' && d.action) opts.actions = [{ action: 'open', title: d.action.slice(0, 24) }];
  event.waitUntil(self.registration.showNotification(typeof d.title === 'string' && d.title ? d.title : 'Sportsgeist', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      try {
        await w.focus();
      } catch {
        // focus can be refused; the message still routes the window
      }
      w.postMessage({ type: 'sg-open', path });
      return;
    }
    await self.clients.openWindow(BASE + path);
  })());
});

// the browser replaced the subscription (key rotation, expiry): an open app saves the new one (lib/push.ts); a closed
// app does it on its next start, when it compares the browser's subscription with the server's state
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'sg-push-changed' }));
  })());
});
