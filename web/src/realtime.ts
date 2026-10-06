import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { API_BASE, tokenStore } from './api';
import { useAuth } from './auth';
import { playChime } from './sound';
import { useToast } from './ui';

type Role = 'admin' | 'staff' | 'workshop';

/**
 * 실시간 반영: 서버가 보낸 변경 이벤트를 받으면 목록을 새로 읽는다. 끊기면 자동 재연결.
 * 알림(소리)은 이벤트의 alertRoles 에 내 역할이 있을 때만 낸다.
 *  - 프론트(관리자·직원): 작업장의 무게 입력·작업 완료 → 딩동 + 짧은 메시지
 *  - 작업장: 새 작업지시 → 딩동만 (팝업 메시지는 띄우지 않는다)
 */
export function useRealtime() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const role = user?.role as Role | undefined;

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
          const ev = JSON.parse(e.data) as { message: string; alertRoles?: Role[] };
          if (role && ev.alertRoles?.includes(role)) {
            playChime();
            if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
            if (role !== 'workshop') toast(ev.message);
          }
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
  }, [qc, toast, role]);
}
