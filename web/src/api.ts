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

export const fmtWon = (n: number | null | undefined) =>
  n == null ? '단가 미설정' : `${Math.round(n).toLocaleString('ko-KR')}원`;
// 한국 시간(UTC+9) 기준 오늘 날짜 'YYYY-MM-DD' 와 이번 달 'YYYY-MM'. 서버 집계도 한국 시간 기준이라 화면 기본값도 맞춘다.
const kstNow = () => new Date(Date.now() + 9 * 3600_000).toISOString();
export const kstToday = () => kstNow().slice(0, 10);
export const kstMonth = () => kstNow().slice(0, 7);
/** 파일(백업, CSV, 도면 등)을 받아 오는 요청. 로그인 정보를 붙여서 보내고, 실패하면 서버가 알려 준 이유로 오류를 낸다. */
export async function apiBlob(path: string): Promise<Blob> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', 0);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error ?? '파일을 받지 못했습니다.', res.status);
  }
  return res.blob();
}

/** 브라우저의 '다운로드'로 파일을 저장한다 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}