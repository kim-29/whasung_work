import { Hono } from 'hono';
import { frontOnly } from './auth';
import { PRICE_SQL } from './orders-service';
import type { AppEnv } from './types';

// 판매분석: 년간/월간 집계. 모든 날짜는 '지시일'(작업지시서가 접수된 날)을 한국 시간(UTC+9)으로 바꿔서 센다.
export const analytics = new Hono<AppEnv>();
analytics.use('*', frontOnly);

const KST = `'+9 hours'`;

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

  const [orderRows, usageRows, barItemRows, weightColorRows, byCount, byWeight, status] = await Promise.all([
    q<{ bucket: string; orders: number; weight: number; amount: number; make_cost: number; cut_amount: number; make_amount: number }>(
      `SELECT ${bucket} AS bucket, COUNT(*) AS orders, COALESCE(SUM(o.actual_weight),0) AS weight,
              COALESCE(SUM(ROUND(o.actual_weight * ${PRICE_SQL})),0) AS amount,
              COALESCE(SUM(o.make_cost),0) AS make_cost,
              -- 거래금액을 작업 종류로 나눈다: 절단만 = 판매금액, 제작 = 판매금액 + 제작비용
              COALESCE(SUM(CASE WHEN o.kind = 'cut' THEN ROUND(o.actual_weight * ${PRICE_SQL}) END),0) AS cut_amount,
              COALESCE(SUM(CASE WHEN o.kind = 'make' THEN COALESCE(ROUND(o.actual_weight * ${PRICE_SQL}),0) + COALESCE(o.make_cost,0) END),0) AS make_amount
         FROM orders o WHERE ${inRange} GROUP BY bucket`,
    ),
    q<{ bucket: string; m: number }>(
      `SELECT ${bucket} AS bucket, SUM(w.length_mm * w.qty) / 1000.0 AS m
         FROM work_list w JOIN orders o ON o.id = w.order_id WHERE ${inRange} GROUP BY bucket`,
    ),
    // 바 종류별 사용량의 원재료: 실제 무게가 입력된 작업의 절단서 줄 (색상이 없는 옛 작업은 '기타'로 센다)
    q<{ order_id: number; bar_name: string; color: string; m: number; tw: number; aw: number; otw: number }>(
      `SELECT w.order_id, w.bar_name, COALESCE(w.color, o.color, '기타') AS color,
              w.length_mm * w.qty / 1000.0 AS m, w.theory_weight AS tw, o.actual_weight AS aw, o.theory_weight AS otw
         FROM work_list w JOIN orders o ON o.id = w.order_id
        WHERE ${inRange} AND o.actual_weight IS NOT NULL`,
    ),
    // 기간 칸 × 색상별 실제 무게
    q<{ bucket: string; color: string; weight: number }>(
      `SELECT ${bucket} AS bucket, COALESCE(o.color, '기타') AS color, COALESCE(SUM(o.actual_weight),0) AS weight
         FROM orders o WHERE ${inRange} GROUP BY bucket, COALESCE(o.color, '기타')`,
    ),
    q<{ company: string; orders: number }>(
      `SELECT o.company, COUNT(*) AS orders FROM orders o WHERE ${inRange}
        GROUP BY o.company ORDER BY orders DESC, o.company LIMIT 30`,
    ),
    q<{ company: string; weight: number }>(
      `SELECT o.company, SUM(o.actual_weight) AS weight FROM orders o
        WHERE ${inRange} AND o.actual_weight IS NOT NULL
        GROUP BY o.company ORDER BY weight DESC, o.company LIMIT 30`,
    ),
    q<{ paid: number | null; unpaid: number | null; make_cost_missing: number | null }>(
      `SELECT SUM(o.status = 'paid') AS paid, SUM(o.status = 'unpaid') AS unpaid,
              SUM(o.kind = 'make' AND o.make_cost IS NULL AND o.actual_weight IS NOT NULL) AS make_cost_missing
         FROM orders o WHERE ${inRange}`,
    ),
  ]);

  // 바 종류별 실제 무게: 작업장은 작업 전체의 실제 무게를 한 번만 입력하므로, 그 무게를 절단서 줄의 예상 무게 비율로 나눈다.
  // (예상 무게가 하나도 없는 작업은 길이 비율로 나눈다.) 실제 무게가 입력된 작업만 센다. 줄별 합계는 작업의 실제 무게와 같다.
  const orderLen = new Map<number, number>();
  for (const r of barItemRows) orderLen.set(r.order_id, (orderLen.get(r.order_id) ?? 0) + r.m);
  const barMap = new Map<string, { bar_name: string; total_m: number; weight_kg: number; by_color: Record<string, number> }>();
  for (const r of barItemRows) {
    const kg = r.otw > 0 ? (r.aw * r.tw) / r.otw : (orderLen.get(r.order_id) ?? 0) > 0 ? (r.aw * r.m) / orderLen.get(r.order_id)! : 0;
    const b = barMap.get(r.bar_name) ?? { bar_name: r.bar_name, total_m: 0, weight_kg: 0, by_color: {} };
    b.total_m += r.m;
    b.weight_kg += kg;
    b.by_color[r.color] = (b.by_color[r.color] ?? 0) + kg;
    barMap.set(r.bar_name, b);
  }
  const allBars = [...barMap.values()].sort((a, b) => b.weight_kg - a.weight_kg || b.total_m - a.total_m || a.bar_name.localeCompare(b.bar_name));
  const bars = allBars.slice(0, 30);
  const weightByBucket = new Map<string, Record<string, number>>();
  for (const r of weightColorRows) weightByBucket.set(r.bucket, { ...(weightByBucket.get(r.bucket) ?? {}), [r.color]: r.weight });

  const byBucketOrders = new Map(orderRows.map((r) => [r.bucket, r]));
  const byBucketUsage = new Map(usageRows.map((r) => [r.bucket, r]));
  const series = labels.map((label) => {
    const o = byBucketOrders.get(label);
    const u = byBucketUsage.get(label);
    return {
      label,
      orders: o?.orders ?? 0,
      weight: o?.weight ?? 0,
      weight_by_color: weightByBucket.get(label) ?? {},
      amount: o?.amount ?? 0,
      make_cost: o?.make_cost ?? 0,
      cut_amount: o?.cut_amount ?? 0,
      make_amount: o?.make_amount ?? 0,
      usage_m: u?.m ?? 0,
    };
  });
  const sum = (f: (s: (typeof series)[number]) => number) => series.reduce((a, s) => a + f(s), 0);
  return c.json({
    mode,
    key,
    series,
    totals: {
      orders: sum((s) => s.orders),
      weight: sum((s) => s.weight),
      amount: sum((s) => s.amount),
      make_cost: sum((s) => s.make_cost),
      cut_amount: sum((s) => s.cut_amount),
      make_amount: sum((s) => s.make_amount),
      usage_m: sum((s) => s.usage_m),
      bar_kinds: allBars.length,
      paid: status[0]?.paid ?? 0,
      unpaid: status[0]?.unpaid ?? 0,
      make_cost_missing: status[0]?.make_cost_missing ?? 0,
    },
    bars,
    companies_by_count: byCount,
    companies_by_weight: byWeight,
  });
});
