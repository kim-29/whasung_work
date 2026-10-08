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
    // 2031년은 절단 2건만: 절단 금액 = 판매금액, 제작 금액 0
    expect(y31.totals).toMatchObject({ cut_amount: 20000, make_amount: 0 });

    const y32 = await (await call('/api/analytics?mode=year&year=2032', { token: t })).json<any>();
    expect(y32.series[0]).toMatchObject({ label: '2032-01', orders: 1, usage_m: 12, make_cost: 50000, amount: 10000 });
    // 제작 금액 = 판매금액 10,000 + 제작비용 50,000
    expect(y32.series[0]).toMatchObject({ cut_amount: 0, make_amount: 60000 });

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
  it('바 종류별 사용량은 실제 무게(작업 전체 무게를 바별 예상 무게 비율로 나눔)로, 색상별로 무게 많은 순으로 낸다', async () => {
    const t = await login();
    await send('POST', '/api/bars', { name: 'AC-LIGHT', kg_per_m: 1 }, t);
    await send('POST', '/api/bars', { name: 'AC-HEAVY', kg_per_m: 5 }, t);
    const mk = async (items: { bar_name: string; length_mm: number; qty: number; color: string }[], weight?: number) => {
      const res = await send('POST', '/api/orders', { company: '색상분석', kind: 'cut', items }, t);
      expect(res.status).toBe(201);
      const r = await res.json<{ id: number }>();
      if (weight) await send('POST', `/api/orders/${r.id}/weight`, { weight }, t);
      await env.DB.prepare(`UPDATE orders SET created_at = '2033-05-10 03:00:00' WHERE id = ?1`).bind(r.id).run();
    };
    await mk([{ bar_name: 'AC-LIGHT', length_mm: 10000, qty: 1, color: '기타' }], 7); // LIGHT 기타 7kg
    await mk([{ bar_name: 'AC-HEAVY', length_mm: 2000, qty: 1, color: '블랙' }], 3); // HEAVY 블랙 3kg
    await mk([{ bar_name: 'AC-HEAVY', length_mm: 2000, qty: 1, color: '기타' }], 4); // HEAVY 기타 4kg
    // 한 작업에 두 바: 예상 무게 LIGHT 1kg : HEAVY 5kg → 실제 12kg 을 2kg : 10kg 으로 나눈다
    await mk([{ bar_name: 'AC-LIGHT', length_mm: 1000, qty: 1, color: '블랙' }, { bar_name: 'AC-HEAVY', length_mm: 1000, qty: 1, color: '블랙' }], 12);
    // 무게가 아직 입력되지 않은 작업은 바 종류별 사용량에 넣지 않는다
    await mk([{ bar_name: 'AC-LIGHT', length_mm: 20000, qty: 1, color: '실버' }]);
    const m = await (await call('/api/analytics?mode=month&month=2033-05', { token: t })).json<any>();
    expect(m.series[9].weight_by_color).toMatchObject({ 기타: 11, 블랙: 15 });
    expect(m.series[9].weight_by_color['실버'] ?? 0).toBe(0); // 무게가 입력되지 않은 작업은 0
    expect(m.bars.map((b: any) => b.bar_name)).toEqual(['AC-HEAVY', 'AC-LIGHT']);
    expect(m.bars[0].weight_kg).toBeCloseTo(17, 5); // 3 + 4 + 10
    expect(m.bars[0].by_color['블랙']).toBeCloseTo(13, 5);
    expect(m.bars[0].by_color['기타']).toBeCloseTo(4, 5);
    expect(m.bars[1].weight_kg).toBeCloseTo(9, 5); // 7 + 2 (길이가 가장 긴 진행 중 작업은 제외)
    expect(m.bars[1].by_color['실버']).toBeUndefined();
    expect(m.totals.bar_kinds).toBe(2);
    // 예상 무게는 응답에서 뺐다
    expect('usage_kg' in m.totals).toBe(false);
    // 기타 색상의 단가도 설정할 수 있다
    expect((await send('PUT', '/api/prices', { color: '기타', price_per_kg: 1500 }, t)).status).toBe(200);
  });
});
