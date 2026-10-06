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
export function PushCard({ compact = false }: { compact?: boolean }) {
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

  // 한 줄 카드: 작업목록처럼 공간이 아까운 곳에서 쓴다 (제목 · 상태 · 버튼이 한 줄)
  if (compact) {
    const short: Record<string, string> = {
      'need-install': '홈 화면에 추가 후 사용',
      unsupported: '이 브라우저는 미지원',
      denied: '브라우저에서 알림 허용 필요',
      'no-server-key': '서버 설정 필요',
    };
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2">
        <span className="shrink-0 text-sm font-bold">알림 받기</span>
        <span className={`min-w-0 flex-1 truncate text-sm ${state === 'on' ? 'text-emerald-700' : 'text-slate-600'}`}>
          {state === 'on' ? '켜져 있습니다' : state === 'off' ? '화면이 꺼져도 알려 드려요' : short[state]}
        </span>
        {state === 'on' && <Button tone="plain" className="!min-h-9 shrink-0 !px-3 text-sm" onClick={disable}>끄기</Button>}
        {state === 'off' && <Button className="!min-h-9 shrink-0 !px-3 text-sm" onClick={enable}>켜기</Button>}
      </div>
    );
  }

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
