import { Hono } from 'hono';
import { z } from 'zod';
import { anyUser, frontOnly } from './auth';
import { timingSafeEqual } from './crypto';
import { putDrawing } from './drawings-store';
import { notify } from './hub';
import { COLORS, PRICE_SQL, audit, checkMakeOneColor, createOrder, orderBaseSchema } from './orders-service';
import type { AppEnv } from './types';

// ---------- bar_database ----------
export const bars = new Hono<AppEnv>();

bars.get('/', anyUser, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, kg_per_m, note FROM bar_database WHERE active = 1 ORDER BY name`,
  ).all();
  return c.json(results);
});

const barSchema = z.object({
  name: z.string().min(1).max(60),
  kg_per_m: z.number().positive().max(1000),
  note: z.string().max(200).optional().default(''),
});

bars.post('/', frontOnly, async (c) => {
  const body = barSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '바 이름과 미터당 무게(kg/m)를 확인해 주세요.' }, 400);
  const exists = await c.env.DB.prepare(`SELECT id, active FROM bar_database WHERE name = ?1`)
    .bind(body.data.name)
    .first<{ id: number; active: number }>();
  if (exists?.active) return c.json({ error: '이미 등록된 바 이름입니다.' }, 409);
  if (exists) {
    await c.env.DB.prepare(`UPDATE bar_database SET kg_per_m = ?1, note = ?2, active = 1 WHERE id = ?3`)
      .bind(body.data.kg_per_m, body.data.note, exists.id)
      .run();
    return c.json({ id: exists.id }, 201);
  }
  const r = await c.env.DB.prepare(`INSERT INTO bar_database (name, kg_per_m, note) VALUES (?1,?2,?3)`)
    .bind(body.data.name, body.data.kg_per_m, body.data.note)
    .run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

// 수정해도 기존 오더의 이론무게는 저장 시점 값 그대로 유지된다
bars.put('/:id', frontOnly, async (c) => {
  const body = barSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '바 이름과 미터당 무게(kg/m)를 확인해 주세요.' }, 400);
  try {
    await c.env.DB.prepare(`UPDATE bar_database SET name = ?1, kg_per_m = ?2, note = ?3 WHERE id = ?4`)
      .bind(body.data.name, body.data.kg_per_m, body.data.note, Number(c.req.param('id')))
      .run();
  } catch {
    return c.json({ error: '이미 등록된 바 이름입니다.' }, 409);
  }
  return c.json({ ok: true });
});

// 삭제는 목록에서만 숨긴다(과거 오더 보존)
bars.delete('/:id', frontOnly, async (c) => {
  await c.env.DB.prepare(`UPDATE bar_database SET active = 0 WHERE id = ?1`).bind(Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

// ---------- 색상별 단가 (kg당) ----------
export const prices = new Hono<AppEnv>();
prices.use('*', frontOnly);

// 색상별 현재 단가와 마지막 변경일
prices.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT color, price_per_kg, effective_from FROM color_prices p
      WHERE id = (SELECT id FROM color_prices WHERE color = p.color ORDER BY effective_from DESC, id DESC LIMIT 1)`,
  ).all<{ color: string; price_per_kg: number; effective_from: string }>();
  const by = new Map(results.map((r) => [r.color, r]));
  return c.json(COLORS.map((color) => by.get(color) ?? { color, price_per_kg: null, effective_from: null }));
});

// 단가 변경: 지금 이후에 지시되는 작업부터 새 단가가 적용된다. 처음 등록하는 단가는 기존 작업에도 적용한다.
prices.put('/', async (c) => {
  const body = z
    .object({ color: z.enum(COLORS), price_per_kg: z.number().min(0).max(10_000_000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '색상과 단가(숫자)를 확인해 주세요.' }, 400);
  const first = !(await c.env.DB.prepare(`SELECT 1 AS x FROM color_prices WHERE color = ?1`).bind(body.data.color).first());
  await c.env.DB.prepare(
    `INSERT INTO color_prices (color, price_per_kg, effective_from, changed_by)
     VALUES (?1, ?2, CASE WHEN ?3 THEN '1970-01-01 00:00:00' ELSE datetime('now') END, ?4)`,
  )
    .bind(body.data.color, body.data.price_per_kg, first ? 1 : 0, c.get('user').name)
    .run();
  return c.json({ ok: true });
});

// ---------- 대시보드 ----------
export const dashboard = new Hono<AppEnv>();
dashboard.use('*', frontOnly);

// 미납 거래내역
dashboard.get('/unpaid', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.company, o.kind, o.color, o.group_id, o.created_at AS ordered_at, o.completed_at,
            o.actual_weight, o.has_unknown_bar, o.drawing_key IS NOT NULL AS has_drawing,
            ROUND(o.actual_weight * ${PRICE_SQL}) AS amount
       FROM orders o WHERE o.status = 'unpaid' ORDER BY o.completed_at`,
  ).all();
  return c.json(results);
});

// 월간 거래내역: ?month=YYYY-MM
dashboard.get('/monthly', async (c) => {
  const month = c.req.query('month') ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: '월 형식이 올바르지 않습니다.' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT id, company, kind, color, status, actual_weight, created_at AS ordered_at, completed_at, paid_at
       FROM orders WHERE strftime('%Y-%m', created_at) = ?1 ORDER BY id DESC`,
  )
    .bind(month)
    .all();
  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(actual_weight),0) AS total_weight,
            SUM(status = 'paid') AS paid_count, SUM(status = 'unpaid') AS unpaid_count
       FROM orders WHERE strftime('%Y-%m', created_at) = ?1`,
  )
    .bind(month)
    .first();
  return c.json({ month, summary, orders: results });
});

// 기간별 자재 사용내역(많이 쓴 순): ?from=YYYY-MM-DD&to=YYYY-MM-DD
dashboard.get('/usage', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';
  const { results } = await c.env.DB.prepare(
    `SELECT w.bar_name, SUM(w.qty) AS total_qty, SUM(w.length_mm * w.qty) / 1000.0 AS total_m,
            SUM(w.theory_weight) AS theory_kg
       FROM work_list w JOIN orders o ON o.id = w.order_id
      WHERE date(o.created_at) BETWEEN ?1 AND ?2
      GROUP BY w.bar_name ORDER BY total_m DESC`,
  )
    .bind(from, to)
    .all();
  return c.json(results);
});

// 업체별 미납 명세: ?company= 없으면 업체별 합계, 있으면 해당 업체 건별 명세
dashboard.get('/by-company', async (c) => {
  const company = c.req.query('company');
  if (company) {
    const { results } = await c.env.DB.prepare(
      `SELECT o.id, o.kind, o.color, o.created_at AS ordered_at, o.completed_at, o.actual_weight,
              ROUND(o.actual_weight * ${PRICE_SQL}) AS amount
         FROM orders o WHERE o.status = 'unpaid' AND o.company = ?1 ORDER BY o.completed_at`,
    )
      .bind(company)
      .all();
    return c.json(results);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT o.company, COUNT(*) AS count, COALESCE(SUM(o.actual_weight),0) AS total_weight,
            COALESCE(SUM(ROUND(o.actual_weight * ${PRICE_SQL})),0) AS total_amount,
            SUM(${PRICE_SQL} IS NULL) AS unpriced
       FROM orders o WHERE o.status = 'unpaid' GROUP BY o.company ORDER BY o.company`,
  ).all();
  return c.json(results);
});

// ---------- Blender 전송 (API 키) ----------
export const ingest = new Hono<AppEnv>();

ingest.post('/blender', async (c) => {
  const key = c.req.header('X-API-Key') ?? '';
  if (!c.env.BLENDER_API_KEY || !timingSafeEqual(key, c.env.BLENDER_API_KEY)) {
    return c.json({ error: 'API 키가 올바르지 않습니다.' }, 401);
  }
  const body = orderBaseSchema
    .extend({ drawing_html: z.string().max(10_000_000).optional() })
    .superRefine(checkMakeOneColor)
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);

  const { drawing_html, ...input } = body.data;
  const r = await createOrder(c.env, input, { source: 'blender', createdBy: 'Blender' });
  if (drawing_html) await putDrawing(c.env, r.id, drawing_html);
  await audit(c.env, 'Blender', 'create', r.id, { company: input.company, kind: input.kind });
  await notify(c.env, {
    type: 'order_created', orderId: r.id, company: input.company,
    message: r.has_unknown_bar
      ? `새 작업지시(미등록 바 포함): ${input.company}`
      : `새 작업지시: ${input.company}`,
  });
  return c.json(r, 201);
});
