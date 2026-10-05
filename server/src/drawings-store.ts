import type { Env } from './types';

// 3D 도면 HTML 저장소. 무료 플랜(카드 등록 불필요)을 위해 KV를 쓴다.
// R2로 옮길 때는 이 파일만 바꾸면 된다. (KV 값 한도 25MB)
export const drawingKey = (orderId: number) => `drawing:${orderId}`;

export async function putDrawing(env: Env, orderId: number, html: string): Promise<string> {
  const key = drawingKey(orderId);
  await env.KV.put(key, html);
  await env.DB.prepare(`UPDATE orders SET drawing_key = ?1 WHERE id = ?2`).bind(key, orderId).run();
  return key;
}

export const getDrawing = (env: Env, orderId: number) => env.KV.get(drawingKey(orderId), 'stream');
