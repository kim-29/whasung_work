import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { API_BASE, tokenStore } from './api';
import { useToast } from './ui';

/** 실시간 알림: 서버가 보낸 변경 이벤트를 받으면 목록을 새로 읽고 메시지를 띄운다. 끊기면 자동 재연결. */
export function useRealtime() {
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let ping: number | undefined;
    let closed = false;

    const connect = () => {
      const token = tokenStore.get();
      if (!token || closed) return;
      ws = new WebSocket(`${API_BASE.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`);
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        try {
          const ev = JSON.parse(e.data) as { message: string };
          toast(ev.message);
          if ('vibrate' in navigator) navigator.vibrate?.(200);
        } catch {
          /* 무시 */
        }
        qc.invalidateQueries();
      };
      ws.onopen = () => {
        qc.invalidateQueries(); // 끊겨 있던 사이의 변경 반영
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send('ping'), 30000);
      };
      ws.onclose = () => {
        window.clearInterval(ping);
        if (!closed) timer = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      ws?.close();
    };
  }, [qc, toast]);
}
