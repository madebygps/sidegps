// SideGPS Service Worker
var CACHE_VERSION = 'sidegps-v1';
var APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
];

var API_CACHE = 'sidegps-api-v1';

// Install: cache app shell
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) {
          return k !== CACHE_VERSION && k !== API_CACHE;
        }).map(function (k) {
          return caches.delete(k);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Fetch: network-first for API, cache-first for app shell
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // API calls: network first, fall back to cache
  if (url.pathname.indexOf('/api/') === 0) {
    e.respondWith(
      fetch(e.request).then(function (response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(API_CACHE).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(e.request);
      })
    );
    return;
  }

  // App shell: cache first, fall back to network
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (response) {
        if (response.ok && url.origin === self.location.origin) {
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      });
    })
  );
});
