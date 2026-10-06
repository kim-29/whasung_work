import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const call = (path: string, init: RequestInit & { token?: string; ip?: string } = {}) => {
  const { token, ip, ...rest } = init;
  return SELF.fetch(`https://x${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'CF-Connecting-IP': ip } : {}),
    },
  });
};
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const login = async (pin: string, ip: string) =>
  (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin }), ip }).then((r) => r.json<{ token: string }>())).token;

describe('직원별 메일 설정', () => {
  it('내 메일 서비스·주소를 저장하고 /me 로 돌려받고, 직원 것은 관리자가 대신 입력한다', async () => {
    const admin = await login('123456', '6.6.1.1');
    const staffPin = (await send('POST', '/api/admin/users', { name: '메일직원' }, admin).then((r) => r.json<{ pin: string }>())).pin;
    const workshopPin = (await send('POST', '/api/admin/workshop-pin', {}, admin).then((r) => r.json<{ pin: string }>())).pin;
    const staff = await login(staffPin, '6.6.1.2');
    const workshop = await login(workshopPin, '6.6.1.3');

    // 처음에는 비어 있다
    expect(await call('/api/auth/me', { token: staff }).then((r) => r.json())).toMatchObject({ mail_service: null, mail_address: null });

    // 저장
    expect((await send('PUT', '/api/auth/mail', { mail_service: 'gmail', mail_address: 'me@gmail.com' }, staff)).status).toBe(200);
    expect(await call('/api/auth/me', { token: staff }).then((r) => r.json())).toMatchObject({ mail_service: 'gmail', mail_address: 'me@gmail.com' });
    // 주소는 비워도 된다
    await send('PUT', '/api/auth/mail', { mail_service: 'naver', mail_address: '' }, staff);
    expect(await call('/api/auth/me', { token: staff }).then((r) => r.json())).toMatchObject({ mail_service: 'naver', mail_address: null });

    // 잘못된 서비스·주소는 거절
    expect((await send('PUT', '/api/auth/mail', { mail_service: 'yahoo' }, staff)).status).toBe(400);
    expect((await send('PUT', '/api/auth/mail', { mail_service: 'gmail', mail_address: '주소아님' }, staff)).status).toBe(400);
    // 작업장은 설정할 수 없다
    expect((await send('PUT', '/api/auth/mail', { mail_service: 'gmail' }, workshop)).status).toBe(403);

    // 관리자가 직원 것을 대신 입력, 목록에 보이고 로그인 응답에도 실린다
    const list = await call('/api/admin/users', { token: admin }).then((r) => r.json<{ id: number; name: string }[]>());
    const id = list.find((u) => u.name === '메일직원')!.id;
    expect((await send('PUT', `/api/admin/users/${id}/mail`, { mail_service: 'outlook', mail_address: 'staff@outlook.com' }, admin)).status).toBe(200);
    const after = await call('/api/admin/users', { token: admin }).then((r) => r.json<{ name: string; mail_service: string; mail_address: string }[]>());
    expect(after.find((u) => u.name === '메일직원')).toMatchObject({ mail_service: 'outlook', mail_address: 'staff@outlook.com' });
    const relog = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: staffPin }), ip: '6.6.1.4' }).then((r) => r.json<{ user: { mail_service: string } }>());
    expect(relog.user.mail_service).toBe('outlook');
    // 직원은 다른 사람 것을 못 바꾼다 / 작업장 계정은 대상이 아니다
    expect((await send('PUT', `/api/admin/users/${id}/mail`, { mail_service: 'app' }, staff)).status).toBe(403);
    const wsId = list.find((u) => (u as { role?: string }).role === 'workshop')?.id ?? 0;
    expect((await send('PUT', `/api/admin/users/${wsId}/mail`, { mail_service: 'app' }, admin)).status).toBe(404);
  });
});
