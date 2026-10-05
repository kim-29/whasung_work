import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, useToast } from '../ui';
import OrderForm, { type OrderFormValues } from './OrderForm';

export default function NewOrder() {
  const qc = useQueryClient();
  const toast = useToast();
  const [done, setDone] = useState<{ company: string; count: number; colors: string[] } | null>(null);
  const [drawing, setDrawing] = useState<File | null>(null);
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
    setDone({ company: v.company, count: r.orders.length, colors: r.orders.map((o) => o.color) });
  };

  if (done) {
    return (
      <Card className="mt-8 space-y-3 text-center">
        <p className="text-xl font-bold">{done.company} 작업지시를 전송했습니다</p>
        {done.count > 1 && (
          <p className="text-base text-slate-700">색상별로 {done.count}건으로 나누어 접수되었습니다. ({done.colors.join(', ')})</p>
        )}
        <p className="text-base text-slate-600">작업장 화면에 바로 표시됩니다.</p>
        <Button className="w-full" onClick={() => { setDone(null); setDrawing(null); setFormKey((k) => k + 1); }}>
          새 작업지시서 쓰기
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">작업지시서</h1>
      <OrderForm
        key={formKey}
        submitLabel="작업장으로 전송"
        allowManual
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
