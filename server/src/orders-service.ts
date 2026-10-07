import { z } from 'zod';
import type { Env } from './types';

export const COLORS = ['화이트', '블랙', '실버', '헨켈', '기타'] as const;
export type Color = (typeof COLORS)[number];

export const itemSchema = z.object({
  bar_name: z.string().min(1).max(60),
  length_mm: z.number().int().positive().max(20000),
  qty: z.number().int().positive().max(10000),
  color: z.enum(COLORS, { errorMap: () => ({ message: '색상을 선택해 주세요. (화이트, 블랙, 실버, 헨켈, 기타)' }) }),
});

/** 업체명 정리: 앞뒤 공백을 지우고 가운데 연속 공백은 하나로 (같은 업체가 공백 차이로 나뉘지 않게) */
export const normalizeCompany = (s: string) => s.replace(/\s+/g, ' ').trim();

export const orderBaseSchema = z.object({
  company: z.string().max(60).transform(normalizeCompany).pipe(z.string().min(1, '업체명을 입력해 주세요.')),
  kind: z.enum(['cut', 'make']),
  request_note: z.string().max(2000).optional().default(''),
  items: z.array(itemSchema).min(1, '절단서를 한 줄 이상 입력해 주세요.').max(300),
});

export const MAKE_ONE_COLOR = '제작 작업은 색상 하나만 입력할 수 있습니다. 색상이 다르면 작업지시서를 나누어 주세요.';

/** 제작 작업은 색상이 하나여야 한다 (절단은 섞여도 색상별로 나뉘어 저장된다) */
export const checkMakeOneColor = (
  v: { kind: 'cut' | 'make'; items: { color: string }[]; manual_weight?: number },
  ctx: z.RefinementCtx,
) => {
  const colors = new Set(v.items.map((i) => i.color)).size;
  if (v.kind === 'make' && colors > 1) ctx.addIssue({ code: 'custom', message: MAKE_ONE_COLOR, path: ['items'] });
  if (v.manual_weight && colors > 1) {
    ctx.addIssue({ code: 'custom', message: '수기 접수는 색상별로 나누어 따로 등록해 주세요.', path: ['items'] });
  }
};
export const orderInputSchema = orderBaseSchema.superRefine(checkMakeOneColor);
export type OrderInput = z.infer<typeof orderBaseSchema>;

/** 이론무게(kg) = kg/m × 길이(mm)/1000 × 수량 */
export const theoryWeight = (kgPerM: number, lengthMm: number, qty: number) =>
  Math.round(kgPerM * (lengthMm / 1000) * qty * 1000) / 1000;

/** 오더 적용 단가(원/kg) = 지시일 기준 색상 단가 + 오더에 고정된 추가 단가 (SQL 조각, 별칭 o = orders). 색상 단가가 없으면 NULL */
export const PRICE_SQL = `((SELECT p.price_per_kg FROM color_prices p
   WHERE p.color = o.color AND p.effective_from <= o.created_at
   ORDER BY p.effective_from DESC, p.id DESC LIMIT 1) + o.price_add)`;

/** 절단서에 들어 있는 바 중 가장 큰 추가 단가 (이 바가 하나라도 있으면 작업 전체 무게에 적용) */
const priceAddOf = (items: { bar_name: string }[], add: Map<string, number>) =>
  items.reduce((m, it) => Math.max(m, add.get(it.bar_name) ?? 0), 0);

interface CreateOpts {
  source: 'front' | 'blender' | 'manual';
  createdBy: string;
  /** 수기(작업장에서 이미 절단해 간) 건: 실측무게를 함께 받으면 바로 미납 처리. 색상이 하나일 때만 가능 */
  actualWeight?: number;
}

export interface CreatedOrder {
  id: number;
  color: string;
  theory_weight: number;
}

/** 색상별로 나누어 오더를 만든다. 나뉜 오더는 group_id(첫 오더의 id)로 묶인다. */
export async function createOrder(env: Env, input: OrderInput, opts: CreateOpts) {
  const { results: bars } = await env.DB.prepare(`SELECT name, kg_per_m, price_add FROM bar_database`).all<{
    name: string;
    kg_per_m: number;
    price_add: number;
  }>();
  const rate = new Map(bars.map((b) => [b.name, b.kg_per_m]));
  const addOf = new Map(bars.map((b) => [b.name, b.price_add]));

  const byColor = new Map<string, OrderInput['items']>();
  for (const it of input.items) byColor.set(it.color, [...(byColor.get(it.color) ?? []), it]);

  // 처음 보는 업체명은 업체 목록에 자동 등록한다 (이메일·전화는 설정의 업체 관리에서 채운다)
  await env.DB.prepare(`INSERT OR IGNORE INTO companies (name) VALUES (?1)`).bind(input.company).run();

  const done = opts.actualWeight !== undefined;
  const status = done ? 'unpaid' : 'pending';
  const created: CreatedOrder[] = [];
  let anyUnknown = false;
  let grand = 0;

  for (const [color, items] of byColor) {
    let total = 0;
    let unknown = 0;
    const rows = items.map((it) => {
      const kg = rate.get(it.bar_name);
      if (kg === undefined) unknown = 1;
      const w = kg === undefined ? 0 : theoryWeight(kg, it.length_mm, it.qty);
      total += w;
      return { ...it, kg_per_m: kg ?? null, theory_weight: w };
    });
    total = Math.round(total * 1000) / 1000;

    const head = await env.DB.prepare(
      `INSERT INTO orders (company, kind, request_note, status, source, color, group_id,
                           has_unknown_bar, theory_weight, actual_weight, created_by, price_add, completed_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12, CASE WHEN ?4 = 'unpaid' THEN datetime('now') END)`,
    )
      .bind(
        input.company, input.kind, input.request_note, status, opts.source, color,
        created[0]?.id ?? null, unknown, total, opts.actualWeight ?? null, opts.createdBy, priceAddOf(items, addOf),
      )
      .run();
    const orderId = head.meta.last_row_id;
    if (!created.length) {
      await env.DB.prepare(`UPDATE orders SET group_id = id WHERE id = ?1`).bind(orderId).run();
    }

    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          `INSERT INTO work_list (order_id, bar_name, length_mm, qty, color, kg_per_m, theory_weight)
           VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        ).bind(orderId, r.bar_name, r.length_mm, r.qty, r.color, r.kg_per_m, r.theory_weight),
      ),
    );
    created.push({ id: orderId, color, theory_weight: total });
    anyUnknown ||= !!unknown;
    grand += total;
  }
  return {
    id: created[0].id,
    ids: created.map((c) => c.id),
    orders: created,
    theory_weight: Math.round(grand * 1000) / 1000,
    has_unknown_bar: anyUnknown,
    status,
  };
}

/** 절단서 행 전체 교체 (납입 전 수정용). 이론무게·미등록 바 표시를 다시 계산한다. */
export async function replaceItems(env: Env, orderId: number, items: OrderInput['items']) {
  const { results: bars } = await env.DB.prepare(`SELECT name, kg_per_m, price_add FROM bar_database`).all<{
    name: string;
    kg_per_m: number;
    price_add: number;
  }>();
  const rate = new Map(bars.map((b) => [b.name, b.kg_per_m]));
  const addOf = new Map(bars.map((b) => [b.name, b.price_add]));
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
    env.DB.prepare(`UPDATE orders SET theory_weight = ?1, has_unknown_bar = ?2, color = ?3, price_add = ?4 WHERE id = ?5`).bind(
      total, unknown, items[0].color, priceAddOf(items, addOf), orderId,
    ),
  );
  await env.DB.batch(stmts);
}

export async function audit(env: Env, userName: string, action: string, orderId: number | null, detail: unknown) {
  await env.DB.prepare(`INSERT INTO audit_log (user_name, action, order_id, detail) VALUES (?1,?2,?3,?4)`)
    .bind(userName, action, orderId, JSON.stringify(detail))
    .run();
}
