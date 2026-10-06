import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// flow.test.ts 와 같은 DB 를 공유한다. 관리자는 이미 만들어져 있고, 같은 PIN 으로 다시 로그인한다.
const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  return SELF.fetch(`https://x${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
};
const send = (method: string, path: string, body: unknown, token: string) =>
  call(path, { method, body: JSON.stringify(body), token });
const login = async () =>
  (await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: '123456' }), headers: { 'CF-Connecting-IP': '8.8.8.8' } })).json<{ token: string }>()).token;

describe('제작비용 · 업체 · 묶음 납입 · 한국 시간', () => {
  it('제작비용은 제작 작업에만, 완납 전까지만 입력되고 미입력과 0원이 구분된다', async () => {
    const t = await login();
    await send('POST', '/api/bars', { name: 'MC-A', kg_per_m: 1 }, t);
    await send('PUT', '/api/prices', { color: '화이트', price_per_kg: 1000 }, t);
    const mk = async (kind: 'make' | 'cut') =>
      (await (await send('POST', '/api/orders', { company: '제작비 업체', kind, items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 10, color: '화이트' }] }, t)).json<{ id: number }>()).id;
    const make = await mk('make');
    const cut = await mk('cut');
    for (const id of [make, cut]) await send('POST', `/api/orders/${id}/weight`, { weight: 10 }, t);
    await send('POST', `/api/orders/${make}/complete`, {}, t);

    // 절단에는 제작비용을 넣을 수 없다
    expect((await send('PATCH', `/api/orders/${cut}`, { make_cost: 5000 }, t)).status).toBe(400);
    // 제작에는 넣을 수 있고, 세부내역에 그대로 나온다
    expect((await send('PATCH', `/api/orders/${make}`, { make_cost: 120000 }, t)).status).toBe(200);
    const d = await (await call(`/api/orders/${make}`, { token: t })).json<{ make_cost: number; amount: number }>();
    expect(d).toMatchObject({ make_cost: 120000, amount: 10000 });
    // 음수, 소수는 거절
    expect((await send('PATCH', `/api/orders/${make}`, { make_cost: -1 }, t)).status).toBe(400);
    expect((await send('PATCH', `/api/orders/${make}`, { make_cost: 1.5 }, t)).status).toBe(400);
    // null 로 '미입력' 으로 되돌릴 수 있고, 0 은 입력된 값이다
    await send('PATCH', `/api/orders/${make}`, { make_cost: null }, t);
    const unpaid = await (await call('/api/dashboard/unpaid', { token: t })).json<{ id: number; make_cost: number | null; price_per_kg: number }[]>();
    expect(unpaid.find((o) => o.id === make)).toMatchObject({ make_cost: null, price_per_kg: 1000 });
    const byCo = await (await call('/api/dashboard/by-company', { token: t })).json<{ company: string; make_cost_missing: number; total_make_cost: number }[]>();
    expect(byCo.find((c) => c.company === '제작비 업체')?.make_cost_missing).toBe(1);
    await send('PATCH', `/api/orders/${make}`, { make_cost: 0 }, t);
    const byCo2 = await (await call('/api/dashboard/by-company', { token: t })).json<{ company: string; make_cost_missing: number }[]>();
    expect(byCo2.find((c) => c.company === '제작비 업체')?.make_cost_missing).toBe(0);

    // 제작비용이 비어 있으면 납입 처리가 거절된다 (단건·묶음 모두)
    await send('PATCH', `/api/orders/${make}`, { make_cost: null }, t);
    expect((await send('POST', `/api/orders/${make}/pay`, {}, t)).status).toBe(409);
    expect((await send('POST', '/api/orders/pay-batch', { ids: [make, cut] }, t)).status).toBe(409);
    expect(((await (await call(`/api/orders/${cut}`, { token: t })).json()) as { status: string }).status).toBe('unpaid');

    // 완납 후에는 제작비용도 수정할 수 없다
    await send('PATCH', `/api/orders/${make}`, { make_cost: 50000 }, t);
    expect((await send('POST', `/api/orders/${make}/pay`, {}, t)).status).toBe(200);
    expect((await send('PATCH', `/api/orders/${make}`, { make_cost: 60000 }, t)).status).toBe(409);
  });

  it('미납이 된 절단을 제작으로 바꾸면 미납에서 빠져 제작중(무게 유지)으로 작업장에 넘어간다', async () => {
    const t = await login();
    await send('POST', '/api/bars', { name: 'MC-A', kg_per_m: 1 }, t);
    const o = await (await send('POST', '/api/orders', { company: '절단후제작업체', kind: 'cut', items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 3, color: '화이트' }] }, t)).json<{ id: number }>();
    await send('POST', `/api/orders/${o.id}/weight`, { weight: 3 }, t);
    const unpaidIds = async () => (await (await call('/api/dashboard/unpaid', { token: t })).json<{ id: number }[]>()).map((r) => r.id);
    expect(await unpaidIds()).toContain(o.id);

    expect((await send('PATCH', `/api/orders/${o.id}`, { kind: 'make' }, t)).status).toBe(200);
    const d = await (await call(`/api/orders/${o.id}`, { token: t })).json<{ status: string; kind: string; actual_weight: number; completed_at: string | null }>();
    expect(d).toMatchObject({ status: 'making', kind: 'make', actual_weight: 3, completed_at: null });
    expect(await unpaidIds()).not.toContain(o.id);

    // 작업장에서 제작 완료하면 다시 미납으로
    expect((await send('POST', `/api/orders/${o.id}/complete`, {}, t)).status).toBe(200);
    expect(await unpaidIds()).toContain(o.id);
  });

  it('제작중인 건을 절단으로 바꾸면 바로 미납으로 간다', async () => {
    const t = await login();
    await send('POST', '/api/bars', { name: 'MC-A', kg_per_m: 1 }, t);
    const o = await (await send('POST', '/api/orders', { company: '제작취소업체', kind: 'make', items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 2, color: '화이트' }] }, t)).json<{ id: number }>();
    await send('POST', `/api/orders/${o.id}/weight`, { weight: 2 }, t);
    await send('PATCH', `/api/orders/${o.id}`, { make_cost: 1000 }, t);
    expect((await send('PATCH', `/api/orders/${o.id}`, { kind: 'cut' }, t)).status).toBe(200);
    const d = await (await call(`/api/orders/${o.id}`, { token: t })).json<{ status: string; kind: string; actual_weight: number; completed_at: string | null; make_cost: number | null }>();
    expect(d).toMatchObject({ status: 'unpaid', kind: 'cut', actual_weight: 2, make_cost: null });
    expect(d.completed_at).not.toBeNull();
    const unpaid = await (await call('/api/dashboard/unpaid', { token: t })).json<{ id: number }[]>();
    expect(unpaid.map((r) => r.id)).toContain(o.id);
  });

  it('월간 거래내역은 대기(진행중) → 미납 → 완납 순이고 같은 상태는 지시일이 늦은 것부터', async () => {
    const t = await login();
    const mk = async (company: string) =>
      (await (await send('POST', '/api/orders', { company, kind: 'cut', items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '화이트' }] }, t)).json<{ id: number }>()).id;
    const paid = await mk('순서업체');
    const unpaid = await mk('순서업체');
    const pending = await mk('순서업체');
    for (const id of [paid, unpaid]) await send('POST', `/api/orders/${id}/weight`, { weight: 1 }, t);
    await send('POST', `/api/orders/${paid}/pay`, {}, t);
    const month = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
    const r = await (await call(`/api/dashboard/monthly?month=${month}`, { token: t })).json<{ orders: { id: number; status: string }[] }>();
    const mine = r.orders.filter((x) => [paid, unpaid, pending].includes(x.id)).map((x) => x.id);
    expect(mine).toEqual([pending, unpaid, paid]);
    const rank = { pending: 0, making: 0, unpaid: 1, paid: 2 } as Record<string, number>;
    const ranks = r.orders.map((x) => rank[x.status]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('업체는 자동 등록되고, 이름 변경·합치기·삭제 규칙이 지켜진다', async () => {
    const t = await login();
    const mk = (company: string) =>
      send('POST', '/api/orders', { company, kind: 'cut', items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '화이트' }] }, t);
    await mk('  테스트   한빛 '); // 공백이 정리되어 '테스트 한빛' 으로 등록
    await mk('테스트한빛');
    const list = async () => await (await call('/api/companies', { token: t })).json<{ id: number; name: string; email: string | null; order_count: number }[]>();
    let cs = await list();
    const a = cs.find((c) => c.name === '테스트 한빛')!;
    const b = cs.find((c) => c.name === '테스트한빛')!;
    expect(a && b).toBeTruthy();
    expect(a.order_count).toBe(1);

    // 이메일 형식 검사, 전화는 비워도 됨
    expect((await send('PUT', `/api/companies/${a.id}`, { name: '테스트 한빛', email: '이메일아님' }, t)).status).toBe(400);
    expect((await send('PUT', `/api/companies/${a.id}`, { name: '테스트 한빛', email: 'a@b.co' }, t)).status).toBe(200);

    // 같은 이름으로 바꾸면 합쳐지고, 작업과 이메일이 따라온다
    const merged = await (await send('PUT', `/api/companies/${b.id}`, { name: '테스트 한빛' }, t)).json<{ merged: boolean }>();
    expect(merged.merged).toBe(true);
    cs = await list();
    expect(cs.find((c) => c.name === '테스트한빛')).toBeUndefined();
    expect(cs.find((c) => c.name === '테스트 한빛')).toMatchObject({ order_count: 2, email: 'a@b.co' });

    // 거래가 있는 업체는 삭제 불가, 거래가 없는 업체는 삭제 가능
    expect((await call(`/api/companies/${a.id}`, { method: 'DELETE', token: t })).status).toBe(409);
    const created = await (await send('POST', '/api/companies', { name: '빈 업체' }, t)).json<{ id: number }>();
    expect((await send('POST', '/api/companies', { name: '빈 업체' }, t)).status).toBe(409);
    expect((await call(`/api/companies/${created.id}`, { method: 'DELETE', token: t })).status).toBe(200);
  });

  it('묶음 납입은 전부 미납일 때만 한 번에 처리된다', async () => {
    const t = await login();
    const r = await (await send('POST', '/api/orders', {
      company: '묶음업체', kind: 'cut',
      items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '화이트' }, { bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '블랙' }],
    }, t)).json<{ ids: number[] }>();
    expect(r.ids).toHaveLength(2);
    for (const id of r.ids) await send('POST', `/api/orders/${id}/weight`, { weight: 1 }, t);

    // 하나라도 미납이 아니면 아무것도 바꾸지 않는다
    await send('POST', `/api/orders/${r.ids[0]}/pay`, {}, t);
    expect((await send('POST', '/api/orders/pay-batch', { ids: r.ids }, t)).status).toBe(409);
    expect((await call(`/api/orders/${r.ids[1]}`, { token: t }).then((x) => x.json<{ status: string }>())).status).toBe('unpaid');
    expect((await send('POST', '/api/orders/pay-batch', { ids: [r.ids[1], 999999] }, t)).status).toBe(404);

    const again = await (await send('POST', '/api/orders', { company: '묶음업체', kind: 'cut', items: [{ bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '화이트' }, { bar_name: 'MC-A', length_mm: 1000, qty: 1, color: '블랙' }] }, t)).json<{ ids: number[] }>();
    for (const id of again.ids) await send('POST', `/api/orders/${id}/weight`, { weight: 1 }, t);
    const ok = await send('POST', '/api/orders/pay-batch', { ids: again.ids }, t);
    expect(ok.status).toBe(200);
    expect((await ok.json<{ paid: number }>()).paid).toBe(2);
  });

  it('월간·자재 사용내역은 한국 시간 기준 지시일로 집계된다', async () => {
    const t = await login();
    const r = await (await send('POST', '/api/orders', { company: '시간대업체', kind: 'cut', items: [{ bar_name: 'MC-A', length_mm: 6000, qty: 1, color: '화이트' }] }, t)).json<{ id: number }>();
    // UTC 2026-09-30 16:00 = 한국 시간 2026-10-01 01:00  → 10월로 집계되어야 한다
    await env.DB.prepare(`UPDATE orders SET created_at = '2026-09-30 16:00:00' WHERE id = ?1`).bind(r.id).run();
    const oct = await (await call('/api/dashboard/monthly?month=2026-10', { token: t })).json<{ orders: { id: number }[] }>();
    const sep = await (await call('/api/dashboard/monthly?month=2026-09', { token: t })).json<{ orders: { id: number }[] }>();
    expect(oct.orders.map((o) => o.id)).toContain(r.id);
    expect(sep.orders.map((o) => o.id)).not.toContain(r.id);

    const usage = async (day: string) =>
      (await (await call(`/api/dashboard/usage?from=${day}&to=${day}`, { token: t })).json<{ bar_name: string; total_m: number }[]>()).find((u) => u.bar_name === 'MC-A')?.total_m ?? 0;
    expect(await usage('2026-10-01')).toBe(6);
    expect(await usage('2026-09-30')).toBe(0);
  });
});
