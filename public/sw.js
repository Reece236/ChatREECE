/* Service worker: notifications only. Nothing is cached here — the app is
 * small enough that a cache layer would add more staleness bugs than it saves
 * bytes, and a stale chat is worse than a slow one. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'New message';
  const options = {
    body: payload.body || '',
    // Same tag means a second notification replaces the first rather than
    // stacking, so a burst of replies does not bury the phone.
    tag: payload.tag || 'chat',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/chat' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/chat';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse a tab that is already on this site instead of piling up new ones.
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin) {
          return client.focus().then((c) => (c && c.navigate ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
