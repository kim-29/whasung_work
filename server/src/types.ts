export type Role = 'admin' | 'staff' | 'workshop';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  HUB: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
  ADMIN_PIN: string;
  PIN_PEPPER: string;
  BLENDER_API_KEY: string;
  /** Web Push(VAPID). 없으면 푸시는 꺼진다. scripts/gen-vapid.mjs 로 생성 */
  VAPID_PUBLIC: string;
  VAPID_PRIVATE: string;
  VAPID_SUBJECT: string;
}

export interface AuthUser {
  id: number;
  name: string;
  role: Role;
  deviceId: number;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };
