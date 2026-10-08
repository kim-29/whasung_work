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
            { bar_name: '없는바', length_mm: 1000, qty: 1, color: '화이트' },
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

    // 납입: 제작비용(0원 포함)을 입력하기 전에는 납입할 수 없다
    expect((await post(`/api/orders/${created.id}/pay`, {}, s.token)).status).toBe(409);
    expect((await call(`/api/orders/${created.id}`, { method: 'PATCH', body: JSON.stringify({ make_cost: 0 }), token: s.token })).status).toBe(200);
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

  it('절단은 색상별로 나뉘고, 제작은 색상 하나만 받는다', async () => {
    const a = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string }>();
    const items = [
      { bar_name: 'NS88-A', length_mm: 1000, qty: 2, color: '화이트' },
      { bar_name: 'NS88-A', length_mm: 1000, qty: 1, color: '블랙' },
      { bar_name: 'NS88-A', length_mm: 500, qty: 2, color: '화이트' },
    ];
    const cut = await (await post('/api/orders', { company: '분할업체', kind: 'cut', items }, a.token)).json<{ ids: number[]; orders: { color: string }[] }>();
    expect(cut.ids).toHaveLength(2);
    expect(cut.orders.map((o) => o.color).sort()).toEqual(['블랙', '화이트']);

    const list = await (await call('/api/orders', { token: a.token })).json<{ id: number; group_id: number; color: string }[]>();
    const mine = list.filter((o) => cut.ids.includes(o.id));
    expect(new Set(mine.map((o) => o.group_id)).size).toBe(1); // 같은 지시서로 묶임

    const make = await post('/api/orders', { company: '분할업체', kind: 'make', items }, a.token);
    expect(make.status).toBe(400);
    expect((await post('/api/orders', { company: 'x', kind: 'cut', items: [{ bar_name: 'NS88-A', length_mm: 1, qty: 1 }] }, a.token)).status).toBe(400); // 색상 필수
  });

  it('단가는 지시일 기준으로 적용되고 이후 변경은 이전 작업에 영향이 없다', async () => {
    const a = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string }>();
    const put = (price: number) => call('/api/prices', { method: 'PUT', body: JSON.stringify({ color: '헨켈', price_per_kg: price }), token: a.token });
    expect((await put(5000)).status).toBe(200);

    const mk = async (company: string) => {
      const r = await (await post('/api/orders', { company, kind: 'cut', items: [{ bar_name: 'NS88-A', length_mm: 1000, qty: 1, color: '헨켈' }] }, a.token)).json<{ id: number }>();
      await post(`/api/orders/${r.id}/weight`, { weight: 10 }, a.token);
      return r.id;
    };
    const first = await mk('단가업체');
    await new Promise((r) => setTimeout(r, 1100)); // effective_from 은 초 단위라 한 칸 띄운다
    expect((await put(6000)).status).toBe(200);
    const second = await mk('단가업체');

    const unpaid = await (await call('/api/dashboard/unpaid', { token: a.token })).json<{ id: number; amount: number }[]>();
    expect(unpaid.find((o) => o.id === first)?.amount).toBe(50000); // 10kg × 5,000
    expect(unpaid.find((o) => o.id === second)?.amount).toBe(60000); // 10kg × 6,000

    const byCompany = await (await call('/api/dashboard/by-company', { token: a.token })).json<{ company: string; total_amount: number }[]>();
    expect(byCompany.find((c) => c.company === '단가업체')?.total_amount).toBe(110000);

    // 세부내역에 단가·금액이 나오고, 무게를 고치면 금액도 따라간다 (작업장에는 금액 숨김)
    const detail = await (await call(`/api/orders/${first}`, { token: a.token })).json<{ price_per_kg: number; amount: number; actual_weight: number }>();
    expect(detail).toMatchObject({ price_per_kg: 5000, amount: 50000, actual_weight: 10 });
    expect((await call(`/api/orders/${first}`, { method: 'PATCH', body: JSON.stringify({ actual_weight: 12 }), token: a.token })).status).toBe(200);
    expect((await (await call(`/api/orders/${first}`, { token: a.token })).json<{ amount: number }>()).amount).toBe(60000);

    const month = await (await call('/api/dashboard/monthly', { token: a.token })).json<{ summary: { total_amount: number }; orders: { id: number; amount: number }[] }>();
    expect(month.orders.find((o) => o.id === first)?.amount).toBe(60000);
    expect(month.summary.total_amount).toBeGreaterThanOrEqual(120000);
  });

  it('삭제는 관리자만 하고, 같은 지시서가 공유하는 도면은 마지막 오더가 지워질 때 함께 지워진다', async () => {
    const a = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string }>();
    const staff = await (await post('/api/admin/users', { name: '삭제테스트' }, a.token)).json<{ pin: string }>();
    const s = await (await post('/api/auth/login', { pin: staff.pin })).json<{ token: string }>();

    const body = {
      company: '삭제업체', kind: 'cut', drawing_html: '<html>d</html>',
      items: [{ bar_name: 'NS88-A', length_mm: 1000, qty: 1, color: '화이트' }, { bar_name: 'NS88-A', length_mm: 1000, qty: 1, color: '블랙' }],
    };
    const r = await call('/api/ingest/blender', { method: 'POST', body: JSON.stringify(body), headers: { 'X-API-Key': 'test-key' } });
    const { ids } = await r.json<{ ids: number[] }>();
    expect(ids).toHaveLength(2);

    const del = (id: number, token: string) => call(`/api/orders/${id}`, { method: 'DELETE', token });
    expect((await del(ids[0], s.token)).status).toBe(403); // 직원은 삭제 불가
    expect((await del(ids[0], a.token)).status).toBe(200);
    // 아직 남은 오더가 도면을 쓰고 있으므로 도면은 유지된다
    const link = await (await call(`/api/orders/${ids[1]}/drawing-link`, { token: a.token })).json<{ path: string }>();
    expect((await call(link.path)).status).toBe(200);
    expect((await del(ids[1], a.token)).status).toBe(200);
    expect((await call(`/api/orders/${ids[1]}`, { token: a.token })).status).toBe(404);
  });

  it('Blender 전송은 API 키가 필요하다', async () => {
    const body = { company: '테스트', kind: 'cut', items: [{ bar_name: 'x', length_mm: 100, qty: 1, color: '블랙' }] };
    expect((await post('/api/ingest/blender', body)).status).toBe(401);
    const ok = await call('/api/ingest/blender', {
      method: 'POST', body: JSON.stringify(body), headers: { 'X-API-Key': 'test-key' },
    });
    expect(ok.status).toBe(201);
  });

  it('Blender 도면(HTML)은 KV에 저장되고 서명 링크로만 열린다', async () => {
    const html = '<html><body>도면 테스트</body></html>';
    const body = { company: '도면업체', kind: 'make', items: [{ bar_name: 'x', length_mm: 100, qty: 1, color: '실버' }], drawing_html: html };
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

    // 작업장 계정에는 바 목록의 추가 단가(금액 정보)를 내려주지 않는다
    const wsBars = await (await call('/api/bars', { token: w.token })).json<Record<string, unknown>[]>();
    expect(wsBars.length).toBeGreaterThan(0);
    expect(wsBars.every((b) => !('price_add' in b))).toBe(true);
    const adminBars = await (await call('/api/bars', { token: admin.token })).json<Record<string, unknown>[]>();
    expect(adminBars.every((b) => 'price_add' in b)).toBe(true);

    // 공유 링크: 직원·관리자는 ?days 로 며칠간 열 수 있는 링크를 만들 수 있고(최대 30일), 작업장은 항상 10분
    const expOf = (p: string) => Number(new URL(`https://x${p}`).searchParams.get('exp')) - Math.floor(Date.now() / 1000);
    const shared = await (await call(`/api/orders/${id}/drawing-link?days=7`, { token: admin.token })).json<{ path: string }>();
    expect(expOf(shared.path)).toBeGreaterThan(6 * 86400);
    expect(expOf(shared.path)).toBeLessThanOrEqual(7 * 86400);
    expect((await call(shared.path)).status).toBe(200);
    const capped = await (await call(`/api/orders/${id}/drawing-link?days=999`, { token: admin.token })).json<{ path: string }>();
    expect(expOf(capped.path)).toBeLessThanOrEqual(30 * 86400);
    const ws7 = await (await call(`/api/orders/${id}/drawing-link?days=7`, { token: w.token })).json<{ path: string }>();
    expect(expOf(ws7.path)).toBeLessThanOrEqual(600);
  });
  it('직원 삭제: 사용 중지한 직원(staff)만, 기기도 함께 지운다. 관리자·작업장·자기 자신은 불가', async () => {
    const a = await (await post('/api/auth/login', { pin: '123456' })).json<{ token: string }>();
    const made = await (await post('/api/admin/users', { name: '퇴사예정직원' }, a.token)).json<{ id: number; pin: string }>();
    const s = await (await post('/api/auth/login', { pin: made.pin })).json<{ token: string }>(); // 기기 등록
    const del = (id: number, token = a.token) => call(`/api/admin/users/${id}`, { method: 'DELETE', token });
    const users = async () => (await (await call('/api/admin/users', { token: a.token })).json<{ id: number; role: string }[]>());

    expect((await del(made.id, s.token)).status).toBe(403); // 직원은 삭제 권한 없음
    expect((await del(made.id)).status).toBe(409); // 사용 중인 직원은 먼저 중지해야 함
    const admin = (await users()).find((u) => u.role === 'admin')!;
    expect((await del(admin.id)).status).toBe(400); // 자기 자신(관리자)
    await post('/api/admin/workshop-pin', {}, a.token);
    const workshop = (await users()).find((u) => u.role === 'workshop')!;
    await call(`/api/admin/users/${workshop.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }), token: a.token });
    expect((await del(workshop.id)).status).toBe(400); // 작업장 계정은 삭제 불가
    await call(`/api/admin/users/${workshop.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }), token: a.token });

    await call(`/api/admin/users/${made.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }), token: a.token });
    expect((await del(made.id)).status).toBe(200);
    expect((await users()).some((u) => u.id === made.id)).toBe(false);
    expect((await del(made.id)).status).toBe(404);
    // 삭제된 직원의 PIN·기기 토큰은 더는 쓸 수 없다
    expect((await post('/api/auth/login', { pin: made.pin })).status).not.toBe(200);
    expect((await call('/api/orders', { token: s.token })).status).toBe(401);
  });
});
