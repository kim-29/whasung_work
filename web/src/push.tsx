import { useEffect, useState } from 'react';
import { api } from './api';
import { Button, Card, useToast } from './ui';

const b64uToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

async function registration() {
  return navigator.serviceWorker.register('sw.js');
}

/** 화면이 꺼져 있어도 알림을 받는 푸시 켜기/끄기. iPhone은 홈 화면에 추가한 앱에서만 가능하다. */
export function PushCard() {
  const toast = useToast();
  const [state, setState] = useState<'checking' | 'unsupported' | 'need-install' | 'off' | 'on' | 'denied' | 'no-server-key'>('checking');

  useEffect(() => {
    (async () => {
      if (isIOS && !isStandalone) return setState('need-install');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
      if (Notification.permission === 'denied') return setState('denied');
      const sub = await (await registration()).pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })().catch(() => setState('unsupported'));
  }, []);

  const enable = async () => {
    try {
      const { key } = await api<{ key: string | null }>('/push/key');
      if (!key) return setState('no-server-key');
      if ((await Notification.requestPermission()) !== 'granted') return setState('denied');
      const reg = await registration();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      await api('/push/subscribe', { body: sub.toJSON() });
      setState('on');
      toast('알림을 켰습니다. 화면이 꺼져 있어도 알려 드립니다.');
    } catch (e) {
      toast((e as Error).message || '알림을 켜지 못했습니다.', 'error');
    }
  };

  const disable = async () => {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      await api('/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    setState('off');
  };

  const msg: Record<string, string> = {
    'need-install': '아이폰은 먼저 이 화면을 홈 화면에 추가해야 알림을 받을 수 있습니다. 사파리 아래의 공유 버튼 → "홈 화면에 추가"를 누른 뒤, 홈 화면의 앱 아이콘으로 다시 열어 주세요.',
    unsupported: '이 기기(브라우저)는 알림을 지원하지 않습니다. 화면을 켜 둔 동안에만 알려 드립니다.',
    denied: '알림이 차단되어 있습니다. 브라우저 설정에서 이 사이트의 알림을 "허용"으로 바꿔 주세요.',
    'no-server-key': '서버에 알림 설정이 아직 되어 있지 않습니다. 관리자에게 문의해 주세요.',
  };

  if (state === 'checking') return null;
  return (
    <Card className="space-y-2">
      <h2 className="text-base font-bold">알림 받기</h2>
      {state === 'on' ? (
        <>
          <p className="text-base text-emerald-700">이 기기는 알림이 켜져 있습니다.</p>
          <Button tone="plain" onClick={disable}>알림 끄기</Button>
        </>
      ) : state === 'off' ? (
        <>
          <p className="text-sm text-slate-600">새 작업이나 완료 소식을, 화면이 꺼져 있어도 알려 드립니다.</p>
          <Button onClick={enable}>알림 켜기</Button>
        </>
      ) : (
        <p className="text-sm text-slate-700">{msg[state]}</p>
      )}
    </Card>
  );
}
