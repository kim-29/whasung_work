export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

const KEY = 'whasung.token';
export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: string } = {},
): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.raw === undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) {
      tokenStore.clear();
      window.dispatchEvent(new Event('whasung:logout'));
    }
    throw new ApiError((data as { error?: string }).error ?? '요청에 실패했습니다.', res.status);
  }
  return data as T;
}

/** SQLite의 UTC 시각 문자열 → 한국 시간 날짜 */
export function fmtDate(s: string | null | undefined, withTime = false): string {
  if (!s) return '-';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const date = d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
  return withTime ? `${date} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : date;
}

export const fmtKg = (n: number | null | undefined) =>
  n == null ? '-' : `${Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}kg`;
