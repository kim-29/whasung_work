// Web Push용 VAPID 키 생성: node scripts/gen-vapid.mjs
// 출력된 값을 `wrangler secret put VAPID_PUBLIC / VAPID_PRIVATE` 로 등록하고,
// VAPID_SUBJECT 는 mailto:본인이메일 로 등록한다. 프론트는 서버에서 공개키를 받아 쓴다.
import { webcrypto as c } from 'node:crypto';

const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const b64u = (b) => Buffer.from(b).toString('base64url');
const pub = b64u(await c.subtle.exportKey('raw', kp.publicKey));
const priv = (await c.subtle.exportKey('jwk', kp.privateKey)).d;
console.log(`VAPID_PUBLIC=${pub}\nVAPID_PRIVATE=${priv}\nVAPID_SUBJECT=mailto:you@example.com`);
