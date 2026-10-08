import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, fmtKg, fmtWon, kstMonth } from '../api';
import { BarChart, COLOR_FILL, GRAPHITE, RankBars, STATUS_FILL, Stat, short, YELLOW } from '../charts';
import { Card } from '../ui';
import { COLORS } from '../types';

interface Slot {
  label: string;
  paid: { orders: number; weight: number; amount: number; cut_amount: number; make_amount: number };
  unpaid: { orders: number; weight: number; amount: number };
  active: { orders: number; theory_kg: number };
  usage_m: number;
  usage_theory_kg: number;
  weight: number;
  weight_by_color: Record<string, number>;
}

interface AnalyticsData {
  mode: 'year' | 'month';
  key: string;
  series: Slot[];
  totals: {
    usage_m: number; usage_theory_kg: number; weight: number; bar_kinds: number;
    paid: { orders: number; weight: number; amount: number };
    unpaid: { orders: number; weight: number; amount: number };
    active: { orders: number; theory_kg: number };
    make_cost_missing: number;
  };
  bars: { bar_name: string; total_m: number; theory_kg: number; by_color: Record<string, number> }[];
  companies_by_count: { company: string; paid: number; unpaid: number; active: number }[];
  companies_by_weight: { company: string; paid: number; unpaid: number; active: number }[];
}

/** 색 설명 (그래프 아래) */
function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-600">
      {items.map((i) => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border border-slate-400" style={{ background: i.color }} />{i.name}
        </span>
      ))}
    </div>
  );
}

const STATUS_LEGEND = [
  { name: '완납', color: STATUS_FILL.paid },
  { name: '미납', color: STATUS_FILL.unpaid },
  { name: '진행', color: STATUS_FILL.active },
];

/** 카드 아래 작은 두 줄 */
const Lines = ({ children }: { children: ReactNode[] }) => <>{children.map((c, i) => <span key={i} className="block">{c}</span>)}</>;

export default function Analytics() {
  const [mode, setMode] = useState<'year' | 'month'>('month');
  const [month, setMonth] = useState(kstMonth());
  const [year, setYear] = useState(kstMonth().slice(0, 4));
  const key = mode === 'year' ? year : month;

  const q = useQuery({
    queryKey: ['analytics', mode, key],
    enabled: mode === 'year' ? /^\d{4}$/.test(year) : /^\d{4}-\d{2}$/.test(month),
    queryFn: () => api<AnalyticsData>(`/analytics?mode=${mode}&${mode === 'year' ? `year=${year}` : `month=${month}`}`),
  });
  const d = q.data;
  const period = mode === 'year' ? `${year}년` : `${month.replace('-', '년 ')}월`;
  const tickLabels = d?.series.map((s) => (mode === 'year' ? `${Number(s.label.slice(5))}월` : String(Number(s.label.slice(8))))) ?? [];
  const unit = mode === 'year' ? '월별' : '일별';
  // 기간에 실제로 쓰인 색상만 (정해진 색상 순서대로, 그 밖의 이름은 뒤에)
  const orderColors = (names: Set<string>) => [...COLORS.filter((c) => names.has(c)), ...[...names].filter((c) => !(COLORS as readonly string[]).includes(c))];
  const colorsUsed = orderColors(new Set(d?.series.flatMap((s) => Object.keys(s.weight_by_color).filter((c) => s.weight_by_color[c] > 0)) ?? []));
  const barColors = orderColors(new Set(d?.bars.flatMap((b) => Object.keys(b.by_color).filter((c) => b.by_color[c] > 0)) ?? []));

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">판매분석</h1>

      <Card className="space-y-2 !p-3">
        <div className="grid grid-cols-2 gap-2">
          {(['year', 'month'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`min-h-11 rounded-xl border text-base font-semibold ${mode === m ? 'border-black bg-slate-900 text-white' : 'border-slate-400 bg-white'}`}>
              {m === 'year' ? '년간' : '월간'}
            </button>
          ))}
        </div>
        {mode === 'year' ? (
          <input type="number" inputMode="numeric" min={2020} max={2100} value={year} aria-label="연도" onChange={(e) => setYear(e.target.value)} />
        ) : (
          <input type="month" value={month} aria-label="조회할 달" onChange={(e) => e.target.value && setMonth(e.target.value)} />
        )}
        <p className="text-sm text-slate-500">
          모든 집계는 <b>지시일</b>(작업지시서를 보낸 날, 한국 시간)이 속한 {mode === 'year' ? '해' : '달'}에 넣습니다. 무게가 다른 달에 입력되었거나 아직 납입 전이어도 지시한 {mode === 'year' ? '해' : '달'}에 들어갑니다.
        </p>
      </Card>

      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {q.isError && <p className="rounded-xl border border-red-800 bg-red-100 p-3 text-base font-semibold text-red-700">{(q.error as Error).message}</p>}

      {d && (
        <>
          {/* 1. 자재 사용내역: 무게가 입력된 작업만 */}
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">{period} 자재 사용내역 <span className="text-sm font-normal text-slate-500">(지시일 기준 · 무게가 입력된 작업만)</span></h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="예상 무게" value={fmtKg(d.totals.usage_theory_kg)} sub="무게가 입력된 작업만 · 절단서 기준" />
              <Stat label="실제 무게" value={fmtKg(d.totals.weight)} sub="무게가 입력된 작업만" />
              <Stat label="총 사용 길이" value={`${d.totals.usage_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m`} sub="무게가 입력된 작업만" />
              <Stat label="바 종류" value={`${d.totals.bar_kinds}종`} sub="무게가 입력된 작업 기준" />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 실제 무게 (kg) <span className="font-normal text-slate-500">· 작업장이 입력한 무게, 색상별</span></p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={colorsUsed.map((c) => ({ name: c, color: COLOR_FILL[c] ?? YELLOW, values: d.series.map((s) => Math.round((s.weight_by_color[c] ?? 0) * 10) / 10) }))}
                format={(n) => `${Number.isInteger(n) ? n : n.toFixed(1)}kg`}
              />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">바 종류별 사용량 (예상 무게 많은 순) <span className="font-normal text-slate-500">· 무게가 입력된 작업만, 절단서 기준 예상 무게, 색상별</span></p>
              <RankBars
                rows={d.bars.map((b) => ({
                  name: b.bar_name, value: b.theory_kg, text: fmtKg(b.theory_kg),
                  sub: `${b.total_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m · ${barColors.filter((c) => b.by_color[c] > 0).map((c) => `${c} ${fmtKg(b.by_color[c])}`).join(' · ')}`,
                  parts: barColors.map((c) => ({ name: c, color: COLOR_FILL[c] ?? YELLOW, value: b.by_color[c] ?? 0 })),
                }))}
                empty="무게가 입력된 작업이 없습니다."
              />
              {barColors.length > 0 && <Legend items={barColors.map((c) => ({ name: c, color: COLOR_FILL[c] ?? YELLOW }))} />}
            </div>
          </Card>

          {/* 2. 거래내역: 완납 / 미납 / 진행 */}
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">{period} 거래내역 <span className="text-sm font-normal text-slate-500">(지시일 기준)</span></h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="완납 건수" value={`${d.totals.paid.orders}건`}
                sub={<Lines>{[`완납 무게 ${fmtKg(d.totals.paid.weight)}`, `금액 ${fmtWon(d.totals.paid.amount)}`]}</Lines>} />
              <Stat label="미납 건수" value={`${d.totals.unpaid.orders}건`}
                sub={<Lines>{[`미납 무게 ${fmtKg(d.totals.unpaid.weight)}`, `미납 금액 ${fmtWon(d.totals.unpaid.amount)}`]}</Lines>} />
              <Stat label="진행 건수" value={`${d.totals.active.orders}건`}
                sub={<Lines>{[`예상 무게 ${fmtKg(d.totals.active.theory_kg)}`]}</Lines>} />
              <Stat label="제작비용 미입력" value={`${d.totals.make_cost_missing}건`} warn={d.totals.make_cost_missing > 0} />
            </div>
            <p className="text-xs text-slate-500">금액은 실제 무게 × 단가이고, 제작 작업은 제작비용을 더한 값입니다. 진행은 대기·제작중인 작업입니다.</p>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 완납 거래 금액 <span className="font-normal text-slate-500">· 완납한 작업만, 절단/제작</span></p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={[
                  { name: '절단', color: YELLOW, values: d.series.map((s) => s.paid.cut_amount) },
                  { name: '제작', color: GRAPHITE, values: d.series.map((s) => s.paid.make_amount) },
                ]}
                format={short}
              />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 거래 건수 <span className="font-normal text-slate-500">· 완납/미납/진행</span></p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={[
                  { name: '완납', color: STATUS_FILL.paid, values: d.series.map((s) => s.paid.orders) },
                  { name: '미납', color: STATUS_FILL.unpaid, values: d.series.map((s) => s.unpaid.orders) },
                  { name: '진행', color: STATUS_FILL.active, values: d.series.map((s) => s.active.orders) },
                ]}
                format={(n) => String(Math.round(n))}
              />
            </div>
          </Card>

          {/* 3. 업체별 의뢰건수 */}
          <Card className="space-y-2">
            <h2 className="text-lg font-bold">{period} 업체별 의뢰건수 <span className="text-sm font-normal text-slate-500">(많은 순)</span></h2>
            <RankBars
              unit="건"
              rows={d.companies_by_count.map((c) => ({
                name: c.company,
                value: c.paid + c.unpaid + c.active,
                text: `${c.paid + c.unpaid + c.active}건`,
                sub: `완납 ${c.paid} · 미납 ${c.unpaid} · 진행 ${c.active}`,
                parts: [
                  { name: '완납', color: STATUS_FILL.paid, value: c.paid },
                  { name: '미납', color: STATUS_FILL.unpaid, value: c.unpaid },
                  { name: '진행', color: STATUS_FILL.active, value: c.active },
                ],
              }))}
              empty="이 기간의 의뢰가 없습니다."
            />
            {d.companies_by_count.length > 0 && <Legend items={STATUS_LEGEND} />}
          </Card>

          {/* 4. 업체별 판매량(무게) */}
          <Card className="space-y-2">
            <h2 className="text-lg font-bold">{period} 업체별 판매량(무게) <span className="text-sm font-normal text-slate-500">(많은 순)</span></h2>
            <p className="text-sm text-slate-500">완납·미납은 작업장이 입력한 실제 무게, 진행은 예상 무게입니다.</p>
            <RankBars
              rows={d.companies_by_weight.map((c) => ({
                name: c.company,
                value: c.paid + c.unpaid + c.active,
                text: fmtKg(c.paid + c.unpaid + c.active),
                sub: `완납 ${fmtKg(c.paid)} · 미납 ${fmtKg(c.unpaid)} · 진행 ${fmtKg(c.active)}`,
                parts: [
                  { name: '완납', color: STATUS_FILL.paid, value: c.paid },
                  { name: '미납', color: STATUS_FILL.unpaid, value: c.unpaid },
                  { name: '진행', color: STATUS_FILL.active, value: c.active },
                ],
              }))}
              empty="무게가 있는 작업이 없습니다."
            />
            {d.companies_by_weight.length > 0 && <Legend items={STATUS_LEGEND} />}
          </Card>
        </>
      )}
    </div>
  );
}
