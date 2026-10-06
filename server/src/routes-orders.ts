import { Hono } from 'hono';
import { z } from 'zod';
import { adminOnly, anyUser, frontOnly } from './auth';
import { hmacHex, timingSafeEqual } from './crypto';
import { getDrawing, putDrawing } from './drawings-store';
import { notify } from './hub';
import { MAKE_ONE_COLOR, PRICE_SQL, audit, checkMakeOneColor, createOrder, orderBaseSchema, replaceItems } from './orders-service';
import type { AppEnv } from './types';

export const orders = new Hono<AppEnv>();

interface OrderRow {
  id: number;
  status: 'pending' | 'making' | 'unpaid' | 'paid';
  kind: 'cut' | 'make';
  company: string;
  actual_weight: number | null;
  drawing_key: string | null;
}

const getOrder = (c: { env: AppEnv['Bindings'] }, id: number) =>
  c.env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(id).first<OrderRow>();

// 목록: 작업장은 진행 중(대기/제작중) 오더만 본다
orders.get('/', anyUser, async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (user.role === 'workshop') where.push(`status IN ('pending','making')`);
  else if (q.status) {
    where.push(`status = ?${args.push(q.status)}`);
  }
  if (q.company) where.push(`company LIKE ?${args.push(`%${q.company}%`)}`);
  const sql = `SELECT id, company, kind, status, source, color, group_id, has_unknown_bar, theory_weight, actual_weight,
                      drawing_key IS NOT NULL AS has_drawing, created_at, completed_at, paid_at
                 FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY id DESC LIMIT 200`;
  const { results } = await c.env.DB.prepare(sql).bind(...args).all();
  return c.json(results);
});

orders.get('/:id', anyUser, async (c) => {
  const id = Number(c.req.param('id'));
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  if (c.get('user').role === 'workshop' && !['pending', 'making'].includes(order.status)) {
    return c.json({ error: '권한이 없습니다.' }, 403);
  }
  const { results: items } = await c.env.DB.prepare(
    `SELECT id, bar_name, length_mm, qty, color, theory_weight FROM work_list WHERE order_id = ?1 ORDER BY id`,
  )
    .bind(id)
    .all();
  if (c.get('user').role === 'workshop') {
    const { make_cost: _hidden, ...safe } = order as typeof order & { make_cost?: number | null };
    return c.json({ ...safe, items }); // 작업장에는 금액·제작비용을 보여주지 않는다
  }
  // 금액은 저장하지 않고, 지시일 기준 단가로 계산해서 내려준다
  const priced = await c.env.DB.prepare(
    `SELECT ${PRICE_SQL} AS price_per_kg FROM orders o WHERE o.id = ?1`,
  )
    .bind(id)
    .first<{ price_per_kg: number | null }>();
  const price = priced?.price_per_kg ?? null;
  const amount = price != null && order.actual_weight != null ? Math.round(order.actual_weight * price) : null;
  return c.json({ ...order, items, price_per_kg: price, amount });
});

// 삭제(관리자 전용). 같은 지시서가 도면을 공유하므로 마지막 오더가 지워질 때만 도면 파일도 지운다.
orders.delete('/:id', adminOnly, async (c) => {
  const id = Number(c.req.param('id'));
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  await c.env.DB.prepare(`DELETE FROM work_list WHERE order_id = ?1`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM orders WHERE id = ?1`).bind(id).run();
  if (order.drawing_key) {
    const shared = await c.env.DB.prepare(`SELECT 1 AS x FROM orders WHERE drawing_key = ?1`).bind(order.drawing_key).first();
    if (!shared) await c.env.KV.delete(order.drawing_key);
  }
  const user = c.get('user');
  await audit(c.env, user.name, 'delete', id, {
    company: order.company, status: order.status, actual_weight: order.actual_weight,
  });
  await notify(c.env, {
    type: 'order_updated', orderId: id, company: order.company,
    message: `작업 삭제: ${order.company}`, roles: ['admin', 'staff'],
  });
  return c.json({ ok: true });
});

// 작업지시서 전송 (직접 접수). manual_weight가 있으면 작업장 수기 건으로 바로 미납 처리
orders.post('/', frontOnly, async (c) => {
  const body = orderBaseSchema
    .extend({ manual_weight: z.number().positive().max(100000).optional() })
    .superRefine(checkMakeOneColor)
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  const { manual_weight, ...input } = body.data;
  const user = c.get('user');
  const r = await createOrder(c.env, input, {
    source: manual_weight ? 'manual' : 'front',
    createdBy: user.name,
    actualWeight: manual_weight,
  });
  await audit(c.env, user.name, 'create', r.id, { company: input.company, kind: input.kind });
  await notify(c.env, {
    type: 'order_created', orderId: r.id, company: input.company,
    message: `새 작업지시: ${input.company}`,
    roles: manual_weight ? ['admin', 'staff'] : undefined,
    // 작업장으로 보내는 작업만 작업장에 알린다 (수기 접수는 이미 끝난 건이라 알리지 않음)
    alertRoles: manual_weight ? [] : ['workshop'],
  });
  return c.json(r, 201);
});

// 납입 전 수정: 업체명/내용/요구사항/무게/절단서
orders.patch('/:id', frontOnly, async (c) => {
  const id = Number(c.req.param('id'));
  const body = orderBaseSchema
    .partial()
    .extend({
      actual_weight: z.number().positive().max(100000).optional(),
      // 제작비용(원): 숫자로 입력, null 이면 '미입력'으로 되돌린다
      make_cost: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  if (order.status === 'paid') return c.json({ error: '완납된 오더는 수정할 수 없습니다.' }, 409);

  const { items, company, request_note, actual_weight, kind, make_cost } = body.data;
  if (make_cost != null && (kind ?? order.kind) !== 'make') {
    return c.json({ error: '제작비용은 제작 작업에만 입력할 수 있습니다.' }, 400);
  }
  // 오더 하나에는 색상 하나만 둘 수 있다 (색상이 다르면 새 작업지시서로 나눈다)
  if (items && new Set(items.map((i) => i.color)).size > 1) return c.json({ error: MAKE_ONE_COLOR.replace('제작 작업은', '수정할 때는') }, 400);
  await c.env.DB.prepare(
    `UPDATE orders SET company = COALESCE(?1, company),
            request_note = COALESCE(?2, request_note), actual_weight = COALESCE(?3, actual_weight),
            kind = COALESCE(?4, kind)
      WHERE id = ?5`,
  )
    .bind(company ?? null, request_note ?? null, actual_weight ?? null, kind ?? null, id)
    .run();
  if (company) await c.env.DB.prepare(`INSERT OR IGNORE INTO companies (name) VALUES (?1)`).bind(company).run();
  if (items) await replaceItems(c.env, id, items);
  // 제작비용: 값을 보냈으면 그대로 저장(null 은 미입력), 절단으로 바꾸면 제작비용은 지운다
  if (kind === 'cut') {
    await c.env.DB.prepare(`UPDATE orders SET make_cost = NULL WHERE id = ?1`).bind(id).run();
  } else if (make_cost !== undefined) {
    await c.env.DB.prepare(`UPDATE orders SET make_cost = ?1 WHERE id = ?2`).bind(make_cost, id).run();
  }
  // 절단이 끝나 미납이 된 건을 제작으로 바꾸면: 절단은 끝난 상태(무게 유지)로 작업장의 '제작중'으로 보내고 미납에서는 빠진다
  const toMake = kind === 'make' && order.kind === 'cut' && order.status === 'unpaid';
  if (toMake) {
    await c.env.DB.prepare(`UPDATE orders SET status = 'making', completed_at = NULL WHERE id = ?1 AND status = 'unpaid'`).bind(id).run();
  }
  // 제작중인 건을 절단으로 바꾸면 절단은 이미 끝난 것이므로(무게 입력됨) 바로 미납으로 보낸다
  const toCut = kind === 'cut' && order.kind === 'make' && order.status === 'making';
  if (toCut) {
    await c.env.DB.prepare(`UPDATE orders SET status = 'unpaid', completed_at = datetime('now') WHERE id = ?1 AND status = 'making'`).bind(id).run();
  }
  const user = c.get('user');
  // 무게·제작비용을 고친 경우 수정 전 값도 이력에 남긴다
  await audit(c.env, user.name, 'update', id, {
    ...body.data,
    ...(actual_weight !== undefined ? { previous_weight: order.actual_weight } : {}),
    ...(toMake ? { status_change: 'unpaid→making' } : {}),
    ...(toCut ? { status_change: 'making→unpaid' } : {}),
    ...(make_cost !== undefined ? { previous_make_cost: (order as { make_cost?: number | null }).make_cost ?? null } : {}),
  });
  await notify(c.env, {
    type: 'order_updated', orderId: id, company: company ?? order.company,
    message: toMake ? `절단 완료 건을 제작으로 변경: ${company ?? order.company}` : `작업지시 수정: ${company ?? order.company}`,
    // 제작으로 넘어간 건은 작업장에 새 작업으로 알린다
    alertRoles: toMake ? ['workshop'] : undefined,
  });
  return c.json({ ok: true });
});

// 무게 입력(작업장/프론트). 절단작업은 바로 미납, 제작작업은 제작중으로 넘어간다
orders.post('/:id/weight', anyUser, async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ weight: z.number().positive().max(100000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '무게를 숫자로 입력해 주세요.' }, 400);
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  if (order.status !== 'pending') return c.json({ error: '이미 무게가 입력된 오더입니다.' }, 409);

  const next = order.kind === 'cut' ? 'unpaid' : 'making';
  await c.env.DB.prepare(
    `UPDATE orders SET actual_weight = ?1, status = ?2, cut_done_at = datetime('now'),
            completed_at = CASE WHEN ?2 = 'unpaid' THEN datetime('now') END
      WHERE id = ?3`,
  )
    .bind(body.data.weight, next, id)
    .run();
  const user = c.get('user');
  await audit(c.env, user.name, 'weight', id, { weight: body.data.weight });
  await notify(c.env, {
    type: next === 'unpaid' ? 'order_completed' : 'weight_entered',
    orderId: id, company: order.company,
    message: next === 'unpaid'
      ? `절단 완료: ${order.company} (${body.data.weight}kg)`
      : `절단 완료, 제작 진행 중: ${order.company} (${body.data.weight}kg)`,
    // 작업장이 입력했을 때만 프론트에 알린다 (프론트가 직접 입력하면 조용히 반영)
    alertRoles: user.role === 'workshop' ? ['admin', 'staff'] : [],
  });
  return c.json({ status: next });
});

// 제작 완료
orders.post('/:id/complete', anyUser, async (c) => {
  const id = Number(c.req.param('id'));
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  if (order.kind !== 'make' || order.status !== 'making') {
    return c.json({ error: '제작 중인 오더가 아닙니다.' }, 409);
  }
  await c.env.DB.prepare(`UPDATE orders SET status = 'unpaid', completed_at = datetime('now') WHERE id = ?1`).bind(id).run();
  const user = c.get('user');
  await audit(c.env, user.name, 'complete', id, {});
  await notify(c.env, {
    type: 'order_completed', orderId: id, company: order.company,
    message: `제작 완료: ${order.company}`,
    alertRoles: user.role === 'workshop' ? ['admin', 'staff'] : [],
  });
  return c.json({ status: 'unpaid' });
});

// 묶음 납입: 선택한 미납 작업들을 한 번에 완납 처리 (하나라도 미납이 아니면 아무것도 바꾸지 않는다)
orders.post('/pay-batch', frontOnly, async (c) => {
  const body = z
    .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '납입할 작업을 선택해 주세요.' }, 400);
  const ids = [...new Set(body.data.ids)];
  const { results } = await c.env.DB.prepare(
    `SELECT id, status, company FROM orders WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`,
  )
    .bind(...ids)
    .all<{ id: number; status: string; company: string }>();
  if (results.length !== ids.length) return c.json({ error: '찾을 수 없는 작업이 섞여 있습니다.' }, 404);
  if (results.some((r) => r.status !== 'unpaid')) {
    return c.json({ error: '미납이 아닌 작업이 섞여 있습니다. 목록을 새로고침해 주세요.' }, 409);
  }
  await c.env.DB.batch(
    ids.map((id) => c.env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?1 AND status = 'unpaid'`).bind(id)),
  );
  const user = c.get('user');
  const companies = [...new Set(results.map((r) => r.company))];
  await audit(c.env, user.name, 'pay-batch', null, { ids, companies });
  await notify(c.env, {
    type: 'order_paid', orderId: ids[0], company: companies.join(', '),
    message: `납입 완료 ${ids.length}건: ${companies.join(', ')}`, roles: ['admin', 'staff'],
  });
  return c.json({ paid: ids.length });
});

// 납입(완납 처리)
orders.post('/:id/pay', frontOnly, async (c) => {
  const id = Number(c.req.param('id'));
  const order = await getOrder(c, id);
  if (!order) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  if (order.status !== 'unpaid') return c.json({ error: '미납 상태의 오더만 납입 처리할 수 있습니다.' }, 409);
  await c.env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?1`).bind(id).run();
  const user = c.get('user');
  await audit(c.env, user.name, 'pay', id, {});
  await notify(c.env, {
    type: 'order_paid', orderId: id, company: order.company,
    message: `납입 완료: ${order.company}`, roles: ['admin', 'staff'],
  });
  return c.json({ status: 'paid' });
});

// 도면 업로드(HTML 원문 그대로)
orders.put('/:id/drawing', frontOnly, async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getOrder(c, id))) return c.json({ error: '오더를 찾을 수 없습니다.' }, 404);
  const html = await c.req.text();
  if (html.length > 10_000_000) return c.json({ error: '도면 파일이 너무 큽니다.' }, 413);
  return c.json({ key: await putDrawing(c.env, id, html) });
});

// 도면은 새 창에서 열리므로 인증 헤더를 못 보낸다 → 짧은 유효기간의 서명 링크를 발급
orders.get('/:id/drawing-link', anyUser, async (c) => {
  const id = Number(c.req.param('id'));
  const order = await getOrder(c, id);
  if (!order?.drawing_key) return c.json({ error: '도면이 없습니다.' }, 404);
  if (c.get('user').role === 'workshop' && !['pending', 'making'].includes(order.status)) {
    return c.json({ error: '권한이 없습니다.' }, 403);
  }
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = await hmacHex(c.env.PIN_PEPPER, `drawing.${id}.${exp}`);
  return c.json({ path: `/api/drawings/${id}?exp=${exp}&sig=${sig}` });
});

export const drawings = new Hono<AppEnv>();
drawings.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig') ?? '';
  const expected = await hmacHex(c.env.PIN_PEPPER, `drawing.${id}.${exp}`);
  if (!exp || exp < Date.now() / 1000 || !timingSafeEqual(sig, expected)) {
    return c.text('링크가 만료되었습니다. 다시 열어 주세요.', 403);
  }
  const body = await getDrawing(c.env, id);
  if (!body) return c.text('도면이 없습니다.', 404);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 도면 안의 스크립트가 앱 데이터에 접근하지 못하도록 격리
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  });
});
