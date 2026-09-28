'use strict';
// Keeps the app shell available when the connection drops. Data (/api) is never cached, so leads are never stale or stored here.
const VERSION = 'radar-v1';
const SHELL = ['/index.html', '/app.css', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    for (const url of SHELL) {
      try { const r = await fetch(url, { cache: 'reload' }); if (r.ok && !r.redirected) await cache.put(url, r); } catch { /* try again next time */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && !res.redirected && SHELL.includes(url.pathname)) (await caches.open(VERSION)).put(url.pathname, res.clone());
      return res;
    } catch {
      const cached = await caches.match(req.mode === 'navigate' ? '/index.html' : url.pathname);
      return cached || new Response('You are offline. Reconnect and try again.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
