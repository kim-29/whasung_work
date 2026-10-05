import type { Env } from './types';

// 3D 도면 HTML 저장소. 무료 플랜(카드 등록 불필요)을 위해 KV를 쓴다.
// R2로 옮길 때는 이 파일만 바꾸면 된다. (KV 값 한도 25MB)
// 색상별로 나뉜 오더(같은 group_id)는 도면 하나를 함께 가리킨다.

/** 도면을 저장하고, 같은 지시서(group)에서 나온 모든 오더가 이 도면을 가리키게 한다. */
export async function putDrawing(env: Env, orderId: number, html: string): Promise<string> {
  const key = `drawing:${orderId}`;
  await env.KV.put(key, html);
  await env.DB.prepare(
    `UPDATE orders SET drawing_key = ?1
      WHERE id = ?2 OR (group_id IS NOT NULL AND group_id = (SELECT group_id FROM orders WHERE id = ?2))`,
  )
    .bind(key, orderId)
    .run();
  return key;
}

export async function getDrawing(env: Env, orderId: number) {
  const row = await env.DB.prepare(`SELECT drawing_key FROM orders WHERE id = ?1`)
    .bind(orderId)
    .first<{ drawing_key: string | null }>();
  return row?.drawing_key ? env.KV.get(row.drawing_key, 'stream') : null;
}
