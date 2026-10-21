// Retired service worker. The site no longer works offline; this file stays
// at /sw.js so browsers that installed the old caching worker pick up this
// one on their next update check, which deletes every cache and unregisters
// itself. No fetch handler, so requests go straight to the network, and no
// forced reload, so a page mid-playback isn't interrupted.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.registration.unregister();
  })());
});
