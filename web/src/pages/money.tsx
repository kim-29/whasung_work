import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, fmtKg, fmtWon } from '../api';
import type { Status } from '../types';
import { Badge, Button, useToast } from '../ui';

/** 환산수량: 사용 길이(m)를 정척 6m 한 본으로 나눈 값, 소수 첫째 자리까지 ("4.7본") */
export const STOCK_LENGTH_M = 6;
export const toStock = (meters: number) =>
  `${(meters / STOCK_LENGTH_M).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}본`;

/** 판매금액(무게 × 단가) + 제작비용 = 합계. 제작비용이 비어 있으면 0원으로 더한다. */
export const totalOf = (amount: number | null | undefined, makeCost: number | null | undefined) =>
  amount == null && makeCost == null ? null : (amount ?? 0) + (makeCost ?? 0);

/** '무게 × 단가 = 금액' 한 줄. 금액이 왜 그렇게 나왔는지 설명이 되도록 단가를 같이 보여 준다. */
export function PriceLine({
  weight,
  pricePerKg,
  amount,
  priceAdd,
}: {
  weight: number | null | undefined;
  pricePerKg: number | null | undefined;
  amount: number | null | undefined;
  /** 단가에 이미 포함된 추가 단가(원/kg). 있으면 계산 근거를 함께 보여 준다 */
  priceAdd?: number | null;
}) {
  if (weight == null) return <span className="text-sm text-slate-500">무게 입력 전</span>;
  return (
    <span className="text-sm text-slate-700">
      {fmtKg(weight)} × {pricePerKg == null ? <b className="text-red-600">단가 미설정</b> : `${pricePerKg.toLocaleString('ko-KR')}원/kg`}
      {priceAdd ? <span className="text-xs text-slate-500"> (추가 +{priceAdd.toLocaleString('ko-KR')} 포함)</span> : null} ={' '}
      <b className={amount == null ? 'text-red-600' : ''}>{fmtWon(amount)}</b>
    </span>
  );
}

/** 제작 작업의 제작비용. 완납 전까지는 입력·수정할 수 있고, 비어 있으면 '미입력' 표시가 나온다. */
export function MakeCostBox({
  orderId,
  status,
  makeCost,
  inline,
}: {
  orderId: number;
  status: Status;
  makeCost: number | null | undefined;
  /** 거래내역 카드의 금액 한 줄 안에 들어가는 작은 모양 */
  inline?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState(makeCost == null ? '' : String(makeCost));
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(makeCost == null ? '' : String(makeCost)), [makeCost]);

  if (status === 'paid') {
    if (inline) return <span className="text-sm text-slate-700">+ 제작비용 {makeCost == null ? '미입력' : fmtWon(makeCost)}</span>;
    return <p className="text-sm text-slate-700">제작비용 {makeCost == null ? '미입력' : fmtWon(makeCost)}</p>;
  }
  const changed = v !== (makeCost == null ? '' : String(makeCost));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/orders/${orderId}`, { method: 'PATCH', body: { make_cost: v === '' ? null : Number(v) } });
      qc.invalidateQueries();
      toast(v === '' ? '제작비용을 비웠습니다.' : `제작비용 ${fmtWon(Number(v))} 저장했습니다.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (inline) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-sm text-slate-700">+ 제작비용</span>
        <span className="w-28">
          <input
            inputMode="numeric"
            value={v}
            placeholder="원"
            aria-label="제작비용(원)"
            title="제작비용(인건비+부속)"
            className={`!min-h-9 !py-1 text-sm ${makeCost == null ? '!border-red-600' : ''}`}
            onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && changed && !busy && save()}
          />
        </span>
        {changed && <Button tone="plain" className="!min-h-9 !px-3 text-sm" disabled={busy} onClick={save}>저장</Button>}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-300 bg-slate-50 p-2">
      <span className="text-sm font-semibold text-slate-700">제작비용(인건비+부속)</span>
      <div className="w-36">
        <input
          inputMode="numeric"
          value={v}
          placeholder="원"
          aria-label="제작비용(원)"
          onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <Button tone="plain" className="!min-h-10" disabled={busy || !changed} onClick={save}>저장</Button>
      {makeCost == null && <Badge color="red">미입력</Badge>}
    </div>
  );
}
