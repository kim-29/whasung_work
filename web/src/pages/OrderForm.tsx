import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { api, fmtKg } from '../api';
import { KIND_LABEL, type Bar, type Kind, type OrderItem } from '../types';
import { Button, Card, Field } from '../ui';

export interface OrderFormValues {
  company: string;
  kind: Kind;
  content: string;
  request_note: string;
  items: OrderItem[];
  manual_weight?: number;
}

const COLORS = ['화이트', '블랙', '은색', '브론즈', '샴페인', '갈색'];
const emptyItem = (): OrderItem => ({ bar_name: '', length_mm: 0, qty: 1, color: '' });

/** 이론무게(kg) = kg/m × 길이(mm)/1000 × 수량 */
export const calcWeight = (kgPerM: number | undefined, mm: number, qty: number) =>
  kgPerM ? Math.round(kgPerM * (mm / 1000) * qty * 1000) / 1000 : 0;

export default function OrderForm({
  initial,
  submitLabel,
  allowManual,
  extra,
  onSubmit,
}: {
  initial?: OrderFormValues;
  submitLabel: string;
  allowManual?: boolean;
  extra?: ReactNode;
  onSubmit: (v: OrderFormValues) => Promise<void>;
}) {
  const bars = useQuery({ queryKey: ['bars'], queryFn: () => api<Bar[]>('/bars'), staleTime: 60_000 });
  const rate = useMemo(() => new Map((bars.data ?? []).map((b) => [b.name, b.kg_per_m])), [bars.data]);

  const [company, setCompany] = useState(initial?.company ?? '');
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'cut');
  const [content, setContent] = useState(initial?.content ?? '');
  const [note, setNote] = useState(initial?.request_note ?? '');
  const [items, setItems] = useState<OrderItem[]>(initial?.items.length ? initial.items : [emptyItem()]);
  const [pricePerKg, setPricePerKg] = useState('');
  const [manual, setManual] = useState(false);
  const [manualWeight, setManualWeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setItem = (i: number, patch: Partial<OrderItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const rowWeights = items.map((it) => calcWeight(rate.get(it.bar_name), it.length_mm, it.qty));
  const total = Math.round(rowWeights.reduce((a, b) => a + b, 0) * 1000) / 1000;
  const price = Number(pricePerKg) > 0 ? Math.round(total * Number(pricePerKg)) : null;

  const submit = async () => {
    setError('');
    if (!company.trim()) return setError('업체명을 입력해 주세요.');
    const rows = items.filter((it) => it.bar_name || it.length_mm);
    if (!rows.length) return setError('절단서를 한 줄 이상 입력해 주세요.');
    if (rows.some((it) => !it.bar_name || it.length_mm <= 0 || it.qty <= 0))
      return setError('절단서의 바 이름, 길이, 수량을 모두 입력해 주세요.');
    if (manual && !(Number(manualWeight) > 0)) return setError('실제 무게(kg)를 입력해 주세요.');
    setBusy(true);
    try {
      await onSubmit({
        company: company.trim(), kind, content, request_note: note, items: rows,
        manual_weight: manual ? Number(manualWeight) : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <Field label="요구 업체명">
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="예) 한빛샷시" />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-bold text-slate-600">작업 종류</span>
          <div className="grid grid-cols-2 gap-3">
            {(['cut', 'make'] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`min-h-16 rounded-xl border-2 text-lg font-bold ${
                  kind === k ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 bg-white'
                }`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <Field label="작업 내용">
          <textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <Field label="별도 요구사항">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Card>

      <Card>
        <h3 className="mb-3 text-lg font-bold">절단서</h3>
        <datalist id="color-list">{COLORS.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="space-y-3">
          {items.map((it, i) => {
            const unknown = it.bar_name && !rate.has(it.bar_name);
            return (
              <div key={i} className="rounded-xl border-2 border-slate-200 p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field label="바 이름">
                    <select value={it.bar_name} onChange={(e) => setItem(i, { bar_name: e.target.value })}>
                      <option value="">선택</option>
                      {it.bar_name && unknown && <option value={it.bar_name}>{it.bar_name} (미등록)</option>}
                      {(bars.data ?? []).map((b) => (
                        <option key={b.id} value={b.name}>{b.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="길이(mm)">
                    <input inputMode="numeric" value={it.length_mm || ''}
                      onChange={(e) => setItem(i, { length_mm: Number(e.target.value.replace(/\D/g, '')) })} />
                  </Field>
                  <Field label="수량">
                    <input inputMode="numeric" value={it.qty || ''}
                      onChange={(e) => setItem(i, { qty: Number(e.target.value.replace(/\D/g, '')) })} />
                  </Field>
                  <Field label="색상">
                    <input list="color-list" value={it.color} onChange={(e) => setItem(i, { color: e.target.value })} />
                  </Field>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className={`text-base font-bold ${unknown ? 'text-red-600' : 'text-slate-600'}`}>
                    {unknown ? '등록되지 않은 바입니다 (무게 계산 불가)' : `무게 ${fmtKg(rowWeights[i])}`}
                  </span>
                  {items.length > 1 && (
                    <Button tone="plain" type="button" onClick={() => setItems((a) => a.filter((_, x) => x !== i))}>
                      줄 삭제
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <Button tone="plain" type="button" className="mt-3 w-full" onClick={() => setItems((a) => [...a, emptyItem()])}>
          + 줄 추가
        </Button>
      </Card>

      <Card className="space-y-3">
        <p className="text-2xl font-bold">예상 총 무게: {fmtKg(total)}</p>
        <Field label="kg당 예상 가격(원) — 입력하면 전체 가격이 보입니다 (저장되지 않음)">
          <input inputMode="numeric" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {price !== null && <p className="text-2xl font-bold text-blue-700">예상 가격: {price.toLocaleString('ko-KR')}원</p>}
      </Card>

      {allowManual && (
        <Card className="space-y-3">
          <label className="flex items-center gap-3 text-lg font-bold">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
            작업장에서 이미 절단해 간 건 (수기 접수)
          </label>
          {manual && (
            <Field label="실제 무게(kg)">
              <input inputMode="decimal" value={manualWeight} onChange={(e) => setManualWeight(e.target.value)} />
            </Field>
          )}
        </Card>
      )}

      {extra}

      {error && <p className="rounded-xl bg-red-100 p-4 text-lg font-bold text-red-700">{error}</p>}
      <Button className="w-full !min-h-16 text-xl" disabled={busy} onClick={submit}>
        {busy ? '처리 중...' : submitLabel}
      </Button>
    </div>
  );
}
