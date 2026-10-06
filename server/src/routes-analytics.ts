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

  const [orderRows, usageRows, bars, byCount, byWeight, status] = await Promise.all([
    q<{ bucket: string; orders: number; weight: number; amount: number; make_cost: number }>(
      `SELECT ${bucket} AS bucket, COUNT(*) AS orders, COALESCE(SUM(o.actual_weight),0) AS weight,
              COALESCE(SUM(ROUND(o.actual_weight * ${PRICE_SQL})),0) AS amount,
              COALESCE(SUM(o.make_cost),0) AS make_cost
         FROM orders o WHERE ${inRange} GROUP BY bucket`,
    ),
    q<{ bucket: string; m: number; kg: number }>(
      `SELECT ${bucket} AS bucket, SUM(w.length_mm * w.qty) / 1000.0 AS m, SUM(w.theory_weight) AS kg
         FROM work_list w JOIN orders o ON o.id = w.order_id WHERE ${inRange} GROUP BY bucket`,
    ),
    q<{ bar_name: string; total_m: number; theory_kg: number }>(
      `SELECT w.bar_name, SUM(w.length_mm * w.qty) / 1000.0 AS total_m, SUM(w.theory_weight) AS theory_kg
         FROM work_list w JOIN orders o ON o.id = w.order_id WHERE ${inRange}
        GROUP BY w.bar_name ORDER BY total_m DESC, w.bar_name LIMIT 30`,
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

  const byBucketOrders = new Map(orderRows.map((r) => [r.bucket, r]));
  const byBucketUsage = new Map(usageRows.map((r) => [r.bucket, r]));
  const series = labels.map((label) => {
    const o = byBucketOrders.get(label);
    const u = byBucketUsage.get(label);
    return {
      label,
      orders: o?.orders ?? 0,
      weight: o?.weight ?? 0,
      amount: o?.amount ?? 0,
      make_cost: o?.make_cost ?? 0,
      usage_m: u?.m ?? 0,
      usage_kg: u?.kg ?? 0,
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
      usage_m: sum((s) => s.usage_m),
      usage_kg: sum((s) => s.usage_kg),
      bar_kinds: bars.length,
      paid: status[0]?.paid ?? 0,
      unpaid: status[0]?.unpaid ?? 0,
      make_cost_missing: status[0]?.make_cost_missing ?? 0,
    },
    bars,
    companies_by_count: byCount,
    companies_by_weight: byWeight,
  });
});
