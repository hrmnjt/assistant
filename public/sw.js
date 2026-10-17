// Online-first POC: no caching of authenticated household data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let notice;
  try {
    notice = event.data?.json();
  } catch {
    notice = null;
  }
  event.waitUntil(
    self.registration.showNotification(notice?.title || 'Our day', {
      body: notice?.body || 'There’s an update in your household.',
      tag: notice?.tag || 'household-update',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/?updates=1' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        existing.postMessage({ type: 'open-updates' });
        return existing.focus();
      }
      return self.clients.openWindow('/?updates=1');
    })(),
  );
});
