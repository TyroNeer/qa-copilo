// Service worker minimal (installabilité PWA). Pas de cache : toujours la dernière version en ligne.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
