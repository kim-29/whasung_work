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
  it('지시일 기준으로 칸을 정하고, 자재 사용내역은 무게가 입력된 작업만, 거래내역은 완납/미납/진행으로 나눈다', async () => {
    const t = await login();
    // 2031년(다른 테스트와 겹치지 않는 해). 업체 둘: 분석A, 분석B. AN-A 는 2kg/m.
    await send('POST', '/api/bars', { name: 'AN-A', kg_per_m: 2 }, t);
    await send('PUT', '/api/prices', { color: '화이트', price_per_kg: 1000 }, t);
    const mk = async (company: string, kind: 'make' | 'cut', len: number, qty: number, weight?: number) => {
      const r = await (await send('POST', '/api/orders', { company, kind, items: [{ bar_name: 'AN-A', length_mm: len, qty, color: '화이트' }] }, t)).json<{ id: number }>();
      if (weight) await send('POST', `/api/orders/${r.id}/weight`, { weight }, t);
      if (weight && kind === 'make') await send('POST', `/api/orders/${r.id}/complete`, {}, t);
      return r.id;
    };
    const at = (id: number, utc: string) => env.DB.prepare(`UPDATE orders SET created_at = ?1 WHERE id = ?2`).bind(utc, id).run();
    const a2 = await mk('분석A', 'cut', 3000, 2, 10); // 6m, 예상 12kg, 실제 10kg → 완납
    const b1 = await mk('분석B', 'cut', 6000, 1, 10); // 6m, 예상 12kg, 실제 10kg → 미납
    const c1 = await mk('분석B', 'cut', 1000, 1); //     1m, 예상 2kg, 무게 아직 없음 → 진행
    const o1 = await mk('분석A', 'cut', 6000, 1, 10); // 10/31 에 지시, 무게는 나중에 입력 → 10월에 들어가야 한다 (미납)
    const a1 = await mk('분석A', 'make', 6000, 2, 10); // 12m, 제작 → 2032-01-01 01:00(KST)
    await send('PATCH', `/api/orders/${a1}`, { make_cost: 50000 }, t);
    await send('POST', `/api/orders/${a2}/pay`, {}, t);
    await send('POST', `/api/orders/${a1}/pay`, {}, t);
    await at(a2, '2031-03-15 03:00:00');
    await at(b1, '2031-03-15 05:00:00');
    await at(c1, '2031-03-16 05:00:00');
    await at(o1, '2031-10-31 03:00:00');
    await at(a1, '2031-12-31 16:00:00'); // UTC 12/31 16:00 = 한국 2032-01-01 01:00

    const y31 = await (await call('/api/analytics?mode=year&year=2031', { token: t })).json<any>();
    expect(y31.series).toHaveLength(12);
    // 3월: 완납 1건(a2), 미납 1건(b1), 진행 1건(c1)
    expect(y31.series[2]).toMatchObject({
      label: '2031-03',
      paid: { orders: 1, weight: 10, amount: 10000, cut_amount: 10000, make_amount: 0 },
      unpaid: { orders: 1, weight: 10, amount: 10000 },
      active: { orders: 1, theory_kg: 2 },
      usage_m: 12, // a2 6m + b1 6m. 무게가 입력되지 않은 c1(1m)은 자재 사용내역에서 빠진다
      usage_theory_kg: 24,
      weight: 20,
    });
    // 지시일이 10/31 이면 무게 입력·납입이 언제든 10월에 들어간다
    expect(y31.series[9]).toMatchObject({ label: '2031-10', unpaid: { orders: 1, weight: 10, amount: 10000 }, usage_m: 6 });
    expect(y31.totals).toMatchObject({
      paid: { orders: 1, weight: 10, amount: 10000 },
      unpaid: { orders: 2, weight: 20, amount: 20000 },
      active: { orders: 1, theory_kg: 2 },
      usage_m: 18, usage_theory_kg: 36, weight: 30, bar_kinds: 1,
    });
    // a1 은 한국 시간으로 2032년: 완납 제작 = 판매금액 10,000 + 제작비용 50,000
    const y32 = await (await call('/api/analytics?mode=year&year=2032', { token: t })).json<any>();
    expect(y32.series[0]).toMatchObject({ label: '2032-01', paid: { orders: 1, weight: 10, amount: 60000, cut_amount: 0, make_amount: 60000 } });

    // 월간은 일별 칸이 그 달의 날수만큼 나온다
    const m = await (await call('/api/analytics?mode=month&month=2031-03', { token: t })).json<any>();
    expect(m.series).toHaveLength(31);
    expect(m.series[14]).toMatchObject({ label: '2031-03-15', paid: { orders: 1 }, unpaid: { orders: 1 } });
    expect(m.series[15]).toMatchObject({ label: '2031-03-16', active: { orders: 1, theory_kg: 2 } });

    // 바 종류별 사용량: 무게가 입력된 작업만, 예상 무게 기준
    const bar = y31.bars.find((b: any) => b.bar_name === 'AN-A');
    expect(bar).toMatchObject({ total_m: 18, theory_kg: 36 });
    expect(bar.by_color['화이트']).toBeCloseTo(36, 5);

    // 업체별: 건수와 무게를 상태별로 (완납·미납은 실제 무게, 진행은 예상 무게)
    expect(y31.companies_by_count.map((c: any) => c.company)).toEqual(['분석A', '분석B']); // 둘 다 2건 → 이름순
    expect(y31.companies_by_count[0]).toMatchObject({ paid: 1, unpaid: 1, active: 0 });
    expect(y31.companies_by_count[1]).toMatchObject({ paid: 0, unpaid: 1, active: 1 });
    expect(y31.companies_by_weight[0]).toMatchObject({ company: '분석A', paid: 10, unpaid: 10, active: 0 });
    expect(y31.companies_by_weight[1]).toMatchObject({ company: '분석B', paid: 0, unpaid: 10, active: 2 });

    // 잘못된 값은 거절
    expect((await call('/api/analytics?mode=year&year=20x1', { token: t })).status).toBe(400);
    expect((await call('/api/analytics?mode=month&month=2031-13', { token: t })).status).toBe(400);
    // 로그인하지 않으면 볼 수 없다
    expect((await call('/api/analytics')).status).toBe(401);
  });

  it('바 종류별 사용량은 무게가 입력된 작업의 예상 무게를 색상별로, 많은 순으로 낸다', async () => {
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
    // 길이는 LIGHT 가 더 길지만 예상 무게는 HEAVY 가 더 많다
    await mk([{ bar_name: 'AC-LIGHT', length_mm: 10000, qty: 1, color: '기타' }], 7); // LIGHT 기타 10kg
    await mk([{ bar_name: 'AC-HEAVY', length_mm: 2000, qty: 1, color: '블랙' }], 3); // HEAVY 블랙 10kg
    await mk([{ bar_name: 'AC-HEAVY', length_mm: 2000, qty: 1, color: '기타' }], 4); // HEAVY 기타 10kg
    await mk([{ bar_name: 'AC-LIGHT', length_mm: 20000, qty: 1, color: '실버' }]); //   무게가 없는 작업은 빠진다
    const m = await (await call('/api/analytics?mode=month&month=2033-05', { token: t })).json<any>();
    expect(m.series[9].weight_by_color).toEqual({ 기타: 11, 블랙: 3 });
    expect(m.bars.map((b: any) => b.bar_name)).toEqual(['AC-HEAVY', 'AC-LIGHT']);
    expect(m.bars[0]).toMatchObject({ theory_kg: 20, by_color: { 블랙: 10, 기타: 10 } });
    expect(m.bars[1]).toMatchObject({ theory_kg: 10, total_m: 10, by_color: { 기타: 10 } });
    expect(m.totals).toMatchObject({ bar_kinds: 2, usage_m: 14, usage_theory_kg: 30, weight: 14 });
    expect(m.totals.active.orders).toBe(1); // 무게가 없는 작업은 진행 1건
    // 기타 색상의 단가도 설정할 수 있다
    expect((await send('PUT', '/api/prices', { color: '기타', price_per_kg: 1500 }, t)).status).toBe(200);
  });
});
