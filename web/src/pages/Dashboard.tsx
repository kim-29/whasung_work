import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg } from '../api';
import { KIND_LABEL, STATUS_LABEL, type Kind, type Status } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

interface UnpaidRow {
  id: number; company: string; kind: Kind; ordered_at: string; completed_at: string | null;
  actual_weight: number | null; has_unknown_bar: number; has_drawing: number; colors: string | null;
}

const TABS = ['미납 거래내역', '월간 거래내역', '자재 사용내역', '업체별 미납'] as const;

export default function Dashboard() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <div className="space-y-4">
      <h1 className="no-print text-2xl font-bold">대시보드</h1>
      <div className="no-print grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`min-h-12 rounded-xl px-2 text-base font-bold ${tab === t ? 'bg-blue-600 text-white' : 'bg-white'}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === TABS[0] && <Unpaid />}
      {tab === TABS[1] && <Monthly />}
      {tab === TABS[2] && <Usage />}
      {tab === TABS[3] && <ByCompany />}
    </div>
  );
}

function Unpaid() {
  const qc = useQueryClient();
  const toast = useToast();
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['unpaid'], queryFn: () => api<UnpaidRow[]>('/dashboard/unpaid') });

  const pay = async (r: UnpaidRow) => {
    if (!window.confirm(`${r.company} (${fmtKg(r.actual_weight)}) 납입 처리할까요?\n오늘 날짜로 완납 처리됩니다.`)) return;
    try {
      await api(`/orders/${r.id}/pay`, { body: {} });
      toast(`${r.company} 납입 처리했습니다.`);
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-3">
      {q.isLoading && <p className="text-lg">불러오는 중...</p>}
      {q.data?.length === 0 && <p className="py-10 text-center text-xl text-slate-500">미납 내역이 없습니다. 👍</p>}
      {q.data?.map((r) => (
        <Card key={r.id} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xl font-bold">{r.company}</span>
            <Badge>{KIND_LABEL[r.kind]}</Badge>
            {r.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
          </div>
          <p className="text-base text-slate-600">
            지시 {fmtDate(r.ordered_at)} · 완료 {fmtDate(r.completed_at)} · {r.colors || '색상 없음'} · <b>{fmtKg(r.actual_weight)}</b>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button tone="plain" onClick={() => setDetail(r.id)}>세부내역 / 수정</Button>
            {r.has_drawing ? <Button tone="plain" onClick={() => openDrawing(r.id).catch((e) => toast(e.message, 'error'))}>도면</Button> : null}
            <Button tone="success" className="ml-auto" onClick={() => pay(r)}>납입</Button>
          </div>
        </Card>
      ))}
      {detail !== null && <OrderDetailModal id={detail} canEdit onClose={() => setDetail(null)} />}
    </div>
  );
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

function Monthly() {
  const [month, setMonth] = useState(thisMonth());
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['monthly', month],
    queryFn: () =>
      api<{
        summary: { count: number; total_weight: number; paid_count: number; unpaid_count: number };
        orders: { id: number; company: string; kind: Kind; status: Status; actual_weight: number | null; ordered_at: string; paid_at: string | null }[];
      }>(`/dashboard/monthly?month=${month}`),
  });
  const s = q.data?.summary;
  return (
    <div className="space-y-3">
      <Field label="조회할 달"><input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} /></Field>
      {s && (
        <Card className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          <div><p className="text-sm text-slate-500">전체</p><p className="text-2xl font-bold">{s.count}건</p></div>
          <div><p className="text-sm text-slate-500">총 무게</p><p className="text-2xl font-bold">{fmtKg(s.total_weight)}</p></div>
          <div><p className="text-sm text-slate-500">완납</p><p className="text-2xl font-bold text-emerald-700">{s.paid_count ?? 0}건</p></div>
          <div><p className="text-sm text-slate-500">미납</p><p className="text-2xl font-bold text-red-600">{s.unpaid_count ?? 0}건</p></div>
        </Card>
      )}
      {q.data?.orders.map((o) => (
        <Card key={o.id} className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold">{o.company}</span>
          <Badge>{KIND_LABEL[o.kind]}</Badge>
          <Badge color={o.status === 'paid' ? 'green' : o.status === 'unpaid' ? 'red' : 'amber'}>{STATUS_LABEL[o.status]}</Badge>
          <span className="text-base text-slate-600">{fmtDate(o.ordered_at)} · {fmtKg(o.actual_weight)}</span>
          <Button tone="plain" className="ml-auto" onClick={() => setDetail(o.id)}>세부내역</Button>
        </Card>
      ))}
      {detail !== null && <OrderDetailModal id={detail} canEdit onClose={() => setDetail(null)} />}
    </div>
  );
}

function Usage() {
  const [from, setFrom] = useState(`${thisMonth()}-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const q = useQuery({
    queryKey: ['usage', from, to],
    queryFn: () => api<{ bar_name: string; total_qty: number; total_m: number; theory_kg: number }[]>(`/dashboard/usage?from=${from}&to=${to}`),
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="시작일"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="끝나는 날"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Card>
        <p className="mb-2 text-base text-slate-500">많이 사용한 순서입니다.</p>
        <table className="w-full text-left text-base">
          <thead><tr className="border-b-2"><th className="py-2">순위</th><th>바 이름</th><th>수량</th><th>사용 길이</th><th>예상 무게</th></tr></thead>
          <tbody>
            {q.data?.map((r, i) => (
              <tr key={r.bar_name} className="border-b">
                <td className="py-2">{i + 1}</td><td className="font-bold">{r.bar_name}</td>
                <td>{r.total_qty}개</td><td>{r.total_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m</td><td>{fmtKg(r.theory_kg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data?.length === 0 && <p className="py-6 text-center text-slate-500">사용 내역이 없습니다.</p>}
      </Card>
    </div>
  );
}

function ByCompany() {
  const [company, setCompany] = useState('');
  const summary = useQuery({
    queryKey: ['by-company'],
    queryFn: () => api<{ company: string; count: number; total_weight: number }[]>('/dashboard/by-company'),
  });
  const detail = useQuery({
    queryKey: ['by-company', company],
    enabled: !!company,
    queryFn: () => api<{ id: number; kind: Kind; ordered_at: string; completed_at: string | null; actual_weight: number | null; colors: string | null }[]>(
      `/dashboard/by-company?company=${encodeURIComponent(company)}`),
  });
  const total = detail.data?.reduce((a, r) => a + (r.actual_weight ?? 0), 0) ?? 0;

  return (
    <div className="space-y-3">
      <div className="no-print">
        <Field label="업체 선택">
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">전체 업체 보기</option>
            {summary.data?.map((c) => <option key={c.company} value={c.company}>{c.company} ({c.count}건)</option>)}
          </select>
        </Field>
      </div>
      {!company && summary.data?.map((c) => (
        <Card key={c.company} className="flex items-center justify-between">
          <span className="text-lg font-bold">{c.company}</span>
          <span className="text-base">{c.count}건 · {fmtKg(c.total_weight)}</span>
          <Button tone="plain" className="no-print" onClick={() => setCompany(c.company)}>명세 보기</Button>
        </Card>
      ))}
      {company && detail.data && (
        <Card>
          <h2 className="mb-1 text-2xl font-bold">{company} 미납 명세</h2>
          <p className="mb-3 text-base text-slate-500">출력일 {new Date().toLocaleDateString('ko-KR')}</p>
          <table className="w-full text-left text-base">
            <thead><tr className="border-b-2"><th className="py-2">지시일</th><th>완료일</th><th>구분</th><th>색상</th><th className="text-right">무게</th></tr></thead>
            <tbody>
              {detail.data.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="py-2">{fmtDate(r.ordered_at)}</td><td>{fmtDate(r.completed_at)}</td>
                  <td>{KIND_LABEL[r.kind]}</td><td>{r.colors || '-'}</td><td className="text-right">{fmtKg(r.actual_weight)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4} className="pt-3 font-bold">합계 {detail.data.length}건</td><td className="pt-3 text-right text-lg font-bold">{fmtKg(total)}</td></tr></tfoot>
          </table>
          <Button className="no-print mt-4 w-full" onClick={() => window.print()}>인쇄하기</Button>
        </Card>
      )}
    </div>
  );
}
