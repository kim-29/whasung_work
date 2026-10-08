import { Hono } from 'hono';
import { frontOnly } from './auth';
import { PRICE_SQL } from './orders-service';
import type { AppEnv } from './types';

// 판매분석: 년간/월간 집계.
//  - 어느 달·날에 넣을지는 모두 '지시일'(작업지시서가 접수된 날)을 한국 시간(UTC+9)으로 바꿔서 정한다.
//    그래서 10/31 에 지시한 작업은 무게가 11/1 에 입력되거나 아직 납입 전이어도 10월에 들어간다.
//  - 자재 사용내역(길이·예상 무게·실제 무게·바 종류)은 무게가 입력된 작업만 센다.
//  - 거래내역은 상태별로 나눈다: 완납(paid) / 미납(unpaid) / 진행(pending·making).
export const analytics = new Hono<AppEnv>();
analytics.use('*', frontOnly);

const KST = `'+9 hours'`;
type Group = 'paid' | 'unpaid' | 'active';
const GROUP_SQL = `CASE o.status WHEN 'paid' THEN 'paid' WHEN 'unpaid' THEN 'unpaid' ELSE 'active' END`;

/**
 * GET /api/analytics?mode=year&year=2026   → 2026년을 월별로
 * GET /api/analytics?mode=month&month=2026-10 → 2026년 10월을 일별로
 */
analytics.get('/', async (c) => {
  const mode = c.req.query('mode') === 'month' ? 'month' : 'year';
  let key: string;
  let labels: string[];
  let bucket: string; // SQL: 한 작업이 속하는 칸(월 또는 일)
  let inRange: string; // SQL: 조회 기간에 속하는지
  if (mode === 'year') {
    key = c.req.query('year') ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 4);
    if (!/^\d{4}$/.test(key)) return c.json({ error: '연도 형식이 올바르지 않습니다.' }, 400);
    labels = Array.from({ length: 12 }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`);
    bucket = `strftime('%Y-%m', o.created_at, ${KST})`;
    inRange = `strftime('%Y', o.created_at, ${KST}) = ?1`;
  } else {
    key = c.req.query('month') ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return c.json({ error: '월 형식이 올바르지 않습니다.' }, 400);
    const [y, m] = key.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    labels = Array.from({ length: days }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`);
    bucket = `date(o.created_at, ${KST})`;
    inRange = `strftime('%Y-%m', o.created_at, ${KST}) = ?1`;
  }

  const q = <T>(sql: string) => c.env.DB.prepare(sql).bind(key).all<T>().then((r) => r.results);

  const [groupRows, usageRows, weightColorRows, barColorRows, companyRows, missing] = await Promise.all([
    // 거래내역: 칸 × 상태. 금액은 저장하지 않고 (실제 무게 × 지시일 단가) + 제작비용으로 계산한다.
    q<{ bucket: string; grp: Group; orders: number; weight: number; theory_kg: number; cut_amount: number; make_amount: number }>(
      `SELECT ${bucket} AS bucket, ${GROUP_SQL} AS grp, COUNT(*) AS orders,
              COALESCE(SUM(o.actual_weight),0) AS weight, COALESCE(SUM(o.theory_weight),0) AS theory_kg,
              COALESCE(SUM(CASE WHEN o.kind = 'cut' THEN ROUND(o.actual_weight * ${PRICE_SQL}) END),0) AS cut_amount,
              COALESCE(SUM(CASE WHEN o.kind = 'make' THEN COALESCE(ROUND(o.actual_weight * ${PRICE_SQL}),0) + COALESCE(o.make_cost,0) END),0) AS make_amount
         FROM orders o WHERE ${inRange} GROUP BY bucket, grp`,
    ),
    // 자재 사용내역(칸별): 무게가 입력된 작업의 사용 길이·예상 무게
    q<{ bucket: string; m: number; kg: number }>(
      `SELECT ${bucket} AS bucket, SUM(w.length_mm * w.qty) / 1000.0 AS m, SUM(w.theory_weight) AS kg
         FROM work_list w JOIN orders o ON o.id = w.order_id
        WHERE ${inRange} AND o.actual_weight IS NOT NULL GROUP BY bucket`,
    ),
    // 칸 × 색상별 실제 무게 (무게가 입력된 작업만 합쳐진다)
    q<{ bucket: string; color: string; weight: number }>(
      `SELECT ${bucket} AS bucket, COALESCE(o.color, '기타') AS color, COALESCE(SUM(o.actual_weight),0) AS weight
         FROM orders o WHERE ${inRange} AND o.actual_weight IS NOT NULL GROUP BY bucket, COALESCE(o.color, '기타')`,
    ),
    // 바 종류 × 색상별 사용량: 무게가 입력된 작업의 절단서 기준 예상 무게 (색상이 없는 옛 작업은 '기타')
    q<{ bar_name: string; color: string; m: number; kg: number }>(
      `SELECT w.bar_name, COALESCE(w.color, o.color, '기타') AS color,
              SUM(w.length_mm * w.qty) / 1000.0 AS m, SUM(w.theory_weight) AS kg
         FROM work_list w JOIN orders o ON o.id = w.order_id
        WHERE ${inRange} AND o.actual_weight IS NOT NULL
        GROUP BY w.bar_name, COALESCE(w.color, o.color, '기타')`,
    ),
    // 업체 × 상태: 건수와 무게(완납·미납은 실제 무게, 진행은 예상 무게)
    q<{ company: string; grp: Group; orders: number; weight: number; theory_kg: number }>(
      `SELECT o.company, ${GROUP_SQL} AS grp, COUNT(*) AS orders,
              COALESCE(SUM(o.actual_weight),0) AS weight, COALESCE(SUM(o.theory_weight),0) AS theory_kg
         FROM orders o WHERE ${inRange} GROUP BY o.company, grp`,
    ),
    q<{ make_cost_missing: number | null }>(
      `SELECT SUM(o.kind = 'make' AND o.make_cost IS NULL AND o.actual_weight IS NOT NULL) AS make_cost_missing
         FROM orders o WHERE ${inRange}`,
    ),
  ]);

  // ---- 칸별 합치기 ----
  const empty = () => ({
    paid: { orders: 0, weight: 0, amount: 0, cut_amount: 0, make_amount: 0 },
    unpaid: { orders: 0, weight: 0, amount: 0 },
    active: { orders: 0, theory_kg: 0 },
  });
  const byBucket = new Map<string, ReturnType<typeof empty>>();
  for (const r of groupRows) {
    const e = byBucket.get(r.bucket) ?? empty();
    const amount = r.cut_amount + r.make_amount;
    if (r.grp === 'paid') e.paid = { orders: r.orders, weight: r.weight, amount, cut_amount: r.cut_amount, make_amount: r.make_amount };
    else if (r.grp === 'unpaid') e.unpaid = { orders: r.orders, weight: r.weight, amount };
    else e.active = { orders: r.orders, theory_kg: r.theory_kg };
    byBucket.set(r.bucket, e);
  }
  const usageBy = new Map(usageRows.map((r) => [r.bucket, r]));
  const colorBy = new Map<string, Record<string, number>>();
  for (const r of weightColorRows) colorBy.set(r.bucket, { ...(colorBy.get(r.bucket) ?? {}), [r.color]: r.weight });

  const series = labels.map((label) => {
    const g = byBucket.get(label) ?? empty();
    const u = usageBy.get(label);
    const w = colorBy.get(label) ?? {};
    return {
      label,
      ...g,
      usage_m: u?.m ?? 0,
      usage_theory_kg: u?.kg ?? 0,
      weight: Object.values(w).reduce((a, b) => a + b, 0),
      weight_by_color: w,
    };
  });
  const sum = (f: (s: (typeof series)[number]) => number) => series.reduce((a, s) => a + f(s), 0);

  // ---- 바 종류별 사용량: 예상 무게 많은 순 ----
  const barMap = new Map<string, { bar_name: string; total_m: number; theory_kg: number; by_color: Record<string, number> }>();
  for (const r of barColorRows) {
    const b = barMap.get(r.bar_name) ?? { bar_name: r.bar_name, total_m: 0, theory_kg: 0, by_color: {} };
    b.total_m += r.m;
    b.theory_kg += r.kg;
    b.by_color[r.color] = (b.by_color[r.color] ?? 0) + r.kg;
    barMap.set(r.bar_name, b);
  }
  const allBars = [...barMap.values()].sort((a, b) => b.theory_kg - a.theory_kg || b.total_m - a.total_m || a.bar_name.localeCompare(b.bar_name));

  // ---- 업체별: 상태별 건수·무게 ----
  const companyMap = new Map<string, { company: string; orders: Record<Group, number>; kg: Record<Group, number> }>();
  for (const r of companyRows) {
    const e = companyMap.get(r.company) ?? { company: r.company, orders: { paid: 0, unpaid: 0, active: 0 }, kg: { paid: 0, unpaid: 0, active: 0 } };
    e.orders[r.grp] = r.orders;
    e.kg[r.grp] = r.grp === 'active' ? r.theory_kg : r.weight;
    companyMap.set(r.company, e);
  }
  const total = (o: Record<Group, number>) => o.paid + o.unpaid + o.active;
  const companies = [...companyMap.values()];
  const companies_by_count = [...companies]
    .sort((a, b) => total(b.orders) - total(a.orders) || a.company.localeCompare(b.company))
    .slice(0, 30)
    .map((e) => ({ company: e.company, ...e.orders }));
  const companies_by_weight = [...companies]
    .filter((e) => total(e.kg) > 0)
    .sort((a, b) => total(b.kg) - total(a.kg) || a.company.localeCompare(b.company))
    .slice(0, 30)
    .map((e) => ({ company: e.company, ...e.kg }));

  return c.json({
    mode,
    key,
    series,
    totals: {
      // 자재 사용내역 (무게가 입력된 작업만)
      usage_m: sum((s) => s.usage_m),
      usage_theory_kg: sum((s) => s.usage_theory_kg),
      weight: sum((s) => s.weight),
      bar_kinds: allBars.length,
      // 거래내역
      paid: { orders: sum((s) => s.paid.orders), weight: sum((s) => s.paid.weight), amount: sum((s) => s.paid.amount) },
      unpaid: { orders: sum((s) => s.unpaid.orders), weight: sum((s) => s.unpaid.weight), amount: sum((s) => s.unpaid.amount) },
      active: { orders: sum((s) => s.active.orders), theory_kg: sum((s) => s.active.theory_kg) },
      make_cost_missing: missing[0]?.make_cost_missing ?? 0,
    },
    bars: allBars.slice(0, 30),
    companies_by_count,
    companies_by_weight,
  });
});
