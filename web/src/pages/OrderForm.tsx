import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fmtKg, fmtWon } from '../api';
import { COLORS, KIND_LABEL, type Bar, type Color, type ColorPrice, type Company, type Kind, type OrderItem } from '../types';
import { Button, Card, Field } from '../ui';

export interface OrderFormValues {
  company: string;
  kind: Kind;
  request_note: string;
  items: OrderItem[];
  manual_weight?: number;
  /** 이미 무게가 입력된 오더를 수정할 때의 실제 무게 */
  actual_weight?: number;
  /** 제작비용(원). 수정 화면에서만 쓰며 null 은 '미입력'으로 되돌리기 */
  make_cost?: number | null;
}

/** 수정 화면에서 제작비용을 고칠 수 있게 하는 정보 (제작 작업이고 완납 전일 때만 넘긴다) */
export interface MakeCostInfo {
  value: number | null;
}

/** 수정할 오더의 실제 무게와 지시일 기준 단가 (실제 무게가 있으면 예상 견적 대신 실제 무게·금액을 보여준다) */
export interface WeightInfo {
  actual: number;
  pricePerKg: number | null;
}

const emptyItem = (color: Color): OrderItem => ({ bar_name: '', length_mm: 0, qty: 1, color });

/** 이론무게(kg) = kg/m × 길이(mm)/1000 × 수량 */
export const calcWeight = (kgPerM: number | undefined, mm: number, qty: number) =>
  kgPerM ? Math.round(kgPerM * (mm / 1000) * qty * 1000) / 1000 : 0;

// ---------- 바 이름: 입력한 글자와 가장 가까운 것을 골라서 보여준다 ----------
const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.]/g, '');
const isSubsequence = (q: string, t: string) => {
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length;
};
function suggest(bars: Bar[], query: string): Bar[] {
  const q = norm(query);
  if (!q) return bars.slice(0, 8);
  const scored: { bar: Bar; score: number }[] = [];
  for (const bar of bars) {
    const n = norm(bar.name);
    const score = n.startsWith(q) ? 0 : n.includes(q) ? 1 : isSubsequence(q, n) ? 2 : -1;
    if (score >= 0) scored.push({ bar, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.bar.name.length - b.bar.name.length).slice(0, 8).map((s) => s.bar);
}

// ---------- 업체명: 이미 등록된 업체를 자동완성으로 고른다 (없는 이름을 쓰면 새 업체로 자동 등록) ----------
function CompanyInput({ value, companies, onChange }: { value: string; companies: Company[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number>();
  const list = useMemo(() => {
    const q = norm(value);
    const hit = companies.filter((c) => !q || norm(c.name).includes(q));
    return hit.sort((a, b) => Number(norm(b.name).startsWith(q)) - Number(norm(a.name).startsWith(q)) || b.order_count - a.order_count).slice(0, 8);
  }, [companies, value]);
  const isNew = value.trim() !== '' && !companies.some((c) => norm(c.name) === norm(value));
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  return (
    <div className="relative">
      <input
        value={value}
        placeholder="업체명 입력 또는 선택"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => (blurTimer.current = window.setTimeout(() => setOpen(false), 150))}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === 'Enter' && open && list[active]) (e.preventDefault(), pick(list[active].name));
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {isNew && (!open || list.length === 0) && <p className="mt-1 text-xs font-semibold text-slate-500">처음 거래하는 업체로 새로 등록됩니다.</p>}
      {open && list.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-slate-500 bg-white shadow-lg">
          {list.map((c, i) => (
            <li
              key={c.id}
              onMouseDown={(e) => {
                e.preventDefault();
                window.clearTimeout(blurTimer.current);
                pick(c.name);
              }}
              className={`flex cursor-pointer justify-between px-3 py-3 text-base ${i === active ? 'bg-slate-200' : ''}`}
            >
              <span className="font-semibold">{c.name}</span>
              <span className="text-sm text-slate-500">{c.order_count}건</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function BarInput({ value, bars, onChange }: { value: string; bars: Bar[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number>();
  const list = useMemo(() => suggest(bars, value), [bars, value]);
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  return (
    <div className="relative">
      <input
        value={value}
        placeholder="바 이름 입력"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => (blurTimer.current = window.setTimeout(() => setOpen(false), 150))}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === 'Enter' && open && list[active]) (e.preventDefault(), pick(list[active].name));
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-slate-500 bg-white shadow-lg">
          {list.length === 0 && <li className="px-3 py-3 text-sm text-slate-500">비슷한 바가 없습니다</li>}
          {list.map((b, i) => (
            <li
              key={b.id}
              onMouseDown={(e) => {
                e.preventDefault(); // 입력칸이 포커스를 잃기 전에 선택되도록
                window.clearTimeout(blurTimer.current);
                pick(b.name);
              }}
              className={`flex cursor-pointer justify-between px-3 py-3 text-base ${i === active ? 'bg-slate-200' : ''}`}
            >
              <span className="font-semibold">{b.name}</span>
              <span className="text-sm text-slate-500">{b.kg_per_m}kg/m</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OrderForm({
  initial,
  submitLabel,
  allowManual,
  extra,
  weightInfo,
  makeCostInfo,
  onSubmit,
}: {
  initial?: OrderFormValues;
  submitLabel: string;
  allowManual?: boolean;
  extra?: ReactNode;
  weightInfo?: WeightInfo;
  makeCostInfo?: MakeCostInfo;
  onSubmit: (v: OrderFormValues) => Promise<void>;
}) {
  const bars = useQuery({ queryKey: ['bars'], queryFn: () => api<Bar[]>('/bars'), staleTime: 60_000 });
  const prices = useQuery({ queryKey: ['prices'], queryFn: () => api<ColorPrice[]>('/prices'), staleTime: 30_000 });
  const rate = useMemo(() => new Map((bars.data ?? []).map((b) => [b.name, b.kg_per_m])), [bars.data]);
  const price = useMemo(() => new Map((prices.data ?? []).map((p) => [p.color, p.price_per_kg])), [prices.data]);

  const [company, setCompany] = useState(initial?.company ?? '');
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'cut');
  const [note, setNote] = useState(initial?.request_note ?? '');
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/companies'), staleTime: 30_000 });
  const [makeCost, setMakeCost] = useState(makeCostInfo?.value == null ? '' : String(makeCostInfo.value));
  const [makeColor, setMakeColor] = useState<Color>(initial?.items[0]?.color ?? '화이트');
  const [items, setItems] = useState<OrderItem[]>(initial?.items.length ? initial.items : [emptyItem('화이트')]);
  const [manual, setManual] = useState(false);
  const [manualWeight, setManualWeight] = useState('');
  const [actualWeight, setActualWeight] = useState(weightInfo ? String(weightInfo.actual) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 제작은 색상 하나(작업 단위), 절단은 줄마다 색상 선택
  const colorOf = (it: OrderItem): Color => (kind === 'make' ? makeColor : it.color);

  const setItem = (i: number, patch: Partial<OrderItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const rowWeights = items.map((it) => calcWeight(rate.get(it.bar_name), it.length_mm, it.qty));
  const total = Math.round(rowWeights.reduce((a, b) => a + b, 0) * 1000) / 1000;

  // 색상별 합계와 견적 (단가는 설정의 색상별 단가를 사용)
  const byColor = useMemo(() => {
    const m = new Map<Color, number>();
    items.forEach((it, i) => m.set(colorOf(it), (m.get(colorOf(it)) ?? 0) + rowWeights[i]));
    return [...m].filter(([, w]) => w > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rowWeights.join(','), kind, makeColor]);
  const unpriced = byColor.filter(([c]) => price.get(c) == null);
  const estimate = byColor.reduce((s, [c, w]) => s + w * (price.get(c) ?? 0), 0);

  const submit = async () => {
    setError('');
    if (!company.trim()) return setError('업체명을 입력해 주세요.');
    const rows = items.filter((it) => it.bar_name || it.length_mm);
    if (!rows.length) return setError('절단서를 한 줄 이상 입력해 주세요.');
    if (rows.some((it) => !it.bar_name || it.length_mm <= 0 || it.qty <= 0))
      return setError('절단서의 바 이름, 길이, 수량을 모두 입력해 주세요.');
    const final = rows.map((it) => ({ ...it, color: colorOf(it) }));
    if (manual && !(Number(manualWeight) > 0)) return setError('실제 무게(kg)를 입력해 주세요.');
    if (weightInfo && !(Number(actualWeight) > 0)) return setError('실제 무게(kg)를 숫자로 입력해 주세요.');
    if (manual && new Set(final.map((i) => i.color)).size > 1)
      return setError('수기 접수는 색상별로 나누어 따로 등록해 주세요.');
    setBusy(true);
    try {
      await onSubmit({
        company: company.trim(), kind, request_note: note, items: final,
        manual_weight: manual ? Number(manualWeight) : undefined,
        actual_weight: weightInfo && Number(actualWeight) !== weightInfo.actual ? Number(actualWeight) : undefined,
        make_cost:
          makeCostInfo && kind === 'make' && makeCost !== (makeCostInfo.value == null ? '' : String(makeCostInfo.value))
            ? (makeCost === '' ? null : Number(makeCost))
            : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const colorSelect = (value: Color, onChange: (c: Color) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value as Color)}>
      {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );

  return (
    <div className="space-y-3">
      <Card className="space-y-2.5">
        <Field label="요구 업체명" inline>
          <CompanyInput value={company} companies={companies.data ?? []} onChange={setCompany} />
        </Field>
        <Field label="작업 종류" inline>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(['cut', 'make'] as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        {kind === 'make' && (
          <Field label="색상" inline>
            {colorSelect(makeColor, setMakeColor)}
          </Field>
        )}
        <Field label="별도 요구사항" inline>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {makeCostInfo && kind === 'make' && (
          <Field label="제작비용(원)" inline>
            <input inputMode="numeric" value={makeCost} placeholder="인건비+부속비 합계" onChange={(e) => setMakeCost(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-base font-bold">절단서</h3>
        <div className="space-y-2.5">
          {items.map((it, i) => {
            const unknown = it.bar_name && !rate.has(it.bar_name);
            return (
              <div key={i} className="rounded-xl border border-slate-300 p-2.5">
                <div className={`grid gap-2 ${kind === 'make' ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>
                  <div className={kind === 'make' ? '' : 'col-span-2 sm:col-span-1'}>
                    <Field label="바 이름">
                      <BarInput value={it.bar_name} bars={bars.data ?? []} onChange={(v) => setItem(i, { bar_name: v })} />
                    </Field>
                  </div>
                  <Field label="길이(mm)">
                    <input inputMode="numeric" value={it.length_mm || ''}
                      onChange={(e) => setItem(i, { length_mm: Number(e.target.value.replace(/\D/g, '')) })} />
                  </Field>
                  <Field label="수량">
                    <input inputMode="numeric" value={it.qty || ''}
                      onChange={(e) => setItem(i, { qty: Number(e.target.value.replace(/\D/g, '')) })} />
                  </Field>
                  {kind === 'cut' && (
                    <Field label="색상">{colorSelect(it.color, (c) => setItem(i, { color: c }))}</Field>
                  )}
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className={`text-sm font-semibold ${unknown ? 'text-red-600' : 'text-slate-600'}`}>
                    {unknown ? '목록에 없는 바입니다 (예상무게 계산 불가)' : `예상무게 ${fmtKg(rowWeights[i])}`}
                  </span>
                  {items.length > 1 && (
                    <Button tone="plain" type="button" className="!min-h-9 !px-3 text-sm" onClick={() => setItems((a) => a.filter((_, x) => x !== i))}>
                      줄 삭제
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <Button tone="plain" type="button" className="mt-2.5 w-full" onClick={() => setItems((a) => [...a, emptyItem(a[a.length - 1]?.color ?? '화이트')])}>
          + 줄 추가
        </Button>
      </Card>

      {weightInfo ? (
        <Card className="space-y-2">
          <Field label="실제 무게(kg)" inline>
            <input inputMode="decimal" value={actualWeight} onChange={(e) => setActualWeight(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <p className="text-sm text-slate-600">
            수정 전 무게 <b>{fmtKg(weightInfo.actual)}</b> · 예상무게 {fmtKg(total)}
          </p>
          <p className="border-t border-slate-300 pt-2 text-xl font-bold">
            금액{' '}
            {weightInfo.pricePerKg == null
              ? <span className="text-red-600">단가 미설정</span>
              : <>{fmtWon((Number(actualWeight) || 0) * weightInfo.pricePerKg)} <span className="text-sm font-normal text-slate-500">({weightInfo.pricePerKg.toLocaleString('ko-KR')}원/kg)</span></>}
          </p>
        </Card>
      ) : (
        <Card className="space-y-1.5">
          <p className="text-lg font-bold">예상 총 무게 {fmtKg(total)}</p>
          {byColor.map(([c, w]) => (
            <p key={c} className="text-base text-slate-700">
              {c} {fmtKg(w)} × {price.get(c) == null ? '단가 미설정' : `${price.get(c)!.toLocaleString('ko-KR')}원`}
              {price.get(c) != null && <> = <b>{fmtWon(w * price.get(c)!)}</b></>}
            </p>
          ))}
          <p className="border-t border-slate-300 pt-2 text-xl font-bold">
            예상 견적가 {unpriced.length ? '-' : fmtWon(estimate)}
          </p>
          {unpriced.length > 0 && (
            <p className="text-sm font-semibold text-red-600">
              {unpriced.map(([c]) => c).join(', ')} 단가가 설정되어 있지 않습니다. 설정 &gt; 색상별 단가에서 입력해 주세요.
            </p>
          )}
        </Card>
      )}
      {allowManual && (
        <Card className="space-y-2">
          <label className="flex items-center gap-3 text-base font-semibold">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
            작업장에서 이미 절단해 간 건 (수기 접수)
          </label>
          {manual && (
            <Field label="실제 무게(kg)" inline>
              <input inputMode="decimal" value={manualWeight} onChange={(e) => setManualWeight(e.target.value)} />
            </Field>
          )}
        </Card>
      )}

      {extra}

      {error && <p className="rounded-xl border border-red-800 bg-red-100 p-3 text-base font-semibold text-red-700">{error}</p>}
      <Button className="w-full !min-h-14 text-lg" disabled={busy} onClick={submit}>
        {busy ? '처리 중...' : manual ? '완료' : submitLabel}
      </Button>
    </div>
  );
}
