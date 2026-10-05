import { z } from 'zod';
import type { Env } from './types';

export const itemSchema = z.object({
  bar_name: z.string().min(1).max(60),
  length_mm: z.number().int().positive().max(20000),
  qty: z.number().int().positive().max(10000),
  color: z.string().max(30).optional().default(''),
});

export const orderInputSchema = z.object({
  company: z.string().min(1, '업체명을 입력해 주세요.').max(60),
  kind: z.enum(['cut', 'make']),
  content: z.string().max(2000).optional().default(''),
  request_note: z.string().max(2000).optional().default(''),
  items: z.array(itemSchema).min(1, '절단서를 한 줄 이상 입력해 주세요.').max(300),
});
export type OrderInput = z.infer<typeof orderInputSchema>;

/** 이론무게(kg) = kg/m × 길이(mm)/1000 × 수량 */
export const theoryWeight = (kgPerM: number, lengthMm: number, qty: number) =>
  Math.round(kgPerM * (lengthMm / 1000) * qty * 1000) / 1000;

interface CreateOpts {
  source: 'front' | 'blender' | 'manual';
  createdBy: string;
  drawingKey?: string | null;
  /** 수기(작업장 직접 절단) 건: 실측무게를 함께 받으면 바로 미납 처리 */
  actualWeight?: number;
}

export async function createOrder(env: Env, input: OrderInput, opts: CreateOpts) {
  const { results: bars } = await env.DB.prepare(`SELECT name, kg_per_m FROM bar_database`).all<{
    name: string;
    kg_per_m: number;
  }>();
  const rate = new Map(bars.map((b) => [b.name, b.kg_per_m]));

  let total = 0;
  let unknown = 0;
  const rows = input.items.map((it) => {
    const kg = rate.get(it.bar_name);
    if (kg === undefined) unknown = 1;
    const w = kg === undefined ? 0 : theoryWeight(kg, it.length_mm, it.qty);
    total += w;
    return { ...it, kg_per_m: kg ?? null, theory_weight: w };
  });
  total = Math.round(total * 1000) / 1000;

  const done = opts.actualWeight !== undefined;
  const status = done ? 'unpaid' : 'pending';

  const head = await env.DB.prepare(
    `INSERT INTO orders (company, kind, content, request_note, drawing_key, status, source,
                         has_unknown_bar, theory_weight, actual_weight, created_by, completed_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, CASE WHEN ?6 = 'unpaid' THEN datetime('now') END)`,
  )
    .bind(
      input.company, input.kind, input.content, input.request_note, opts.drawingKey ?? null,
      status, opts.source, unknown, total, opts.actualWeight ?? null, opts.createdBy,
    )
    .run();
  const orderId = head.meta.last_row_id;

  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO work_list (order_id, bar_name, length_mm, qty, color, kg_per_m, theory_weight)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      ).bind(orderId, r.bar_name, r.length_mm, r.qty, r.color, r.kg_per_m, r.theory_weight),
    ),
  );
  return { id: orderId, theory_weight: total, has_unknown_bar: !!unknown, status };
}

/** 절단서 행 전체 교체 (납입 전 수정용). 이론무게·미등록 바 표시를 다시 계산한다. */
export async function replaceItems(env: Env, orderId: number, items: OrderInput['items']) {
  const { results: bars } = await env.DB.prepare(`SELECT name, kg_per_m FROM bar_database`).all<{
    name: string;
    kg_per_m: number;
  }>();
  const rate = new Map(bars.map((b) => [b.name, b.kg_per_m]));
  let total = 0;
  let unknown = 0;
  const stmts = [env.DB.prepare(`DELETE FROM work_list WHERE order_id = ?1`).bind(orderId)];
  for (const it of items) {
    const kg = rate.get(it.bar_name);
    if (kg === undefined) unknown = 1;
    const w = kg === undefined ? 0 : theoryWeight(kg, it.length_mm, it.qty);
    total += w;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO work_list (order_id, bar_name, length_mm, qty, color, kg_per_m, theory_weight)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      ).bind(orderId, it.bar_name, it.length_mm, it.qty, it.color, kg ?? null, w),
    );
  }
  total = Math.round(total * 1000) / 1000;
  stmts.push(
    env.DB.prepare(`UPDATE orders SET theory_weight = ?1, has_unknown_bar = ?2 WHERE id = ?3`).bind(total, unknown, orderId),
  );
  await env.DB.batch(stmts);
}

export async function audit(env: Env, userName: string, action: string, orderId: number | null, detail: unknown) {
  await env.DB.prepare(`INSERT INTO audit_log (user_name, action, order_id, detail) VALUES (?1,?2,?3,?4)`)
    .bind(userName, action, orderId, JSON.stringify(detail))
    .run();
}
