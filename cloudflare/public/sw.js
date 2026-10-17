self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data?.title || 'Cloudflare reminder test', {
      body: data?.body || 'Your test reminder is ready.',
      tag: data?.tag || 'prototype-reminder',
      icon: '/icon.svg',
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
