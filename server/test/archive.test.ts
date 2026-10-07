import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  return SELF.fetch(`https://x${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
};
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const login = async (ip: string) =>
  (await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: '123456' }), headers: { 'CF-Connecting-IP': ip } })).json<{ token: string }>()).token;
describe('데이터 보관', () => {
  it('백업·장부는 관리자만 받을 수 있고, 민감한 항목은 들어가지 않는다', async () => {
    const t = await login('7.7.1.1');
    const staff = await (await send('POST', '/api/admin/users', { name: '보관테스트직원' }, t)).json<{ pin: string }>();
    const s = (await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: staff.pin }), headers: { 'CF-Connecting-IP': '7.7.1.2' } })).json<{ token: string }>()).token;
    expect((await call('/api/admin/backup/export', { token: s })).status).toBe(403);
    expect((await call('/api/admin/backup/export')).status).toBe(401);

    const res = await call('/api/admin/backup/export', { token: t });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('whasung-backup-');
    const data = await res.json<{ tables: Record<string, unknown[]>; counts: Record<string, number> }>();
    expect(Object.keys(data.tables).sort()).toEqual(['audit_log', 'bar_database', 'color_prices', 'companies', 'orders', 'users', 'work_list']);
    expect(data.counts.users).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain('token_hash'); // 기기 토큰은 넣지 않는다

    await send('POST', '/api/bars', { name: 'AR-A', kg_per_m: 1 }, t);
    await send('PUT', '/api/prices', { color: '블랙', price_per_kg: 2000 }, t);
    const o = await (await send('POST', '/api/orders', { company: '장부, "따옴표" 업체', kind: 'cut', items: [{ bar_name: 'AR-A', length_mm: 1000, qty: 1, color: '블랙' }] }, t)).json<{ id: number }>();
    await send('POST', `/api/orders/${o.id}/weight`, { weight: 5 }, t);
    const csv = await (await call(`/api/admin/backup/ledger?from=1970-01&to=2999-12`, { token: t })).text();
    expect(csv.startsWith('﻿작업번호,지시일')).toBe(true); // 엑셀에서 한글이 깨지지 않게 BOM
    expect(csv).toContain('"장부, ""따옴표"" 업체"'); // 쉼표·따옴표가 있어도 칸이 어긋나지 않는다
    expect(csv).toContain(',5,2000,10000,,10000'); // 무게 5kg × 2,000원 = 10,000원
    expect((await call('/api/admin/backup/ledger?from=2026-1&to=x', { token: t })).status).toBe(400);
  });

  it('도면 삭제: 완납·기간을 모두 만족할 때만 백업 없이 지우고, 표시는 남긴다. 기간 설정과 자동 실행(cron)도 같다', async () => {
    const t = await login('7.7.2.1');
    await send('POST', '/api/bars', { name: 'AR-B', kg_per_m: 1 }, t);
    const html = '<html><body>삭제 시험 도면 ✓</body></html>';
    const ingest = async (colors: string[]) =>
      (await (await call('/api/ingest/blender', {
        method: 'POST',
        headers: { 'X-API-Key': 'test-key' },
        body: JSON.stringify({ company: '삭제업체', kind: 'cut', drawing_html: html, items: colors.map((color) => ({ bar_name: 'AR-B', length_mm: 1000, qty: 1, color })) }),
      })).json<{ ids: number[] }>()).ids;
    const [solo] = await ingest(['화이트']);
    const pair = await ingest(['화이트', '블랙']); // 같은 지시서에서 나뉜 두 작업은 도면 하나를 같이 쓴다
    for (const id of [solo, ...pair]) await send('POST', `/api/orders/${id}/weight`, { weight: 1 }, t);
    const key = (await (await call(`/api/orders/${solo}`, { token: t })).json<{ drawing_key: string }>()).drawing_key;
    const pairKey = (await (await call(`/api/orders/${pair[0]}`, { token: t })).json<{ drawing_key: string }>()).drawing_key;

    const cands = async (months = 12) => (await (await call(`/api/admin/archive/candidates?months=${months}`, { token: t })).json<{ key: string; ids: number[] }[]>()).map((x) => x.key);
    expect(await cands()).not.toContain(key); // 아직 미납
    await send('POST', `/api/orders/${solo}/pay`, {}, t);
    expect(await cands()).not.toContain(key); // 납입한 지 얼마 안 됨(12개월 미만)
    await env.DB.prepare(`UPDATE orders SET paid_at = datetime('now', '-13 months') WHERE id = ?1`).bind(solo).run();
    expect(await cands()).toContain(key);
    expect(await cands(24)).not.toContain(key); // 기준 개월 수를 늘리면 대상에서 빠진다

    // 묶음은 둘 다 완납이어야 대상이 된다
    await send('POST', `/api/orders/${pair[0]}/pay`, {}, t);
    await env.DB.prepare(`UPDATE orders SET paid_at = datetime('now', '-13 months') WHERE id = ?1`).bind(pair[0]).run();
    expect(await cands()).not.toContain(pairKey);
    await send('POST', `/api/orders/${pair[1]}/pay`, {}, t);
    await env.DB.prepare(`UPDATE orders SET paid_at = datetime('now', '-13 months') WHERE id = ?1`).bind(pair[1]).run();
    expect(await cands()).toContain(pairKey);

    // 기간 설정: 저장하면 요약에 나오고, 범위를 벗어나면 거절
    expect((await send('PUT', '/api/admin/archive/settings', { months: 0 }, t)).status).toBe(400);
    expect((await send('PUT', '/api/admin/archive/settings', { months: 24 }, t)).status).toBe(200);
    expect((await (await call('/api/admin/archive/summary', { token: t })).json<{ months: number }>()).months).toBe(24);
    // 기간이 24개월이면 13개월 된 도면은 자동 실행(cron)이 지우지 않는다
    await SELF.scheduled({ scheduledTime: Date.now(), cron: '0 15 * * *' } as never);
    // 자동 실행이 끝났다는 기록(마지막 실행)이 생길 때까지 기다린 뒤 확인한다
    await vi.waitFor(async () => expect((await (await call('/api/admin/archive/summary', { token: t })).json<{ last_run: unknown }>()).last_run).not.toBeNull(), { timeout: 8000 });
    expect(await env.KV.get(key)).toBe(html);
    // 수동 삭제에 기간을 직접 주면 그 기간이 우선한다 (24개월 → 아무것도 안 지움)
    const none = await (await send('POST', '/api/admin/archive/purge', { months: 24 }, t)).json<{ deleted: number }>();
    expect(none.deleted).toBe(0);

    // 기간을 12개월로 되돌린 뒤 자동 실행: 서버(KV)에서 지우고 작업에는 '삭제됨' 표시만 남긴다
    await send('PUT', '/api/admin/archive/settings', { months: 12 }, t);
    await SELF.scheduled({ scheduledTime: Date.now(), cron: '0 15 * * *' } as never);
    await vi.waitFor(async () => expect(await env.KV.get(key)).toBeNull(), { timeout: 8000 });
    expect(await env.KV.get(pairKey)).toBeNull();
    const after = await (await call(`/api/orders/${solo}`, { token: t })).json<{ drawing_key: string | null; drawing_archived_at: string | null }>();
    expect(after.drawing_key).toBeNull();
    expect(after.drawing_archived_at).not.toBeNull();
    for (const id of pair) expect((await (await call(`/api/orders/${id}`, { token: t })).json<{ drawing_archived_at: string | null }>()).drawing_archived_at).not.toBeNull();
    expect((await call(`/api/orders/${solo}/drawing-link`, { token: t })).status).toBe(404);
    const sum = await (await call('/api/admin/archive/summary', { token: t })).json<{ last_run: { deleted: number; auto: boolean } | null }>();
    expect(sum.last_run?.auto).toBe(true);
    expect(sum.last_run?.deleted).toBeGreaterThanOrEqual(2);
    // 미납이 남은 도면이나 삭제 대상이 아닌 도면은 건드리지 않는다 / 기록이 남는다
    const logged = await env.DB.prepare(`SELECT user_name FROM audit_log WHERE action = 'purge-drawings' ORDER BY id DESC LIMIT 1`).first<{ user_name: string }>();
    expect(logged?.user_name).toBe('자동(매일 00:00)');

    // 도면을 다시 올리면 삭제됨 표시가 사라진다 (복원)
    expect((await call(`/api/orders/${solo}/drawing`, { method: 'PUT', body: html, token: t, headers: { 'Content-Type': 'text/html' } })).status).toBe(200);
    expect((await (await call(`/api/orders/${solo}`, { token: t })).json<{ drawing_archived_at: string | null }>()).drawing_archived_at).toBeNull();
  });
});
