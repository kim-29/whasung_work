import { Hono } from 'hono';
import { z } from 'zod';
import { adminOnly } from './auth';
import { PRICE_SQL, audit } from './orders-service';
import type { AppEnv } from './types';

// 데이터 보관(관리자 전용): 전체 백업, 거래 장부(CSV), 오래된 도면 보관·정리.
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
      note: '화성 알루미늄 전체 데이터 백업. 3D 도면(HTML)은 포함되지 않는다(도면 보관 기능으로 따로 내려받는다).',
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

// ---------- 오래된 도면 보관·정리 ----------
export const archive = new Hono<AppEnv>();
archive.use('*', adminOnly);

archive.get('/summary', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT drawing_key) AS drawings, SUM(drawing_archived_at IS NOT NULL) AS archived_orders FROM orders`,
  ).first<{ drawings: number; archived_orders: number | null }>();
  return c.json({ drawings: r?.drawings ?? 0, archived_orders: r?.archived_orders ?? 0 });
});

const monthsOf = (v: string | undefined) => Math.min(120, Math.max(1, Math.floor(Number(v) || 12)));

// 보관 대상: 그 도면을 쓰는 작업이 모두 완납이고, 마지막 납입이 N개월보다 오래된 도면 (같은 지시서에서 나뉜 작업은 도면을 같이 쓴다)
async function candidates(env: AppEnv['Bindings'], months: number) {
  const { results } = await env.DB.prepare(
    `SELECT drawing_key AS key, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(DISTINCT company) AS companies,
            GROUP_CONCAT(DISTINCT color) AS colors, GROUP_CONCAT(DISTINCT kind) AS kinds,
            MIN(date(created_at, '+9 hours')) AS ordered, MAX(date(paid_at, '+9 hours')) AS last_paid, COUNT(*) AS orders
       FROM orders WHERE drawing_key IS NOT NULL
      GROUP BY drawing_key
     HAVING SUM(status != 'paid') = 0 AND MAX(paid_at) < datetime('now', ?1)
      ORDER BY MIN(created_at), drawing_key LIMIT 300`,
  )
    .bind(`-${months} months`)
    .all<{ key: string; ids: string; companies: string; colors: string; kinds: string; ordered: string; last_paid: string; orders: number }>();
  return results.map((r) => ({ ...r, ids: r.ids.split(',').map(Number) }));
}

archive.get('/candidates', async (c) => c.json(await candidates(c.env, monthsOf(c.req.query('months')))));

// 도면 파일 하나 내려받기 (보관 대상이거나 최소한 서버에 있는 도면 키만 허용)
archive.get('/file', async (c) => {
  const key = c.req.query('key') ?? '';
  const known = await c.env.DB.prepare(`SELECT 1 AS x FROM orders WHERE drawing_key = ?1 LIMIT 1`).bind(key).first();
  if (!known) return c.json({ error: '도면을 찾을 수 없습니다.' }, 404);
  const obj = await c.env.KV.get(key, 'stream');
  if (!obj) return c.json({ error: '도면 파일이 서버에 없습니다.' }, 404);
  return new Response(obj, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
});

// 정리: 관리자가 내려받은 파일의 sha256 이 서버에 있는 파일과 같을 때만, 그리고 지금도 보관 대상일 때만 서버에서 지운다.
archive.post('/commit', async (c) => {
  const body = z
    .object({
      months: z.number().int().min(1).max(120),
      items: z.array(z.object({ key: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(100),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '정리할 도면 정보가 올바르지 않습니다.' }, 400);
  const eligible = new Map((await candidates(c.env, body.data.months)).map((x) => [x.key, x]));
  const user = c.get('user');
  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const it of body.data.items) {
    const target = eligible.get(it.key);
    if (!target) {
      results.push({ key: it.key, ok: false, error: '지금은 보관 대상이 아닙니다 (미납이 있거나 기간이 지나지 않음).' });
      continue;
    }
    const bytes = await c.env.KV.get(it.key, 'arrayBuffer');
    if (!bytes) {
      results.push({ key: it.key, ok: false, error: '서버에 도면 파일이 없습니다.' });
      continue;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== it.sha256) {
      results.push({ key: it.key, ok: false, error: '내려받은 파일이 서버 파일과 다릅니다. 지우지 않았습니다.' });
      continue;
    }
    await c.env.DB.prepare(`UPDATE orders SET drawing_key = NULL, drawing_archived_at = datetime('now') WHERE drawing_key = ?1`).bind(it.key).run();
    await c.env.KV.delete(it.key);
    await audit(c.env, user.name, 'archive-drawing', target.ids[0], { key: it.key, orders: target.ids, bytes: bytes.byteLength });
    results.push({ key: it.key, ok: true });
  }
  return c.json({ results, archived: results.filter((r) => r.ok).length });
});
