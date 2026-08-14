/* WRI Staff Check-In — service worker.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ BUMP CACHE_VERSION IN EVERY COMMIT THAT CHANGES A PRECACHED     │
 * │ FILE. Runtime fetches are network-first, so a forgotten bump    │
 * │ only means OFFLINE users keep the previous build. No            │
 * │ skipWaiting(): new versions activate when all tabs close.      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Same rules as wri-respond's sw.js: precache the shell; same-origin GETs
 * network-first with cache fallback; the SW NEVER touches cross-origin
 * requests (the GAS API stays live-only — no session-bearing response can
 * enter Cache Storage). Cache prefix + sync tag are NAMESPACED because
 * whitewaterrescue.github.io is one origin shared with wri-respond.
 */
var CACHE_VERSION = '2026-08-14-1';
var CACHE_NAME = 'wri-checkin-' + CACHE_VERSION;

importScripts('js/config.js', 'js/outbox.js');

var PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/api.js',
  './js/session.js',
  './js/outbox.js',
  './js/screens.js',
  './js/app.js',
  './assets/wri-logo.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (c) { return c.addAll(PRECACHE); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (n) { return n.indexOf('wri-checkin-') === 0 && n !== CACHE_NAME; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function networkFirst(request) {
  var timeout = new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error('sw-timeout')); }, 8000);
  });
  return Promise.race([fetch(request), timeout])
    .then(function (resp) {
      if (resp && resp.ok) {
        var clone = resp.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(request, clone); }).catch(function () {});
      }
      return resp;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // GAS API untouched
  event.respondWith(networkFirst(request));
});

self.addEventListener('sync', function (event) {
  if (event.tag === 'wri-checkin-outbox') {
    event.waitUntil(Outbox.drain({ source: 'sync' }));
  }
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'drain') {
    Outbox.drain({ source: 'message' });
  }
});
