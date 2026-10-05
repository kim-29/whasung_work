import { describe, expect, it } from 'vitest';
import { encryptPayload } from '../src/push';

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) { o.set(x, i); i += x.length; }
  return o;
};
const hkdf = async (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number) =>
  new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));

describe('Web Push 암호화 (RFC 8291)', () => {
  it('수신자(브라우저) 쪽 절차로 복호화하면 원문이 나온다', async () => {
    // 브라우저가 만들어 주는 구독 키 흉내
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));

    const body = await encryptPayload('새 작업지시: 한빛샷시', b64u(uaPub), b64u(auth));

    const salt = body.slice(0, 16);
    expect(body.slice(16, 20)).toEqual(new Uint8Array([0, 0, 0x10, 0]));
    const idLen = body[20];
    const asPub = body.slice(21, 21 + idLen);
    const cipher = body.slice(21 + idLen);

    const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as never, ua.privateKey, 256));
    const ikm = await hkdf(ecdh, auth, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
    const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));

    expect(plain[plain.length - 1]).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe('새 작업지시: 한빛샷시');
  });
});
