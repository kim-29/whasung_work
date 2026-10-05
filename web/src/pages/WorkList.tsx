import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg } from '../api';
import { useAuth } from '../auth';
import { PushCard } from '../push';
import { KIND_LABEL, STATUS_LABEL, type OrderSummary } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

function OrderCard({ o, siblings, isFront, onDetail }: { o: OrderSummary; siblings: number; isFront: boolean; onDetail: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const w = Number(weight);
  const confirmWeight = () => {
    const msg = `${o.company}${o.color ? ` (${o.color})` : ''} 무게 ${w}kg 가 맞습니까?\n(예상 무게 ${fmtKg(o.theory_weight)})`;
    if (!window.confirm(msg)) return;
    run(
      () => api(`/orders/${o.id}/weight`, { body: { weight: w } }),
      o.kind === 'cut' ? '완료했습니다. 사무실에 알렸습니다.' : '절단 무게를 기록했습니다. 이어서 제작해 주세요.',
    );
  };

  return (
    <Card className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-bold">{o.company}</span>
        <Badge color={o.status === 'pending' ? 'amber' : 'blue'}>{STATUS_LABEL[o.status]}</Badge>
        <Badge>{KIND_LABEL[o.kind]}</Badge>
        {o.color && <Badge color="slate">{o.color}</Badge>}
        {siblings > 1 && <Badge color="slate">같은 지시서 {siblings}건</Badge>}
        {o.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
      </div>
      <p className="text-sm text-slate-600">
        지시 {fmtDate(o.created_at, true)} · 예상 {fmtKg(o.theory_weight)}
        {o.actual_weight != null && <> · 실제 <b>{fmtKg(o.actual_weight)}</b></>}
      </p>

      {o.status === 'pending' && (
        <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-slate-100 p-2.5">
          <div className="flex-1">
            <Field label="절단한 무게(kg)">
              <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))} placeholder="예) 12.5" />
            </Field>
          </div>
          <Button tone="success" disabled={busy || !(w > 0)} onClick={confirmWeight}>확인</Button>
        </div>
      )}
      {o.status === 'making' && (
        <Button tone="success" className="w-full !min-h-12 text-base" disabled={busy}
          onClick={() => window.confirm('제작이 모두 끝났습니까?') && run(() => api(`/orders/${o.id}/complete`, { body: {} }), '제작 완료를 사무실에 알렸습니다.')}>
          제작 완료
        </Button>
      )}

      <div className="flex flex-wrap gap-2">
        <Button tone="plain" onClick={onDetail}>{isFront ? '세부내역 / 수정' : '절단서 보기'}</Button>
        {o.has_drawing ? <Button onClick={() => openDrawing(o.id).catch((e) => toast(e.message, 'error'))}>도면 보기</Button> : null}
      </div>
    </Card>
  );
}

export default function WorkList() {
  const { user } = useAuth();
  const isFront = user!.role !== 'workshop';
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['orders'], queryFn: () => api<OrderSummary[]>('/orders'), refetchInterval: 30_000 });
  // 진행 중(대기, 제작중)인 작업만 보여준다. 미납·완납은 대시보드에서 확인한다.
  const list = (q.data ?? []).filter((o) => o.status === 'pending' || o.status === 'making');
  const groupSize = new Map<number, number>();
  list.forEach((o) => o.group_id && groupSize.set(o.group_id, (groupSize.get(o.group_id) ?? 0) + 1));

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">작업목록 <span className="text-base font-normal text-slate-500">진행 중 {list.length}건</span></h1>
      {!isFront && <PushCard />}
      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {q.isError && <p className="rounded-xl border border-red-800 bg-red-100 p-3 text-base font-semibold text-red-700">{(q.error as Error).message}</p>}
      {!q.isLoading && list.length === 0 && <p className="py-10 text-center text-lg text-slate-500">진행 중인 작업이 없습니다.</p>}
      <div className="space-y-2.5">
        {list.map((o) => (
          <OrderCard key={o.id} o={o} siblings={o.group_id ? groupSize.get(o.group_id) ?? 1 : 1} isFront={isFront} onDetail={() => setDetail(o.id)} />
        ))}
      </div>
      {detail !== null && <OrderDetailModal id={detail} canEdit={isFront} onClose={() => setDetail(null)} />}
    </div>
  );
}
