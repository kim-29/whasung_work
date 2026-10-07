import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { API_BASE, api, fmtDate, fmtKg, fmtWon } from '../api';
import { KIND_LABEL, STATUS_LABEL, type OrderDetail } from '../types';
import { Badge, Button, Modal, useToast } from '../ui';
import { totalOf } from './money';
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

/** 오더 세부내역 (프론트는 단가·금액·제작비용 포함) 보기 + (프론트) 납입 전 수정. 수정 화면에서 실제 무게와 제작비용도 고칠 수 있다. */
export default function OrderDetailModal({
  id,
  canEdit,
  startEditing,
  onClose,
}: {
  id: number;
  canEdit: boolean;
  startEditing?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(!!startEditing);
  const q = useQuery({
    queryKey: ['order', id],
    queryFn: () => api<OrderDetail>(`/orders/${id}`),
  });
  const o = q.data;
  const hasWeight = o?.actual_weight != null;
  const isMake = o?.kind === 'make';
  const showMoney = o?.price_per_kg !== undefined; // 작업장에는 금액 정보가 내려오지 않는다

  return (
    <Modal title={editing ? '내용 수정' : '작업 세부내역'} onClose={onClose}>
      {!o ? (
        <p className="text-base">불러오는 중...</p>
      ) : editing ? (
        <OrderForm
          initial={{ company: o.company, kind: o.kind, request_note: o.request_note ?? '', items: o.items }}
          weightInfo={hasWeight ? { actual: o.actual_weight!, pricePerKg: o.price_per_kg ?? null } : undefined}
          makeCostInfo={isMake && showMoney ? { value: o.make_cost ?? null } : undefined}
          submitLabel="수정 저장"
          compact
          onSubmit={async (v) => {
            // 절단이 끝나 미납이 된 건을 제작으로 바꾸면 미납에서 빠지고 작업장으로 넘어간다
            const toMake = o.status === 'unpaid' && o.kind === 'cut' && v.kind === 'make';
            if (toMake && !window.confirm(`${o.company} 건을 제작으로 바꿀까요?

절단은 끝난 것으로 두고(무게 유지) 작업장의 제작 작업으로 넘어갑니다.
미납 거래내역에서는 사라지고, 제작이 끝나면 다시 미납으로 돌아옵니다.`)) return;
            const toCut = o.status === 'making' && o.kind === 'make' && v.kind === 'cut';
            if (toCut && !window.confirm(`${o.company} 건을 절단으로 바꿀까요?

제작 작업은 취소되고 바로 미납 거래내역으로 넘어갑니다. (입력한 제작비용은 지워집니다)`)) return;
            await api(`/orders/${id}`, {
              method: 'PATCH',
              body: {
                company: v.company, kind: v.kind, request_note: v.request_note, items: v.items,
                actual_weight: v.actual_weight, make_cost: v.make_cost,
              },
            });
            qc.invalidateQueries();
            if (toMake) toast('제작으로 바꿔 작업장에 넘겼습니다. 미납에서는 빠졌습니다.');
            else if (toCut) toast('절단으로 바꿔 미납 거래내역으로 보냈습니다.');
            else toast(v.actual_weight ? `수정했습니다. 무게 ${fmtKg(o.actual_weight)} → ${fmtKg(v.actual_weight)}` : '수정했습니다.');
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
          <p>
            지시일 {fmtDate(o.created_at, true)} · 완료일 {fmtDate(o.completed_at, true)}
            {o.paid_at && <> · 납입일 {fmtDate(o.paid_at, true)}</>}
          </p>
          <div className="rounded-xl border border-slate-300 bg-slate-50 p-3">
            <p>예상무게 {fmtKg(o.theory_weight)}</p>
            {hasWeight && (
              <>
                <p>실제무게 <b>{fmtKg(o.actual_weight)}</b></p>
                {showMoney && (
                  <>
                    <p>
                      단가 {o.price_per_kg == null ? <b className="text-red-600">미설정</b> : `${o.price_per_kg.toLocaleString('ko-KR')}원/kg`}
                      {' · '}금액 <b className={o.amount == null ? 'text-red-600' : ''}>{o.amount == null ? '단가 미설정' : fmtWon(o.amount)}</b>
                    </p>
                    {isMake && (
                      <p>제작비용 {o.make_cost == null ? <b className="text-red-600">미입력</b> : <b>{fmtWon(o.make_cost)}</b>}</p>
                    )}
                    <p className="border-t border-slate-300 pt-1 text-lg font-bold">
                      합계 {fmtWon(totalOf(o.amount, isMake ? o.make_cost : null))}
                    </p>
                  </>
                )}
              </>
            )}
            {!hasWeight && showMoney && isMake && (
              <p>제작비용 {o.make_cost == null ? <b className="text-red-600">미입력</b> : <b>{fmtWon(o.make_cost)}</b>}</p>
            )}
          </div>
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
            {!o.has_drawing && (o as { drawing_archived_at?: string | null }).drawing_archived_at ? <Badge>도면 삭제됨 ({fmtDate((o as { drawing_archived_at?: string }).drawing_archived_at)})</Badge> : null}
            {canEdit && o.status !== 'paid' && <Button tone="plain" onClick={() => setEditing(true)}>내용 수정</Button>}
          </div>
        </div>
      )}
    </Modal>
  );
}
