import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { hmacHex, randomPin, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import type { AppEnv, AuthUser, Env, Role } from './types';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const TOKEN_DAYS = 365;

export async function authenticateToken(env: Env, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT d.id AS deviceId, u.id, u.name, u.role
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ?1 AND d.revoked = 0 AND u.active = 1
        AND d.last_used_at > datetime('now', '-${TOKEN_DAYS} days')`,
  )
    .bind(tokenHash)
    .first<AuthUser>();
  if (!row) return null;
  await env.DB.prepare(`UPDATE devices SET last_used_at = datetime('now') WHERE id = ?1`)
    .bind(row.deviceId)
    .run();
  return row;
}

/** 로그인 필수 + 허용 역할 검사 */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  const user = await authenticateToken(c.env, bearer);
  if (!user) return c.json({ error: '로그인이 필요합니다.' }, 401);
  if (!roles.includes(user.role)) return c.json({ error: '권한이 없습니다.' }, 403);
  c.set('user', user);
  await next();
};

export const anyUser = requireRole('admin', 'staff', 'workshop');
export const frontOnly = requireRole('admin', 'staff');
export const adminOnly = requireRole('admin');

export const auth = new Hono<AppEnv>();

const loginSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'PIN은 숫자 6자리입니다.'),
  label: z.string().max(40).optional(),
});

auth.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const { pin, label } = parsed.data;

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const attempt = await c.env.DB.prepare(
    `SELECT fails, locked_until > datetime('now') AS locked FROM login_attempts WHERE key = ?1`,
  )
    .bind(ip)
    .first<{ fails: number; locked: number | null }>();
  if (attempt?.locked) {
    return c.json({ error: `PIN을 여러 번 틀려 잠겼습니다. ${LOCK_MINUTES}분 뒤 다시 시도하거나 관리자에게 문의하세요.` }, 429);
  }

  const pinHash = await hmacHex(c.env.PIN_PEPPER, pin);
  let user = await c.env.DB.prepare(
    `SELECT id, name, role, mail_service, mail_address FROM users WHERE pin_hash = ?1 AND active = 1`,
  )
    .bind(pinHash)
    .first<{ id: number; name: string; role: Role; mail_service: string | null; mail_address: string | null }>();

  // 최초 설치: 관리자가 아직 없고 서버 비밀값(ADMIN_PIN)과 일치하면 관리자 생성
  if (!user && c.env.ADMIN_PIN && timingSafeEqual(pin, c.env.ADMIN_PIN)) {
    const hasAdmin = await c.env.DB.prepare(`SELECT 1 AS x FROM users WHERE role = 'admin'`).first();
    if (!hasAdmin) {
      const r = await c.env.DB.prepare(
        `INSERT INTO users (name, role, pin_hash) VALUES ('관리자', 'admin', ?1)`,
      )
        .bind(pinHash)
        .run();
      user = { id: r.meta.last_row_id, name: '관리자', role: 'admin', mail_service: null, mail_address: null };
    }
  }

  if (!user) {
    await c.env.DB.prepare(
      `INSERT INTO login_attempts (key, fails) VALUES (?1, 1)
       ON CONFLICT(key) DO UPDATE SET
         fails = fails + 1,
         locked_until = CASE WHEN fails + 1 >= ${MAX_FAILS}
                             THEN datetime('now', '+${LOCK_MINUTES} minutes') END`,
    )
      .bind(ip)
      .run();
    return c.json({ error: 'PIN이 맞지 않습니다.' }, 401);
  }

  await c.env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?1`).bind(ip).run();
  const token = randomToken();
  await c.env.DB.prepare(`INSERT INTO devices (user_id, token_hash, label) VALUES (?1, ?2, ?3)`)
    .bind(user.id, await sha256Hex(token), label ?? null)
    .run();
  return c.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, mail_service: user.mail_service, mail_address: user.mail_address },
  });
});

auth.get('/me', anyUser, async (c) => {
  const { id, name, role } = c.get('user');
  const m = await c.env.DB.prepare(`SELECT mail_service, mail_address FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ mail_service: string | null; mail_address: string | null }>();
  return c.json({ id, name, role, mail_service: m?.mail_service ?? null, mail_address: m?.mail_address ?? null });
});

// 내 메일 설정: 거래 내용을 메일로 보낼 때 열 메일 서비스와 내 메일 주소(선택)
export const MAIL_SERVICES = ['gmail', 'outlook', 'naver', 'daum', 'app'] as const;
const mailSchema = z.object({
  mail_service: z.enum(MAIL_SERVICES, { errorMap: () => ({ message: '메일 서비스를 골라 주세요.' }) }).nullable(),
  mail_address: z
    .string()
    .trim()
    .max(120)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), '이메일 주소 형식이 올바르지 않습니다.')
    .optional()
    .default(''),
});

auth.put('/mail', frontOnly, async (c) => {
  const body = mailSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  await c.env.DB.prepare(`UPDATE users SET mail_service = ?1, mail_address = ?2 WHERE id = ?3`)
    .bind(body.data.mail_service, body.data.mail_address || null, c.get('user').id)
    .run();
  return c.json({ mail_service: body.data.mail_service, mail_address: body.data.mail_address || null });
});

auth.post('/logout', anyUser, async (c) => {
  await c.env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE id = ?1`).bind(c.get('user').deviceId).run();
  return c.json({ ok: true });
});

// ---------- 관리자 전용: 직원/PIN/기기 관리 ----------
export const admin = new Hono<AppEnv>();
admin.use('*', adminOnly);

/** 새 PIN 발급. 중복되면 다시 뽑는다. 평문 PIN은 이 응답에서만 보여준다. */
async function issuePin(env: Env): Promise<{ pin: string; hash: string }> {
  for (let i = 0; i < 20; i++) {
    const pin = randomPin();
    const hash = await hmacHex(env.PIN_PEPPER, pin);
    const dup = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE pin_hash = ?1`).bind(hash).first();
    if (!dup) return { pin, hash };
  }
  throw new Error('PIN 발급에 실패했습니다.');
}

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, role, active, created_at, mail_service, mail_address FROM users ORDER BY role, id`,
  ).all();
  return c.json(results);
});

// 관리자가 직원의 메일 서비스·주소를 대신 입력
admin.put('/users/:id/mail', async (c) => {
  const body = mailSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
  const r = await c.env.DB.prepare(`UPDATE users SET mail_service = ?1, mail_address = ?2 WHERE id = ?3 AND role != 'workshop'`)
    .bind(body.data.mail_service, body.data.mail_address || null, Number(c.req.param('id')))
    .run();
  if (!r.meta.changes) return c.json({ error: '직원을 찾을 수 없습니다.' }, 404);
  return c.json({ ok: true });
});

admin.post('/users', async (c) => {
  const body = z.object({ name: z.string().min(1).max(30) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '이름을 입력해 주세요.' }, 400);
  const { pin, hash } = await issuePin(c.env);
  const r = await c.env.DB.prepare(`INSERT INTO users (name, role, pin_hash) VALUES (?1, 'staff', ?2)`)
    .bind(body.data.name, hash)
    .run();
  return c.json({ id: r.meta.last_row_id, name: body.data.name, pin }, 201);
});

/** 직원 PIN 재발급: 기존 PIN과 등록 기기를 모두 무효화 */
admin.post('/users/:id/reissue-pin', async (c) => {
  const id = Number(c.req.param('id'));
  const { pin, hash } = await issuePin(c.env);
  const r = await c.env.DB.prepare(`UPDATE users SET pin_hash = ?1 WHERE id = ?2`).bind(hash, id).run();
  if (!r.meta.changes) return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  await c.env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ?1`).bind(id).run();
  return c.json({ pin });
});

admin.patch('/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = z.object({ active: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: '잘못된 요청입니다.' }, 400);
  if (id === c.get('user').id) return c.json({ error: '자기 자신은 비활성화할 수 없습니다.' }, 400);
  await c.env.DB.prepare(`UPDATE users SET active = ?1 WHERE id = ?2`).bind(body.data.active ? 1 : 0, id).run();
  if (!body.data.active) await c.env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ?1`).bind(id).run();
  return c.json({ ok: true });
});

/** 작업장 PIN 발급/변경. 기존 작업장 기기는 모두 해제된다. */
admin.post('/workshop-pin', async (c) => {
  const { pin, hash } = await issuePin(c.env);
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE role = 'workshop'`).first<{ id: number }>();
  if (existing) {
    await c.env.DB.prepare(`UPDATE users SET pin_hash = ?1, active = 1 WHERE id = ?2`).bind(hash, existing.id).run();
    await c.env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ?1`).bind(existing.id).run();
  } else {
    await c.env.DB.prepare(`INSERT INTO users (name, role, pin_hash) VALUES ('작업장', 'workshop', ?1)`).bind(hash).run();
  }
  return c.json({ pin });
});

admin.get('/devices', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, u.name AS user_name, u.role, d.label, d.created_at, d.last_used_at
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.revoked = 0 ORDER BY d.last_used_at DESC`,
  ).all();
  return c.json(results);
});

admin.delete('/devices/:id', async (c) => {
  await c.env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE id = ?1`).bind(Number(c.req.param('id'))).run();
  return c.json({ ok: true });
});

admin.post('/unlock', async (c) => {
  await c.env.DB.prepare(`DELETE FROM login_attempts`).run();
  return c.json({ ok: true });
});
