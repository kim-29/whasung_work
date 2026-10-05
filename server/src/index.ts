import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { admin, anyUser, auth, authenticateToken } from './auth';
import { Hub } from './hub';
import { drawings, orders } from './routes-orders';
import { bars, dashboard, ingest, prices } from './routes-misc';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : ''),
    allowHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next);
});

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', auth);
app.route('/api/admin', admin);
app.route('/api/bars', bars);
app.route('/api/orders', orders);
app.route('/api/drawings', drawings);
app.route('/api/prices', prices);
app.route('/api/dashboard', dashboard);
app.route('/api/ingest', ingest);

// ---------- Web Push 구독 ----------
app.get('/api/push/key', anyUser, (c) => c.json({ key: c.env.VAPID_PUBLIC || null }));

app.post('/api/push/subscribe', anyUser, async (c) => {
  const body = z
    .object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '잘못된 구독 정보입니다.' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?1,?2,?3,?4)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2, p256dh = ?3, auth = ?4`,
  )
    .bind(body.data.endpoint, c.get('user').id, body.data.keys.p256dh, body.data.keys.auth)
    .run();
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', anyUser, async (c) => {
  const body = z.object({ endpoint: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (body.success) await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(body.data.endpoint).run();
  return c.json({ ok: true });
});

// 실시간 알림: 브라우저 WebSocket은 헤더를 못 보내므로 토큰을 쿼리로 받는다
app.get('/api/ws', async (c) => {
  const user = await authenticateToken(c.env, c.req.query('token'));
  if (!user) return c.text('로그인이 필요합니다.', 401);
  const stub = c.env.HUB.get(c.env.HUB.idFromName('main'));
  return stub.fetch(`https://hub/ws?role=${user.role}`, c.req.raw);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
});

export { Hub };
export default app;
