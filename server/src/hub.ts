import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './push';
import type { Env } from './types';

export interface HubEvent {
  type: 'order_created' | 'order_updated' | 'weight_entered' | 'order_completed' | 'order_paid';
  orderId: number;
  company: string;
  message: string;
  /** 이 역할의 접속자에게만 전달 (없으면 전체). 받은 화면은 목록만 조용히 새로 읽는다 */
  roles?: ('admin' | 'staff' | 'workshop')[];
  /**
   * 알림(소리·푸시)을 받을 역할. 없거나 비어 있으면 아무에게도 알리지 않는다.
   * 규칙: 새 작업지시 → 작업장, 작업장의 무게 입력·작업 완료 → 프론트(관리자·직원). 그 밖의 변경은 조용히 반영만.
   */
  alertRoles?: ('admin' | 'staff' | 'workshop')[];
}

/** WebSocket 접속을 모아 두었다가 변경 이벤트를 전파하는 Durable Object */
export class Hub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const event = (await request.json()) as HubEvent;
      const text = JSON.stringify(event);
      for (const ws of this.ctx.getWebSockets()) {
        const role = (this.ctx.getTags(ws)[0] ?? '') as 'admin' | 'staff' | 'workshop';
        if (!event.roles || event.roles.includes(role)) {
          try {
            ws.send(text);
          } catch {
            /* 끊긴 소켓은 무시 */
          }
        }
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const role = url.searchParams.get('role') ?? 'staff';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong');
  }
}

export async function notify(env: Env, event: HubEvent): Promise<void> {
  // 알림은 덤이다. 실시간 알림 서버가 잠깐 끊겨도 이미 저장된 업무(작업 접수, 무게 입력, 납입 등)가 오류로 끝나면 안 된다.
  try {
    const stub = env.HUB.get(env.HUB.idFromName('main'));
    await stub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify(event) });
  } catch (e) {
    console.error('realtime broadcast failed', e);
  }
  // 화면이 꺼져 있는 기기를 위해 Web Push도 함께 보낸다 (알림 대상이 있을 때만, 실패해도 요청은 성공 처리)
  if (!event.alertRoles?.length) return;
  await sendPush(env, event.alertRoles, { title: '화성 알루미늄', body: event.message, orderId: event.orderId }).catch(() => {});
}
