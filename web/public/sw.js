// 서비스워커: 화면이 꺼져 있어도 서버가 보낸 푸시를 알림으로 표시한다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: '화성 알루미늄', body: '새 알림이 있습니다.' };
  try {
    data = { ...data, ...event.data.json() };
  } catch (_) {}
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 앱 화면을 보고 있는 중이면 화면이 직접 알림음을 내므로 OS 알림 팝업은 띄우지 않는다
      if (list.some((c) => c.visibilityState === 'visible')) return;
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.orderId ? 'order-' + data.orderId : undefined,
        vibrate: [200, 100, 200],
        renotify: true,
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    }),
  );
});
