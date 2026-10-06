import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Card, Field, useToast } from '../ui';
import OrderForm, { type OrderFormValues } from './OrderForm';

export default function NewOrder() {
  const qc = useQueryClient();
  const toast = useToast();
  const [drawing, setDrawing] = useState<File | null>(null);
  // 전송하면 같은 화면이 비워진 상태로 돌아온다 (key를 바꿔 폼을 새로 만든다)
  const [formKey, setFormKey] = useState(0);

  const send = async (v: OrderFormValues) => {
    // 색상이 섞인 절단은 서버가 색상별 작업으로 나누어 저장한다
    const r = await api<{ id: number; orders: { color: string }[] }>('/orders', { body: v });
    if (drawing) {
      await api(`/orders/${r.id}/drawing`, { method: 'PUT', raw: await drawing.text() }).catch(() =>
        toast('작업지시는 전송했지만 도면 첨부에 실패했습니다. 작업목록에서 다시 첨부해 주세요.', 'error'),
      );
    }
    qc.invalidateQueries();
    const split = r.orders.length > 1 ? ` (색상별 ${r.orders.length}건: ${r.orders.map((o) => o.color).join(', ')})` : '';
    toast(
      v.manual_weight
        ? `${v.company} 완료 처리했습니다. 미납 거래내역으로 넘어갔습니다.${split}`
        : `${v.company} 작업지시를 작업장으로 전송했습니다.${split}`,
    );
    setDrawing(null);
    setFormKey((k) => k + 1);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">작업지시서</h1>
      <OrderForm
        key={formKey}
        submitLabel="작업장으로 전송"
        allowManual
        compact
        onSubmit={send}
        extra={
          <Card>
            <Field label="도면 첨부" inline>
              <input type="file" accept=".html,text/html" onChange={(e) => setDrawing(e.target.files?.[0] ?? null)} />
            </Field>
            <p className="mt-1 text-sm text-slate-500">3D 도면(.html)이 있을 때만 첨부합니다.</p>
          </Card>
        }
      />
    </div>
  );
}
