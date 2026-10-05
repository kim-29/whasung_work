// Web Push(RFC 8030/8291/8292)를 Web Crypto만으로 구현. 외부 라이브러리 없음.
import type { Env } from './types';

const enc = new TextEncoder();

const b64uToBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bytesToB64u = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** aes128gcm 본문 암호화 (단일 레코드) */
export async function encryptPayload(payload: string, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(p256dh);
  const auth = b64uToBytes(authSecret);

  const asKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKeys.privateKey, 256),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(ecdh, auth, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 2 = 마지막 레코드 구분자
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** VAPID JWT(ES256) 서명 */
async function vapidAuthHeader(env: Env, endpoint: string): Promise<string> {
  const pub = b64uToBytes(env.VAPID_PUBLIC);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE,
    x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })),
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

export interface PushMessage {
  title: string;
  body: string;
  orderId?: number;
}

/** 해당 역할의 모든 구독자에게 발송. 만료된 구독(404/410)은 삭제한다. */
export async function sendPush(env: Env, roles: string[] | undefined, msg: PushMessage): Promise<void> {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return; // 키가 없으면 푸시 비활성
  const { results } = await env.DB.prepare(
    `SELECT s.endpoint, s.p256dh, s.auth, u.role
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.active = 1`,
  ).all<{ endpoint: string; p256dh: string; auth: string; role: string }>();
  const targets = results.filter((s) => !roles || roles.includes(s.role));

  await Promise.allSettled(
    targets.map(async (s) => {
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuthHeader(env, s.endpoint),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '3600',
            Urgency: 'high',
          },
          body: await encryptPayload(JSON.stringify(msg), s.p256dh, s.auth),
        });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(s.endpoint).run();
        }
      } catch (e) {
        console.error('push failed', e);
      }
    }),
  );
}
