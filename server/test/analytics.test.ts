import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  return SELF.fetch(`https://x${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
};
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const login = async () =>
  (await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: '123456' }), headers: { 'CF-Connecting-IP': '8.8.4.4' } })).json<{ token: string }>()).token;

describe('판매분석', () => {
  it('년간/월간으로 건수·무게·금액·자재·업체 순위를 한국 시간 지시일 기준으로 센다', async () => {
    const t = await login();
    // 2031년(다른 테스트와 겹치지 않는 해)에 접수된 것으로 만든다. 업체 둘: 분석A 는 2건, 분석B 는 1건.
    await send('POST', '/api/bars', { name: 'AN-A', kg_per_m: 2 }, t);
    await send('PUT', '/api/prices', { color: '화이트', price_per_kg: 1000 }, t);
    const mk = async (company: string, kind: 'make' | 'cut', len: number, qty: number) => {
      const r = await (await send('POST', '/api/orders', { company, kind, items: [{ bar_name: 'AN-A', length_mm: len, qty, color: '화이트' }] }, t)).json<{ id: number }>();
      await send('POST', `/api/orders/${r.id}/weight`, { weight: 10 }, t);
      if (kind === 'make') await send('POST', `/api/orders/${r.id}/complete`, {}, t);
      return r.id;
    };
    const a1 = await mk('분석A', 'make', 6000, 2); // 12m
    const a2 = await mk('분석A', 'cut', 3000, 2); //  6m
    const b1 = await mk('분석B', 'cut', 6000, 1); //  6m
    await send('PATCH', `/api/orders/${a1}`, { make_cost: 50000 }, t);
    // a1: UTC 2031-12-31 16:00 = 한국 2032-01-01 01:00 (2032년으로 집계), a2/b1: 2031-03-15
    await env.DB.prepare(`UPDATE orders SET created_at = '2031-12-31 16:00:00' WHERE id = ?1`).bind(a1).run();
    await env.DB.prepare(`UPDATE orders SET created_at = '2031-03-15 03:00:00' WHERE id IN (?1, ?2)`).bind(a2, b1).run();

    const y31 = await (await call('/api/analytics?mode=year&year=2031', { token: t })).json<any>();
    expect(y31.series).toHaveLength(12);
    expect(y31.totals.orders).toBe(2); // a1 은 한국 시간으로 2032년
    expect(y31.series[2]).toMatchObject({ label: '2031-03', orders: 2, usage_m: 12, weight: 20 });
    expect(y31.totals.amount).toBe(20000); // 10kg × 1000 × 2건
    expect(y31.totals.make_cost).toBe(0);

    const y32 = await (await call('/api/analytics?mode=year&year=2032', { token: t })).json<any>();
    expect(y32.series[0]).toMatchObject({ label: '2032-01', orders: 1, usage_m: 12, make_cost: 50000, amount: 10000 });

    // 월간은 일별 칸이 그 달의 날수만큼 나온다
    const m = await (await call('/api/analytics?mode=month&month=2031-03', { token: t })).json<any>();
    expect(m.series).toHaveLength(31);
    expect(m.series[14]).toMatchObject({ label: '2031-03-15', orders: 2 });

    // 순위: 의뢰건수·판매량(무게) 많은 순, 자재는 사용 길이 많은 순
    expect(y31.companies_by_count[0]).toMatchObject({ company: '분석A', orders: 1 }); // 2031년 안에서는 A 1건(a2), B 1건(b1) → 이름순
    const mk2 = await (await call('/api/analytics?mode=month&month=2031-03', { token: t })).json<any>();
    expect(mk2.companies_by_weight.map((c: any) => c.company)).toEqual(['분석A', '분석B'].sort()); // 둘 다 10kg → 이름순
    expect(y31.bars.find((b: any) => b.bar_name === 'AN-A')?.total_m).toBe(12);

    // 잘못된 값은 거절
    expect((await call('/api/analytics?mode=year&year=20x1', { token: t })).status).toBe(400);
    expect((await call('/api/analytics?mode=month&month=2031-13', { token: t })).status).toBe(400);
    // 로그인하지 않으면 볼 수 없다
    expect((await call('/api/analytics')).status).toBe(401);
  });
});
