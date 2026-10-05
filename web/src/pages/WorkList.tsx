import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg } from '../api';
import { useAuth } from '../auth';
import { PushCard } from '../push';
import { KIND_LABEL, STATUS_LABEL, type OrderSummary, type Status } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

const FILTERS: { key: string; label: string; match: (s: Status) => boolean }[] = [
  { key: 'active', label: '진행중', match: (s) => s === 'pending' || s === 'making' },
  { key: 'unpaid', label: '미납', match: (s) => s === 'unpaid' },
  { key: 'paid', label: '완납', match: (s) => s === 'paid' },
];

function OrderCard({ o, isFront, onDetail }: { o: OrderSummary; isFront: boolean; onDetail: () => void }) {
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
    const msg = `${o.company} 무게 ${w}kg 가 맞습니까?\n(예상 무게 ${fmtKg(o.theory_weight)})`;
    if (!window.confirm(msg)) return;
    run(
      () => api(`/orders/${o.id}/weight`, { body: { weight: w } }),
      o.kind === 'cut' ? '완료했습니다. 사무실에 알렸습니다.' : '절단 무게를 기록했습니다. 이어서 제작해 주세요.',
    );
  };

  const color = o.status === 'pending' ? 'amber' : o.status === 'making' ? 'blue' : o.status === 'unpaid' ? 'red' : 'green';

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xl font-bold">{o.company}</span>
        <Badge color={color}>{STATUS_LABEL[o.status]}</Badge>
        <Badge>{KIND_LABEL[o.kind]}</Badge>
        {o.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
      </div>
      <p className="text-base text-slate-600">
        지시 {fmtDate(o.created_at, true)} · 예상 {fmtKg(o.theory_weight)}
        {o.actual_weight != null && <> · 실제 <b>{fmtKg(o.actual_weight)}</b></>}
      </p>

      {o.status === 'pending' && (
        <div className="flex items-end gap-2 rounded-xl bg-amber-50 p-3">
          <div className="flex-1">
            <Field label={o.kind === 'cut' ? '절단 후 무게(kg)' : '절단한 무게(kg)'}>
              <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, ''))} placeholder="예) 12.5" />
            </Field>
          </div>
          <Button tone="success" disabled={busy || !(w > 0)} onClick={confirmWeight}>확인</Button>
        </div>
      )}
      {o.status === 'making' && (
        <Button tone="success" className="w-full !min-h-14 text-lg" disabled={busy}
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
  const [filter, setFilter] = useState('active');
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['orders'], queryFn: () => api<OrderSummary[]>('/orders'), refetchInterval: 30_000 });
  const f = FILTERS.find((x) => x.key === filter)!;
  const list = (q.data ?? []).filter((o) => (isFront ? f.match(o.status) : true));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">작업목록</h1>
      {!isFront && <PushCard />}
      {isFront && (
        <div className="flex gap-2">
          {FILTERS.map((x) => (
            <button key={x.key} onClick={() => setFilter(x.key)}
              className={`min-h-12 flex-1 rounded-xl text-lg font-bold ${filter === x.key ? 'bg-blue-600 text-white' : 'bg-white'}`}>
              {x.label}
            </button>
          ))}
        </div>
      )}
      {q.isLoading && <p className="text-lg">불러오는 중...</p>}
      {q.isError && <p className="rounded-xl bg-red-100 p-4 text-lg font-bold text-red-700">{(q.error as Error).message}</p>}
      {!q.isLoading && list.length === 0 && <p className="py-10 text-center text-xl text-slate-500">해당하는 작업이 없습니다.</p>}
      <div className="space-y-3">
        {list.map((o) => <OrderCard key={o.id} o={o} isFront={isFront} onDetail={() => setDetail(o.id)} />)}
      </div>
      {detail !== null && <OrderDetailModal id={detail} canEdit={isFront} onClose={() => setDetail(null)} />}
    </div>
  );
}
