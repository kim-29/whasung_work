import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  return SELF.fetch(`https://x${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
};
const post = (path: string, body: unknown, token?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), token });

describe('PIN 로그인 · 주문 흐름', () => {
  it('관리자 PIN → 직원/작업장 PIN 발급 → 절단·제작·납입', async () => {
    // 최초 관리자 로그인
    const a = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string; user: { role: string } }>();
    expect(a.user.role).toBe('admin');

    // 직원·작업장 PIN 발급
    const staff = await (await post('/api/admin/users', { name: '김직원' }, a.token)).json<{ pin: string }>();
    const ws = await (await post('/api/admin/workshop-pin', {}, a.token)).json<{ pin: string }>();
    expect(staff.pin).toMatch(/^\d{6}$/);
    expect(ws.pin).not.toBe(staff.pin);

    const s = await (await post('/api/auth/login', { pin: staff.pin })).json<{ token: string }>();
    const w = await (await post('/api/auth/login', { pin: ws.pin })).json<{ token: string; user: { role: string } }>();
    expect(w.user.role).toBe('workshop');

    // 작업장은 대시보드/관리 접근 불가
    expect((await call('/api/dashboard/unpaid', { token: w.token })).status).toBe(403);
    expect((await call('/api/admin/users', { token: s.token })).status).toBe(403);

    // 바 등록 + 제작 오더(미등록 바 포함)
    await post('/api/bars', { name: 'NS88-A', kg_per_m: 1.5 }, s.token);
    const created = await (
      await post(
        '/api/orders',
        {
          company: '한빛샷시', kind: 'make',
          items: [
            { bar_name: 'NS88-A', length_mm: 2000, qty: 4, color: '화이트' },
            { bar_name: '없는바', length_mm: 1000, qty: 1 },
          ],
        },
        s.token,
      )
    ).json<{ id: number; theory_weight: number; has_unknown_bar: boolean }>();
    expect(created.theory_weight).toBe(12); // 1.5 * 2 * 4
    expect(created.has_unknown_bar).toBe(true);

    // 작업장: 무게 입력 → 제작중 → 제작 완료 → 미납
    const wt = await (await post(`/api/orders/${created.id}/weight`, { weight: 12.4 }, w.token)).json<{ status: string }>();
    expect(wt.status).toBe('making');
    expect((await post(`/api/orders/${created.id}/weight`, { weight: 1 }, w.token)).status).toBe(409);
    await post(`/api/orders/${created.id}/complete`, {}, w.token);

    // 작업장에서는 완료된 오더가 사라진다
    expect((await call(`/api/orders/${created.id}`, { token: w.token })).status).toBe(403);

    const unpaid = await (await call('/api/dashboard/unpaid', { token: s.token })).json<{ id: number }[]>();
    expect(unpaid.map((o) => o.id)).toContain(created.id);

    // 납입
    expect((await post(`/api/orders/${created.id}/pay`, {}, s.token)).status).toBe(200);
    expect((await post(`/api/orders/${created.id}/pay`, {}, s.token)).status).toBe(409);
  });

  it('PIN을 5번 틀리면 잠긴다', async () => {
    // 다른 테스트가 잠기지 않도록 이 테스트만 별도 IP 로 시도한다
    const bad = () =>
      call('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ pin: '000000' }), headers: { 'CF-Connecting-IP': '9.9.9.9' },
      });
    for (let i = 0; i < 5; i++) await bad();
    expect((await bad()).status).toBe(429);
  });

  it('Blender 전송은 API 키가 필요하다', async () => {
    const body = { company: '테스트', kind: 'cut', items: [{ bar_name: 'x', length_mm: 100, qty: 1 }] };
    expect((await post('/api/ingest/blender', body)).status).toBe(401);
    const ok = await call('/api/ingest/blender', {
      method: 'POST', body: JSON.stringify(body), headers: { 'X-API-Key': 'test-key' },
    });
    expect(ok.status).toBe(201);
  });

  it('Blender 도면(HTML)은 KV에 저장되고 서명 링크로만 열린다', async () => {
    const html = '<html><body>도면 테스트</body></html>';
    const body = { company: '도면업체', kind: 'make', items: [{ bar_name: 'x', length_mm: 100, qty: 1 }], drawing_html: html };
    const r = await call('/api/ingest/blender', {
      method: 'POST', body: JSON.stringify(body), headers: { 'X-API-Key': 'test-key' },
    });
    const { id } = await r.json<{ id: number }>();

    // 작업장 PIN으로 로그인해 서명 링크를 받는다 (이전 테스트에서 발급한 PIN을 다시 쓸 수 없으니 새로 발급)
    const admin = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string }>();
    const ws = await (await post('/api/admin/workshop-pin', {}, admin.token)).json<{ pin: string }>();
    const w = await (await post('/api/auth/login', { pin: ws.pin })).json<{ token: string }>();

    expect((await call(`/api/drawings/${id}`)).status).toBe(403); // 서명 없이는 거부
    const linkRes = await call(`/api/orders/${id}/drawing-link`, { token: w.token });
    const { path } = await linkRes.json<{ path: string }>();
    expect(linkRes.status, JSON.stringify({ id, path })).toBe(200);
    const opened = await call(path);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe(html);
    expect(opened.headers.get('Content-Security-Policy')).toContain('sandbox');
  });
});
