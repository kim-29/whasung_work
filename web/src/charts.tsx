import type { ReactNode } from 'react';

// 작은 막대 그래프 도구 (라이브러리 없이 SVG 로 직접 그린다)

export const YELLOW = '#eab308';
export const GRAPHITE = '#3b4249';

/** 거래 상태별 색: 완납=노란색, 미납=빨간색, 진행=검은색 */
export const STATUS_FILL = { paid: '#eab308', unpaid: '#dc2626', active: '#1f2124' } as const;

/** 알루미늄 색상별 그래프 색 (이름 → 색). 화이트는 흰 배경에서도 보이도록 옅은 회색에 테두리를 둔다 */
export const COLOR_FILL: Record<string, string> = {
  화이트: '#e9ecef',
  블랙: '#1f2124',
  실버: '#9aa3ab',
  헨켈: '#c0a073',
  기타: '#8c9f7a',
};
const OUTLINE = 'rgba(0,0,0,0.35)';

/** 큰 숫자를 짧게: 12,000 → 1.2만, 120,000,000 → 1.2억 */
export const short = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}억`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}만`;
  return Math.round(n).toLocaleString('ko-KR');
};

/** 눈금이 깔끔하게 떨어지는 그래프 최대값 (예: 7,300 → 8,000) */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

export interface Series {
  name: string;
  color: string;
  values: number[];
}

/** 세로 막대 그래프 (여러 계열은 위로 쌓는다). 막대에 마우스를 올리면(누르면) 값이 보인다. */
export function BarChart({
  labels,
  tickLabels,
  series,
  format,
}: {
  labels: string[];
  tickLabels: string[];
  series: Series[];
  format: (n: number) => string;
}) {
  const W = 640;
  const H = 210;
  const padL = 46;
  const padB = 24;
  const padT = 10;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const plotW = W - padL - 6;
  const plotH = H - padB - padT;
  const slot = plotW / n;
  const barW = Math.max(3, slot * 0.7);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const every = n > 20 ? 3 : n > 12 ? 2 : 1; // 칸이 많으면 가로 글자를 건너뛰며 보여 준다

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="막대 그래프">
        {[0, 1, 2, 3, 4].map((g) => {
          const v = (max / 4) * g;
          return (
            <g key={g}>
              <line x1={padL} x2={W - 6} y1={y(v)} y2={y(v)} stroke="#d9dde1" strokeWidth="1" />
              <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6f767d">{format(v)}</text>
            </g>
          );
        })}
        {labels.map((label, i) => {
          let top = 0;
          const x = padL + slot * i + (slot - barW) / 2;
          return (
            <g key={label}>
              <title>{`${tickLabels[i]}: ${series.map((s) => `${s.name} ${format(s.values[i] ?? 0)}`).join(' · ')}${series.length > 1 ? ` (합계 ${format(totals[i])})` : ''}`}</title>
              <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" />
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                const h = (v / max) * plotH;
                const rect = v > 0 ? <rect key={s.name} x={x} y={y(top + v)} width={barW} height={h} fill={s.color} stroke={OUTLINE} strokeWidth="0.5" rx="1.5" /> : null;
                top += v;
                return rect;
              })}
              {i % every === 0 && (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#51575d">{tickLabels[i]}</text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 text-sm text-slate-600">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm border border-slate-400" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface RankRow {
  name: string;
  value: number;
  text: string; // 막대 오른쪽에 쓰는 값
  sub?: string; // 이름 아래 보조 설명
  /** 막대를 색상별 구간으로 나눠 그린다 (구간 값의 합 = value) */
  parts?: { name: string; color: string; value: number }[];
}

/** 많은 순 순위 막대 (가로) */
export function RankBars({ rows, color = YELLOW, empty = '내용이 없습니다.', unit = 'kg' }: { rows: RankRow[]; color?: string; empty?: ReactNode; unit?: string }) {
  if (rows.length === 0) return <p className="py-6 text-center text-slate-500">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol className="space-y-2">
      {rows.map((r, i) => (
        <li key={r.name}>
          <div className="flex items-baseline justify-between gap-2 text-base">
            <span className="min-w-0 truncate"><b className="mr-1.5 text-slate-500">{i + 1}</b><span className="font-semibold">{r.name}</span></span>
            <span className="shrink-0 font-semibold">{r.text}</span>
          </div>
          <div className="mt-0.5 h-3 rounded-sm bg-slate-200">
            <div className="flex h-3 overflow-hidden rounded-sm" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: r.parts ? undefined : color }}>
              {r.parts?.filter((p) => p.value > 0).map((p) => (
                <div key={p.name} title={`${p.name} ${p.value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}${unit}`}
                  style={{ width: `${(p.value / r.value) * 100}%`, background: p.color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.35)' }} />
              ))}
            </div>
          </div>
          {r.sub && <p className="mt-0.5 text-xs text-slate-500">{r.sub}</p>}
        </li>
      ))}
    </ol>
  );
}

/** 총괄 카드 한 칸 */
export function Stat({ label, value, sub, warn }: { label: string; value: ReactNode; sub?: ReactNode; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 p-3 text-center">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`text-xl font-bold ${warn ? 'text-red-600' : ''}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
