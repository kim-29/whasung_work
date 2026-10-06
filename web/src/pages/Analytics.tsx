import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtKg, fmtWon, kstMonth } from '../api';
import { BarChart, GOLD, GRAPHITE, RankBars, Stat, short } from '../charts';
import { Card } from '../ui';
import { STOCK_LENGTH_M, toStock } from './money';

interface AnalyticsData {
  mode: 'year' | 'month';
  key: string;
  series: { label: string; orders: number; weight: number; amount: number; make_cost: number; usage_m: number; usage_kg: number }[];
  totals: {
    orders: number; weight: number; amount: number; make_cost: number; usage_m: number; usage_kg: number;
    bar_kinds: number; paid: number; unpaid: number; make_cost_missing: number;
  };
  bars: { bar_name: string; total_m: number; theory_kg: number }[];
  companies_by_count: { company: string; orders: number }[];
  companies_by_weight: { company: string; weight: number }[];
}

const bons = (m: number) => m / STOCK_LENGTH_M;

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
        <p className="text-sm text-slate-500">모든 집계는 <b>지시일</b>(작업지시서를 보낸 날, 한국 시간) 기준입니다. 진행 중인 작업도 포함됩니다.</p>
      </Card>

      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {q.isError && <p className="rounded-xl border border-red-800 bg-red-100 p-3 text-base font-semibold text-red-700">{(q.error as Error).message}</p>}

      {d && (
        <>
          {/* 1. 자재 사용내역 */}
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">{period} 자재 사용내역 <span className="text-sm font-normal text-slate-500">(지시일 기준)</span></h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="총 사용 길이" value={`${d.totals.usage_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m`} />
              <Stat label="환산수량 (6m 기준)" value={toStock(d.totals.usage_m)} />
              <Stat label="예상 무게" value={fmtKg(d.totals.usage_kg)} />
              <Stat label="바 종류" value={`${d.totals.bar_kinds}종`} />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 환산수량 (본)</p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={[{ name: '환산수량', color: GOLD, values: d.series.map((s) => Math.round(bons(s.usage_m) * 10) / 10) }]}
                format={(n) => (Number.isInteger(n) ? String(n) : n.toFixed(1))}
              />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">바 종류별 사용량 (많은 순)</p>
              <RankBars
                rows={d.bars.map((b) => ({
                  name: b.bar_name, value: b.total_m, text: toStock(b.total_m),
                  sub: `${b.total_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m · 예상 ${fmtKg(b.theory_kg)}`,
                }))}
                empty="이 기간에 사용한 자재가 없습니다."
              />
            </div>
          </Card>

          {/* 2. 거래내역 */}
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">{period} 거래내역 <span className="text-sm font-normal text-slate-500">(지시일 기준)</span></h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="거래 건수" value={`${d.totals.orders}건`} sub={`완납 ${d.totals.paid}건 · 미납 ${d.totals.unpaid}건`} />
              <Stat label="판매 무게" value={fmtKg(d.totals.weight)} />
              <Stat label="합계 (제작비용 포함)" value={fmtWon(d.totals.amount + d.totals.make_cost)} />
              <Stat label="판매금액" value={fmtWon(d.totals.amount)} />
              <Stat label="제작비용" value={fmtWon(d.totals.make_cost)} />
              <Stat label="제작비용 미입력" value={`${d.totals.make_cost_missing}건`} warn={d.totals.make_cost_missing > 0} />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 거래 금액</p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={[
                  { name: '판매금액', color: GOLD, values: d.series.map((s) => s.amount) },
                  { name: '제작비용', color: GRAPHITE, values: d.series.map((s) => s.make_cost) },
                ]}
                format={short}
              />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-slate-700">{unit} 거래 건수</p>
              <BarChart
                labels={d.series.map((s) => s.label)}
                tickLabels={tickLabels}
                series={[{ name: '건수', color: GRAPHITE, values: d.series.map((s) => s.orders) }]}
                format={(n) => String(Math.round(n))}
              />
            </div>
          </Card>

          {/* 3. 업체별 의뢰건수 */}
          <Card className="space-y-2">
            <h2 className="text-lg font-bold">{period} 업체별 의뢰건수 <span className="text-sm font-normal text-slate-500">(많은 순)</span></h2>
            <RankBars
              rows={d.companies_by_count.map((c) => ({ name: c.company, value: c.orders, text: `${c.orders}건` }))}
              empty="이 기간의 의뢰가 없습니다."
            />
          </Card>

          {/* 4. 업체별 판매량(무게) */}
          <Card className="space-y-2">
            <h2 className="text-lg font-bold">{period} 업체별 판매량(무게) <span className="text-sm font-normal text-slate-500">(많은 순)</span></h2>
            <p className="text-sm text-slate-500">작업장이 무게를 입력한 작업만 합산합니다.</p>
            <RankBars
              color={GRAPHITE}
              rows={d.companies_by_weight.map((c) => ({ name: c.company, value: c.weight, text: fmtKg(c.weight) }))}
              empty="무게가 입력된 작업이 없습니다."
            />
          </Card>
        </>
      )}
    </div>
  );
}
