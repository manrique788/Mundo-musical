const CACHE_NAME = 'mundo-musical-app-v6';
const AUDIO_CACHE = 'mundo-musical-audio-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=19',
  './app.js?v=27',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isAudio = /\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(url.pathname);
  if (isAudio) {
    event.respondWith(caches.open(AUDIO_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      // Só guarda respostas completas. Respostas 206 parciais não podem ser
      // reutilizadas como uma faixa inteira pelo elemento <audio>.
      if (response.ok && response.status === 200) {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > 3) await cache.delete(keys[0]);
      }
      return response;
    }).catch(() => fetch(request)));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match('./index.html'))));
});
