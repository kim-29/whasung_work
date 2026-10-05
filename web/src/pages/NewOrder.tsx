import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, useToast } from '../ui';
import OrderForm, { type OrderFormValues } from './OrderForm';

export default function NewOrder() {
  const qc = useQueryClient();
  const toast = useToast();
  const [done, setDone] = useState<{ company: string } | null>(null);
  const [drawing, setDrawing] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);

  const send = async (v: OrderFormValues) => {
    const r = await api<{ id: number }>('/orders', { body: v });
    if (drawing) {
      await api(`/orders/${r.id}/drawing`, { method: 'PUT', raw: await drawing.text() }).catch(() =>
        toast('작업지시는 전송했지만 도면 첨부에 실패했습니다. 작업목록에서 다시 첨부해 주세요.', 'error'),
      );
    }
    qc.invalidateQueries();
    setDone({ company: v.company });
  };

  if (done) {
    return (
      <Card className="mt-10 space-y-4 text-center">
        <p className="text-5xl">✅</p>
        <p className="text-2xl font-bold">{done.company} 작업지시를 보냈습니다</p>
        <p className="text-lg text-slate-600">작업장 화면에 바로 표시됩니다.</p>
        <Button className="w-full" onClick={() => { setDone(null); setDrawing(null); setFormKey((k) => k + 1); }}>
          새 작업지시서 쓰기
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">작업지시서</h1>
      <OrderForm
        key={formKey}
        submitLabel="작업장으로 전송"
        allowManual
        onSubmit={send}
        extra={
          <Card>
            <Field label="도면 파일 첨부 (3D 도면 .html, 필요할 때만)">
              <input type="file" accept=".html,text/html" onChange={(e) => setDrawing(e.target.files?.[0] ?? null)} />
            </Field>
          </Card>
        }
      />
    </div>
  );
}
