import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg } from '../api';
import { useAuth } from '../auth';
import { PushCard } from '../push';
import { KIND_LABEL, STATUS_LABEL, type OrderDetail, type OrderSummary } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

function OrderCard({ o, siblings, isFront, onEdit }: { o: OrderSummary; siblings: number; isFront: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);
  // 세부내역은 카드 안에서 접었다 폈다 한다 (펼칠 때 불러온다)
  const detail = useQuery({ queryKey: ['order', o.id], queryFn: () => api<OrderDetail>(`/orders/${o.id}`), enabled: open });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      if (isFront) toast(ok); // 작업장 화면은 카드가 바뀌는 것으로 충분하다 (성공 팝업 없음)
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const w = Number(weight);
  const confirmWeight = () => {
    const msg = `${o.company}${o.color ? ` (${o.color})` : ''} 무게 ${w}kg 가 맞습니까?\n(예상무게 ${fmtKg(o.theory_weight)})`;
    if (!window.confirm(msg)) return;
    run(
      () => api(`/orders/${o.id}/weight`, { body: { weight: w } }),
      o.kind === 'cut' ? '완료했습니다. 사무실에 알렸습니다.' : '절단 무게를 기록했습니다. 이어서 제작해 주세요.',
    );
  };

  return (
    <Card className="space-y-2">
      {/* 세부내역·내용 수정 버튼은 오른쪽 위에 작게 두어 카드 높이를 줄인다 */}
      {/* 폰에서 라벨이 한 줄씩 쌓이지 않도록: 윗줄은 업체명 + 버튼, 아랫줄에 라벨을 모아 둔다 */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-lg font-bold">{o.company}</span>
        <div className="flex shrink-0 gap-1.5">
          <Button tone="plain" className="!min-h-9 !px-3 text-sm whitespace-nowrap" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            세부내역 {open ? '▲' : '▼'}
          </Button>
          {isFront && <Button tone="plain" className="!min-h-9 !px-3 text-sm whitespace-nowrap" onClick={onEdit}>내용 수정</Button>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge color={o.status === 'pending' ? 'amber' : 'blue'}>{STATUS_LABEL[o.status]}</Badge>
        <Badge>{KIND_LABEL[o.kind]}</Badge>
        {o.color && <Badge color="slate">{o.color}</Badge>}
        {siblings > 1 && <Badge color="slate">같은 지시서 {siblings}건</Badge>}
        {o.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          지시 {fmtDate(o.created_at, true)} · 예상무게 {fmtKg(o.theory_weight)}
          {o.actual_weight != null && <> · 실제 <b>{fmtKg(o.actual_weight)}</b></>}
        </p>
        {o.has_drawing ? <Button className="shrink-0 !min-h-9 !px-3 text-sm" onClick={() => openDrawing(o.id).catch((e) => toast(e.message, 'error'))}>도면 보기</Button> : null}
      </div>

      {open && (
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-3 text-base">
          {!detail.data ? (
            <p>불러오는 중...</p>
          ) : (
            <div className="space-y-2">
              {detail.data.request_note && <p><b>별도 요구사항</b> {detail.data.request_note}</p>}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-base">
                  <thead><tr className="border-b border-slate-400"><th className="py-1.5">바 이름</th><th>길이(mm)</th><th>수량</th><th>색상</th></tr></thead>
                  <tbody>
                    {detail.data.items.map((it) => (
                      <tr key={it.id} className="border-b border-slate-200">
                        <td className="py-1.5">{it.bar_name}</td><td>{it.length_mm}</td><td>{it.qty}</td><td>{it.color}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 무게 입력과 완료 버튼은 카드 맨 아래 */}
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
    </Card>
  );
}

export default function WorkList() {
  const { user } = useAuth();
  const isFront = user!.role !== 'workshop';
  const [editId, setEditId] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['orders'], queryFn: () => api<OrderSummary[]>('/orders'), refetchInterval: 30_000 });
  // 진행 중(대기, 제작중)인 작업만, 오래된 순으로 (새로 온 작업은 맨 아래 → 위에서부터 차례로 작업)
  const list = (q.data ?? [])
    .filter((o) => o.status === 'pending' || o.status === 'making')
    .sort((a, b) => a.id - b.id);
  const groupSize = new Map<number, number>();
  list.forEach((o) => o.group_id && groupSize.set(o.group_id, (groupSize.get(o.group_id) ?? 0) + 1));

  return (
    <div className="space-y-3">
      {!isFront && <PushCard compact />}
      <h1 className="text-xl font-bold">작업목록 <span className="text-base font-normal text-slate-500">진행 중 {list.length}건 · 위에서부터 차례로 작업</span></h1>
      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {q.isError && <p className="rounded-xl border border-red-800 bg-red-100 p-3 text-base font-semibold text-red-700">{(q.error as Error).message}</p>}
      {!q.isLoading && list.length === 0 && <p className="py-10 text-center text-lg text-slate-500">진행 중인 작업이 없습니다.</p>}
      <div className="space-y-2.5">
        {list.map((o) => (
          <OrderCard key={o.id} o={o} siblings={o.group_id ? groupSize.get(o.group_id) ?? 1 : 1} isFront={isFront} onEdit={() => setEditId(o.id)} />
        ))}
      </div>
      {editId !== null && <OrderDetailModal id={editId} canEdit startEditing onClose={() => setEditId(null)} />}
    </div>
  );
}
