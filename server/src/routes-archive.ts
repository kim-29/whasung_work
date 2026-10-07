import { Hono } from 'hono';
import { z } from 'zod';
import { adminOnly } from './auth';
import { PRICE_SQL, audit } from './orders-service';
import type { AppEnv } from './types';

// 데이터 보관(관리자 전용): 전체 백업, 거래 장부(CSV), 오래된 도면 삭제(매일 00:00 KST 자동 + 수동).
export const backup = new Hono<AppEnv>();
backup.use('*', adminOnly);

const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 전체 데이터 백업(JSON). 복구용이다. 접속 기기 토큰·로그인 시도·푸시 구독은 넣지 않는다.
// PIN 은 암호화된 값(pin_hash)만 들어 있어 서버 비밀값(PIN_PEPPER)이 없으면 쓸 수 없지만, 업체 이메일 같은 개인정보가 있으므로 안전하게 보관해야 한다.
backup.get('/export', async (c) => {
  const tables = ['users', 'bar_database', 'color_prices', 'companies', 'orders', 'work_list', 'audit_log'] as const;
  const data: Record<string, unknown[]> = {};
  for (const t of tables) data[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  const body = JSON.stringify(
    {
      app: 'whasung',
      exported_at: new Date().toISOString(),
      note: '화성 알루미늄 전체 데이터 백업. 3D 도면(HTML)은 포함되지 않는다(완납 후 기간이 지나면 자동 삭제되는 데이터라 따로 받지 않는다).',
      counts: Object.fromEntries(tables.map((t) => [t, data[t].length])),
      tables: data,
    },
    null,
    1,
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="whasung-backup-${today()}.json"`,
      'Cache-Control': 'no-store',
    },
  });
});

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// 거래 장부(CSV, 엑셀용): 지시일(한국 시간)이 from~to 달 안에 있는 작업
backup.get('/ledger', async (c) => {
  const from = c.req.query('from') ?? '1970-01';
  const to = c.req.query('to') ?? '2999-12';
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return c.json({ error: '기간 형식이 올바르지 않습니다.' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, date(o.created_at, '+9 hours') AS ordered, date(o.completed_at, '+9 hours') AS completed,
            date(o.paid_at, '+9 hours') AS paid, o.company, o.kind, o.color, o.status, o.actual_weight,
            ${PRICE_SQL} AS price_per_kg, ROUND(o.actual_weight * ${PRICE_SQL}) AS amount, o.make_cost
       FROM orders o WHERE strftime('%Y-%m', o.created_at, '+9 hours') BETWEEN ?1 AND ?2 ORDER BY o.created_at, o.id`,
  )
    .bind(from, to)
    .all<Record<string, number | string | null>>();
  const status: Record<string, string> = { pending: '대기', making: '제작중', unpaid: '미납', paid: '완납' };
  const head = ['작업번호', '지시일', '완료일', '납입일', '업체', '구분', '색상', '상태', '무게(kg)', '단가(원/kg)', '금액(원)', '제작비용(원)', '합계(원)'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of results) {
    const make = r.kind === 'make' ? (r.make_cost as number | null) : null;
    const amount = r.amount as number | null;
    const total = amount == null && make == null ? null : (amount ?? 0) + (make ?? 0);
    lines.push(
      [r.id, r.ordered, r.completed, r.paid, r.company, r.kind === 'make' ? '제작' : '절단', r.color, status[r.status as string], r.actual_weight, r.price_per_kg, amount, make, total]
        .map(csvCell)
        .join(','),
    );
  }
  // 앞의 BOM(﻿)은 엑셀이 한글을 깨뜨리지 않고 열게 한다
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="whasung-ledger-${from}_${to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

// ---------- 오래된 도면 삭제 ----------
// 완납 후 지정한 기간(개월)이 지난 3D 도면은 백업 없이 서버(KV)에서 지운다. 작업 기록(업체·무게·금액)은 그대로 남고
// 작업에는 '도면 삭제됨' 표시(drawing_archived_at)만 남는다. 매일 00:00(한국 시간) 자동 실행(index.ts 의 scheduled)과 관리자의 수동 실행이 같은 함수를 쓴다.
export const archive = new Hono<AppEnv>();
archive.use('*', adminOnly);

const RETENTION_KEY = 'config:drawing_retention_months';
const LAST_RUN_KEY = 'config:drawing_purge_last';
export const DEFAULT_RETENTION_MONTHS = 12;
/** 한 번 실행에 지우는 최대 개수 (Workers 한 번 실행의 요청 수 제한 안에서 끝내려고). 자동 실행은 매일 돌므로 남은 것은 다음 날 이어서 지운다. */
const PURGE_BATCH = 40;

const clampMonths = (n: number) => Math.min(120, Math.max(1, Math.floor(n) || DEFAULT_RETENTION_MONTHS));

export async function getRetentionMonths(env: AppEnv['Bindings']) {
  return clampMonths(Number(await env.KV.get(RETENTION_KEY)));
}

// 삭제 대상: 그 도면을 쓰는 작업이 모두 완납이고, 마지막 납입이 N개월보다 오래된 도면 (같은 지시서에서 나뉜 작업은 도면을 같이 쓴다)
async function candidates(env: AppEnv['Bindings'], months: number, limit = 300) {
  const { results } = await env.DB.prepare(
    `SELECT drawing_key AS key, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(DISTINCT company) AS companies,
            GROUP_CONCAT(DISTINCT color) AS colors, GROUP_CONCAT(DISTINCT kind) AS kinds,
            MIN(date(created_at, '+9 hours')) AS ordered, MAX(date(paid_at, '+9 hours')) AS last_paid, COUNT(*) AS orders
       FROM orders WHERE drawing_key IS NOT NULL
      GROUP BY drawing_key
     HAVING SUM(status != 'paid') = 0 AND MAX(paid_at) < datetime('now', ?1)
      ORDER BY MIN(created_at), drawing_key LIMIT ?2`,
  )
    .bind(`-${months} months`, limit)
    .all<{ key: string; ids: string; companies: string; colors: string; kinds: string; ordered: string; last_paid: string; orders: number }>();
  return results.map((r) => ({ ...r, ids: r.ids.split(',').map(Number) }));
}

/** 대상 도면을 최대 PURGE_BATCH 개 지운다. 작업 표시를 먼저 바꾸고(실패해도 도면은 그대로) 그다음 파일을 지운다. */
export async function purgeOldDrawings(env: AppEnv['Bindings'], months: number, actor: string) {
  const list = await candidates(env, months, PURGE_BATCH);
  if (list.length) {
    await env.DB.batch([
      ...list.map((c) => env.DB.prepare(`UPDATE orders SET drawing_key = NULL, drawing_archived_at = datetime('now') WHERE drawing_key = ?1`).bind(c.key)),
      env.DB.prepare(`INSERT INTO audit_log (user_name, action, order_id, detail) VALUES (?1,'purge-drawings',NULL,?2)`).bind(
        actor,
        JSON.stringify({ months, drawings: list.length, orders: list.flatMap((c) => c.ids) }),
      ),
    ]);
    await Promise.allSettled(list.map((c) => env.KV.delete(c.key)));
  }
  const remaining = (await candidates(env, months, 1000)).length;
  return { deleted: list.length, remaining };
}

/** 매일 한국 시간 00:00 자동 실행(cron). 설정된 기간을 쓰고, 결과를 마지막 실행 기록으로 남긴다. 실패해도 예외를 밖으로 던지지 않는다. */
export async function runScheduledPurge(env: AppEnv['Bindings']) {
  try {
    const months = await getRetentionMonths(env);
    const r = await purgeOldDrawings(env, months, '자동(매일 00:00)');
    await env.KV.put(LAST_RUN_KEY, JSON.stringify({ at: new Date().toISOString(), months, deleted: r.deleted, remaining: r.remaining, auto: true }));
    return r;
  } catch (e) {
    console.error('scheduled purge failed', e);
    return null;
  }
}

archive.get('/summary', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT drawing_key) AS drawings, SUM(drawing_archived_at IS NOT NULL) AS archived_orders FROM orders`,
  ).first<{ drawings: number; archived_orders: number | null }>();
  const last = JSON.parse((await c.env.KV.get(LAST_RUN_KEY)) ?? 'null') as { at: string; months: number; deleted: number; auto?: boolean } | null;
  return c.json({
    drawings: r?.drawings ?? 0,
    archived_orders: r?.archived_orders ?? 0,
    months: await getRetentionMonths(c.env),
    last_run: last,
  });
});

// 삭제 기준 기간 저장 (자동 실행도 이 값을 쓴다)
archive.put('/settings', async (c) => {
  const body = z.object({ months: z.number().int().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '기간은 1~120개월 사이의 숫자로 입력해 주세요.' }, 400);
  await c.env.KV.put(RETENTION_KEY, String(body.data.months));
  await audit(c.env, c.get('user').name, 'drawing-retention', null, { months: body.data.months });
  return c.json({ months: body.data.months });
});

// 삭제 대상 미리 보기 (지우지 않는다)
archive.get('/candidates', async (c) => {
  const months = clampMonths(Number(c.req.query('months')) || (await getRetentionMonths(c.env)));
  return c.json(await candidates(c.env, months));
});

// 지금 삭제 (관리자 수동). 한 번에 PURGE_BATCH 개까지라 남은 것이 있으면 화면이 이어서 부른다.
archive.post('/purge', async (c) => {
  const body = z.object({ months: z.number().int().min(1).max(120).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: '기간이 올바르지 않습니다.' }, 400);
  const months = body.data.months ?? (await getRetentionMonths(c.env));
  const user = c.get('user');
  const r = await purgeOldDrawings(c.env, months, user.name);
  await c.env.KV.put(LAST_RUN_KEY, JSON.stringify({ at: new Date().toISOString(), months, deleted: r.deleted, auto: false }));
  return c.json({ ...r, months });
});
