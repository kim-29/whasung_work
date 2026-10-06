import { Hono } from 'hono';
import { z } from 'zod';
import { anyUser, frontOnly } from './auth';
import { timingSafeEqual } from './crypto';
import { putDrawing } from './drawings-store';
import { notify } from './hub';
import { COLORS, PRICE_SQL, audit, checkMakeOneColor, createOrder, normalizeCompany, orderBaseSchema } from './orders-service';
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

// ---------- 업체 정보 (이름·전화·이메일) ----------
export const companies = new Hono<AppEnv>();
companies.use('*', frontOnly);

const companySchema = z.object({
  name: z.string().max(60).transform(normalizeCompany).pipe(z.string().min(1, '업체명을 입력해 주세요.')),
  phone: z.string().trim().max(30).optional().default(''),
  email: z
    .string()
    .trim()
    .max(120)
    .optional()
    .default('')
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), '이메일 주소 형식이 올바르지 않습니다.'),
});

companies.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.email,
            (SELECT COUNT(*) FROM orders o WHERE o.company = c.name) AS order_count
       FROM companies c ORDER BY c.name`,
  ).all();
  return c.json(results);
});

companies.post('/', async (c) => {
  const body = companySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  const { name, phone, email } = body.data;
  if (await c.env.DB.prepare(`SELECT 1 AS x FROM companies WHERE name = ?1`).bind(name).first()) {
    return c.json({ error: '이미 등록된 업체입니다.' }, 409);
  }
  const r = await c.env.DB.prepare(`INSERT INTO companies (name, phone, email) VALUES (?1,?2,?3)`)
    .bind(name, phone || null, email || null)
    .run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

// 수정. 이름을 바꾸면 그 업체의 모든 작업의 업체명도 함께 바뀐다.
// 바꾼 이름이 이미 있는 업체면 두 업체를 합친다(작업을 모두 옮기고, 비어 있는 전화·이메일은 채운다).
companies.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = companySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  const { name, phone, email } = body.data;
  const cur = await c.env.DB.prepare(`SELECT id, name, phone, email FROM companies WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; name: string; phone: string | null; email: string | null }>();
  if (!cur) return c.json({ error: '업체를 찾을 수 없습니다.' }, 404);

  const other = name === cur.name
    ? null
    : await c.env.DB.prepare(`SELECT id, phone, email FROM companies WHERE name = ?1`)
        .bind(name)
        .first<{ id: number; phone: string | null; email: string | null }>();

  if (other) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE orders SET company = ?1 WHERE company = ?2`).bind(name, cur.name),
      c.env.DB.prepare(`UPDATE companies SET phone = COALESCE(NULLIF(?1, ''), phone), email = COALESCE(NULLIF(?2, ''), email) WHERE id = ?3`)
        .bind(phone || cur.phone || '', email || cur.email || '', other.id),
      c.env.DB.prepare(`DELETE FROM companies WHERE id = ?1`).bind(id),
    ]);
    return c.json({ merged: true, id: other.id });
  }
  const stmts = [
    c.env.DB.prepare(`UPDATE companies SET name = ?1, phone = ?2, email = ?3 WHERE id = ?4`).bind(name, phone || null, email || null, id),
  ];
  if (name !== cur.name) stmts.push(c.env.DB.prepare(`UPDATE orders SET company = ?1 WHERE company = ?2`).bind(name, cur.name));
  await c.env.DB.batch(stmts);
  return c.json({ merged: false, id });
});

// 작업이 하나도 없는 업체만 지울 수 있다 (거래 기록이 있는 업체는 이름 변경·합치기로 정리)
companies.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const cur = await c.env.DB.prepare(`SELECT name FROM companies WHERE id = ?1`).bind(id).first<{ name: string }>();
  if (!cur) return c.json({ error: '업체를 찾을 수 없습니다.' }, 404);
  const used = await c.env.DB.prepare(`SELECT 1 AS x FROM orders WHERE company = ?1 LIMIT 1`).bind(cur.name).first();
  if (used) return c.json({ error: '거래 기록이 있는 업체는 지울 수 없습니다. 다른 업체로 합치기를 이용해 주세요.' }, 409);
  await c.env.DB.prepare(`DELETE FROM companies WHERE id = ?1`).bind(id).run();
  return c.json({ ok: true });
});

// ---------- 대시보드 ----------
// 날짜 집계는 모두 한국 시간(UTC+9) 기준이다. 서버는 시각을 UTC 로 저장하므로 9시간을 더해서 날짜를 구한다.
export const dashboard = new Hono<AppEnv>();
dashboard.use('*', frontOnly);

// 미납 거래내역
dashboard.get('/unpaid', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.company, o.kind, o.color, o.group_id, o.created_at AS ordered_at, o.completed_at,
            o.actual_weight, o.has_unknown_bar, o.drawing_key IS NOT NULL AS has_drawing,
            ${PRICE_SQL} AS price_per_kg, ROUND(o.actual_weight * ${PRICE_SQL}) AS amount, o.make_cost
       FROM orders o WHERE o.status = 'unpaid' ORDER BY o.group_id, o.completed_at, o.id`,
  ).all();
  return c.json(results);
});

// 월간 거래내역: ?month=YYYY-MM (한국 시간 기준 지시일)
dashboard.get('/monthly', async (c) => {
  const month = c.req.query('month') ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: '월 형식이 올바르지 않습니다.' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.company, o.kind, o.color, o.status, o.actual_weight, o.created_at AS ordered_at,
            o.completed_at, o.paid_at, o.drawing_key IS NOT NULL AS has_drawing,
            ${PRICE_SQL} AS price_per_kg, ROUND(o.actual_weight * ${PRICE_SQL}) AS amount, o.make_cost
       FROM orders o WHERE strftime('%Y-%m', o.created_at, '+9 hours') = ?1 ORDER BY o.id DESC`,
  )
    .bind(month)
    .all();
  const summary = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(o.actual_weight),0) AS total_weight,
            COALESCE(SUM(ROUND(o.actual_weight * ${PRICE_SQL})),0) AS total_amount,
            COALESCE(SUM(o.make_cost),0) AS total_make_cost,
            SUM(o.kind = 'make' AND o.make_cost IS NULL) AS make_cost_missing,
            SUM(o.status = 'paid') AS paid_count, SUM(o.status = 'unpaid') AS unpaid_count
       FROM orders o WHERE strftime('%Y-%m', o.created_at, '+9 hours') = ?1`,
  )
    .bind(month)
    .first();
  return c.json({ month, summary, orders: results });
});

// 기간별 자재 사용내역(많이 쓴 순): ?from=YYYY-MM-DD&to=YYYY-MM-DD (한국 시간 기준 지시일)
dashboard.get('/usage', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01';
  const to = c.req.query('to') ?? '2999-12-31';
  const { results } = await c.env.DB.prepare(
    `SELECT w.bar_name, SUM(w.qty) AS total_qty, SUM(w.length_mm * w.qty) / 1000.0 AS total_m,
            SUM(w.theory_weight) AS theory_kg
       FROM work_list w JOIN orders o ON o.id = w.order_id
      WHERE date(o.created_at, '+9 hours') BETWEEN ?1 AND ?2
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
      `SELECT o.id, o.kind, o.color, o.group_id, o.created_at AS ordered_at, o.completed_at, o.actual_weight,
              ${PRICE_SQL} AS price_per_kg, ROUND(o.actual_weight * ${PRICE_SQL}) AS amount, o.make_cost
         FROM orders o WHERE o.status = 'unpaid' AND o.company = ?1 ORDER BY o.completed_at, o.id`,
    )
      .bind(company)
      .all();
    return c.json(results);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT o.company, COUNT(*) AS count, COALESCE(SUM(o.actual_weight),0) AS total_weight,
            COALESCE(SUM(ROUND(o.actual_weight * ${PRICE_SQL})),0) AS total_amount,
            COALESCE(SUM(o.make_cost),0) AS total_make_cost,
            SUM(o.kind = 'make' AND o.make_cost IS NULL) AS make_cost_missing,
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
