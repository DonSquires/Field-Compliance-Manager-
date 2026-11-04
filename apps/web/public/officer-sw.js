// Network-only: never cache authenticated pages, evidence, API responses or session data.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FCM - offline</title><body><h1>No connection</h1><p>Reconnect before opening Field Compliance Manager. This page does not confirm that any work was saved.</p><button onclick="location.reload()">Try again</button></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )));
});

// New dispatch job notifications (officerJobAlerts.showJobNotification): focus or open the job.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requested = event.notification.data && event.notification.data.url;
  const target = typeof requested === 'string' && requested.startsWith('/officer') ? requested : '/officer';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        return Promise.resolve(client.navigate ? client.navigate(target) : undefined).catch(() => undefined).then(() => client.focus());
      }
    }
    return self.clients.openWindow(target);
  }));
});
