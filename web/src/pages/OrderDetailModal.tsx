import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { API_BASE, api, fmtDate, fmtKg } from '../api';
import { KIND_LABEL, STATUS_LABEL, type OrderDetail } from '../types';
import { Badge, Button, Modal, useToast } from '../ui';
import OrderForm from './OrderForm';

export async function openDrawing(orderId: number) {
  // 팝업 차단을 피하려고 먼저 창을 열고, 서명 링크를 받은 뒤 이동시킨다
  const win = window.open('', '_blank');
  try {
    const { path } = await api<{ path: string }>(`/orders/${orderId}/drawing-link`);
    if (win) win.location.href = `${API_BASE}${path}`;
  } catch (e) {
    win?.close();
    throw e;
  }
}

/** 오더 세부내역 보기 + (프론트) 납입 전 수정 */
export default function OrderDetailModal({
  id,
  canEdit,
  onClose,
}: {
  id: number;
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [weight, setWeight] = useState('');
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<OrderDetail>(`/orders/${id}`) });
  const o = q.data;

  const saveWeight = async () => {
    try {
      await api(`/orders/${id}`, { method: 'PATCH', body: { actual_weight: Number(weight) } });
      qc.invalidateQueries();
      toast('무게를 수정했습니다.');
      setWeight('');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title="작업 세부내역" onClose={onClose}>
      {!o ? (
        <p className="text-lg">불러오는 중...</p>
      ) : editing ? (
        <OrderForm
          initial={{ company: o.company, kind: o.kind, request_note: o.request_note ?? '', items: o.items }}
          submitLabel="수정 저장"
          onSubmit={async (v) => {
            await api(`/orders/${id}`, { method: 'PATCH', body: { company: v.company, kind: v.kind, request_note: v.request_note, items: v.items } });
            qc.invalidateQueries();
            toast('수정했습니다.');
            setEditing(false);
          }}
        />
      ) : (
        <div className="space-y-3 text-base">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xl font-bold">{o.company}</span>
            <Badge color="blue">{KIND_LABEL[o.kind]}</Badge>
            {o.color && <Badge>{o.color}</Badge>}
            <Badge color={o.status === 'paid' ? 'green' : o.status === 'unpaid' ? 'red' : 'amber'}>{STATUS_LABEL[o.status]}</Badge>
            {o.has_unknown_bar ? <Badge color="red">미등록 바 포함</Badge> : null}
          </div>
          <p>지시일 {fmtDate(o.created_at, true)} · 완료일 {fmtDate(o.completed_at, true)}</p>
          <p>예상 무게 {fmtKg(o.theory_weight)} / 실제 무게 <b>{fmtKg(o.actual_weight)}</b></p>
          {o.request_note && <p><b>별도 요구사항</b><br />{o.request_note}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead><tr className="border-b border-slate-400"><th className="py-2">바 이름</th><th>길이(mm)</th><th>수량</th><th>색상</th></tr></thead>
              <tbody>
                {o.items.map((it) => (
                  <tr key={it.id} className="border-b border-slate-200"><td className="py-2">{it.bar_name}</td><td>{it.length_mm}</td><td>{it.qty}</td><td>{it.color}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            {o.has_drawing ? <Button onClick={() => openDrawing(id).catch((e) => toast(e.message, 'error'))}>도면 보기</Button> : null}
            {canEdit && o.status !== 'paid' && <Button tone="plain" onClick={() => setEditing(true)}>내용 수정</Button>}
          </div>
          {canEdit && o.status !== 'paid' && o.status !== 'pending' && (
            <div className="flex items-end gap-2 rounded-xl bg-slate-100 p-3">
              <div className="flex-1">
                <span className="mb-1 block text-sm font-bold text-slate-600">무게 잘못 입력했나요? 바르게 고치기(kg)</span>
                <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
              </div>
              <Button disabled={!(Number(weight) > 0)} onClick={saveWeight}>무게 수정</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
