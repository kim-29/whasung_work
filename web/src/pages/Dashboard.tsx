import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg, fmtWon } from '../api';
import { useAuth } from '../auth';
import { KIND_LABEL, STATUS_LABEL, type Color, type Kind, type Status } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

interface UnpaidRow {
  id: number; company: string; kind: Kind; color: Color | null; group_id: number | null;
  ordered_at: string; completed_at: string | null; actual_weight: number | null;
  has_unknown_bar: number; has_drawing: number; amount: number | null;
}

// 보여주는 순서: 월간 → 자재 사용 → 미납 → 업체별 미납
const TABS = ['월간 거래내역', '자재 사용내역', '미납 거래내역', '업체별 미납'] as const;

export default function Dashboard() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <div className="space-y-3">
      <h1 className="no-print text-xl font-bold">대시보드</h1>
      <div className="no-print grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`min-h-11 rounded-xl border px-2 text-base font-semibold ${tab === t ? 'border-black bg-slate-900 text-white' : 'border-slate-400 bg-white'}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === TABS[0] && <Monthly />}
      {tab === TABS[1] && <Usage />}
      {tab === TABS[2] && <Unpaid />}
      {tab === TABS[3] && <ByCompany />}
    </div>
  );
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const Th = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <th className={`py-2 font-semibold ${right ? 'text-right' : ''}`}>{children}</th>
);

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  );
}

function Monthly() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = user!.role === 'admin';
  const [month, setMonth] = useState(thisMonth());
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['monthly', month],
    queryFn: () =>
      api<{
        summary: { count: number; total_weight: number; total_amount: number; paid_count: number; unpaid_count: number };
        orders: { id: number; company: string; kind: Kind; color: Color | null; status: Status; actual_weight: number | null; amount: number | null; ordered_at: string; completed_at: string | null; paid_at: string | null }[];
      }>(`/dashboard/monthly?month=${month}`),
  });
  const s = q.data?.summary;

  const remove = async (o: { id: number; company: string; color: Color | null; status: Status; actual_weight: number | null }) => {
    const label = `${o.company}${o.color ? ` (${o.color})` : ''} ${STATUS_LABEL[o.status]} ${fmtKg(o.actual_weight)}`;
    if (!window.confirm(`${label}\n\n이 거래내역을 삭제할까요? 삭제하면 되돌릴 수 없습니다.`)) return;
    try {
      await api(`/orders/${o.id}`, { method: 'DELETE' });
      qc.invalidateQueries();
      toast(`${o.company} 거래내역을 삭제했습니다.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-2.5">
      <Field label="조회할 달" inline><input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} /></Field>
      {s && (
        <Card className="grid grid-cols-2 gap-3 text-center sm:grid-cols-5">
          <div><p className="text-sm text-slate-500">전체</p><p className="text-xl font-bold">{s.count}건</p></div>
          <div><p className="text-sm text-slate-500">총 무게</p><p className="text-xl font-bold">{fmtKg(s.total_weight)}</p></div>
          <div><p className="text-sm text-slate-500">금액 합계</p><p className="text-xl font-bold">{fmtWon(s.total_amount)}</p></div>
          <div><p className="text-sm text-slate-500">완납</p><p className="text-xl font-bold">{s.paid_count ?? 0}건</p></div>
          <div><p className="text-sm text-slate-500">미납</p><p className="text-xl font-bold text-red-600">{s.unpaid_count ?? 0}건</p></div>
        </Card>
      )}
      {q.data?.orders.map((o) => (
        <Card key={o.id} className="space-y-1.5 !p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold">{o.company}</span>
            <Badge>{KIND_LABEL[o.kind]}</Badge>
            {o.color && <Badge>{o.color}</Badge>}
            <Badge color={o.status === 'paid' ? 'green' : o.status === 'unpaid' ? 'red' : 'amber'}>{STATUS_LABEL[o.status]}</Badge>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-sm text-slate-600">
              지시 {fmtDate(o.ordered_at)}
              {o.completed_at && <> · 완료 {fmtDate(o.completed_at)}</>}
              {o.paid_at && <> · 납입 {fmtDate(o.paid_at)}</>}
              {' · '}{fmtKg(o.actual_weight)}
            </p>
            {o.actual_weight != null && (
              <p className={`text-base font-bold ${o.amount == null ? 'text-red-600' : ''}`}>{fmtWon(o.amount)}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button tone="plain" className="!min-h-9 text-sm" onClick={() => setDetail(o.id)}>세부내역</Button>
            {isAdmin && (
              <Button tone="plain" className="ml-auto flex !min-h-9 items-center gap-1.5 text-sm text-red-700" title="삭제" aria-label="삭제" onClick={() => remove(o)}>
                <TrashIcon /> 삭제
              </Button>
            )}
          </div>
        </Card>
      ))}
      {q.data?.orders.length === 0 && <p className="py-8 text-center text-slate-500">이 달의 거래내역이 없습니다.</p>}
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
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="시작일"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="끝나는 날"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Card>
        <p className="mb-2 text-sm text-slate-500">많이 사용한 순서입니다.</p>
        <table className="w-full text-left text-base">
          <thead><tr className="border-b border-slate-400"><Th>순위</Th><Th>바 이름</Th><Th>수량</Th><Th>사용 길이</Th><Th>예상 무게</Th></tr></thead>
          <tbody>
            {q.data?.map((r, i) => (
              <tr key={r.bar_name} className="border-b border-slate-200">
                <td className="py-2">{i + 1}</td><td className="font-semibold">{r.bar_name}</td>
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

function Unpaid() {
  const qc = useQueryClient();
  const toast = useToast();
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['unpaid'], queryFn: () => api<UnpaidRow[]>('/dashboard/unpaid') });
  const total = q.data?.reduce((a, r) => a + (r.amount ?? 0), 0) ?? 0;

  const pay = async (r: UnpaidRow) => {
    if (!window.confirm(`${r.company}${r.color ? ` (${r.color})` : ''} ${fmtKg(r.actual_weight)} ${fmtWon(r.amount)}\n납입 처리할까요? 오늘 날짜로 완납 처리됩니다.`)) return;
    try {
      await api(`/orders/${r.id}/pay`, { body: {} });
      toast(`${r.company} 납입 처리했습니다.`);
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-2.5">
      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {q.data && q.data.length > 0 && (
        <Card className="flex items-center justify-between !p-3">
          <span className="text-base font-semibold">미납 합계 {q.data.length}건</span>
          <span className="text-lg font-bold">{fmtWon(total)}</span>
        </Card>
      )}
      {q.data?.length === 0 && <p className="py-10 text-center text-lg text-slate-500">미납 내역이 없습니다.</p>}
      {q.data?.map((r) => (
        <Card key={r.id} className="space-y-2 !p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold">{r.company}</span>
            <Badge>{KIND_LABEL[r.kind]}</Badge>
            {r.color && <Badge>{r.color}</Badge>}
            {r.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-slate-600">지시 {fmtDate(r.ordered_at)} · 완료 {fmtDate(r.completed_at)} · {fmtKg(r.actual_weight)}</p>
            <p className={`text-lg font-bold ${r.amount == null ? 'text-red-600' : ''}`}>{fmtWon(r.amount)}</p>
          </div>
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

function ByCompany() {
  const [company, setCompany] = useState('');
  const summary = useQuery({
    queryKey: ['by-company'],
    queryFn: () => api<{ company: string; count: number; total_weight: number; total_amount: number; unpriced: number }[]>('/dashboard/by-company'),
  });
  const detail = useQuery({
    queryKey: ['by-company', company],
    enabled: !!company,
    queryFn: () => api<{ id: number; kind: Kind; color: Color | null; ordered_at: string; completed_at: string | null; actual_weight: number | null; amount: number | null }[]>(
      `/dashboard/by-company?company=${encodeURIComponent(company)}`),
  });
  const totalKg = detail.data?.reduce((a, r) => a + (r.actual_weight ?? 0), 0) ?? 0;
  const totalWon = detail.data?.reduce((a, r) => a + (r.amount ?? 0), 0) ?? 0;
  const unpriced = detail.data?.filter((r) => r.amount == null).length ?? 0;

  return (
    <div className="space-y-2.5">
      <div className="no-print">
        <Field label="업체 선택" inline>
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">전체 업체 보기</option>
            {summary.data?.map((c) => <option key={c.company} value={c.company}>{c.company} ({c.count}건)</option>)}
          </select>
        </Field>
      </div>
      {!company && summary.data?.length === 0 && <p className="py-8 text-center text-slate-500">미납 업체가 없습니다.</p>}
      {!company && summary.data?.map((c) => (
        <Card key={c.company} className="flex flex-wrap items-center gap-x-4 gap-y-1 !p-3">
          <span className="text-base font-bold">{c.company}</span>
          <span className="text-sm text-slate-600">{c.count}건 · {fmtKg(c.total_weight)}</span>
          <span className="ml-auto text-base font-bold">{fmtWon(c.total_amount)}{c.unpriced > 0 && <span className="ml-1 text-sm font-normal text-red-600">(단가 미설정 {c.unpriced}건 제외)</span>}</span>
          <Button tone="plain" className="no-print !min-h-9 text-sm" onClick={() => setCompany(c.company)}>명세 보기</Button>
        </Card>
      ))}
      {company && detail.data && (
        <Card>
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold">{company} 미납 명세</h2>
              <p className="text-sm text-slate-500">출력일 {new Date().toLocaleDateString('ko-KR')}</p>
            </div>
            <Button tone="plain" className="no-print" onClick={() => setCompany('')}>명세 닫기</Button>
          </div>
          <table className="w-full text-left text-base">
            <thead><tr className="border-b border-slate-400"><Th>지시일</Th><Th>완료일</Th><Th>구분</Th><Th>색상</Th><Th right>무게</Th><Th right>금액</Th></tr></thead>
            <tbody>
              {detail.data.map((r) => (
                <tr key={r.id} className="border-b border-slate-200">
                  <td className="py-2">{fmtDate(r.ordered_at)}</td><td>{fmtDate(r.completed_at)}</td>
                  <td>{KIND_LABEL[r.kind]}</td><td>{r.color || '-'}</td>
                  <td className="text-right">{fmtKg(r.actual_weight)}</td>
                  <td className={`text-right ${r.amount == null ? 'text-red-600' : ''}`}>{fmtWon(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-500">
                <td colSpan={4} className="pt-3 font-semibold">합계 {detail.data.length}건</td>
                <td className="pt-3 text-right font-bold">{fmtKg(totalKg)}</td>
                <td className="pt-3 text-right text-lg font-bold">{fmtWon(totalWon)}</td>
              </tr>
            </tfoot>
          </table>
          {unpriced > 0 && <p className="mt-2 text-sm font-semibold text-red-600">단가가 설정되지 않은 {unpriced}건은 금액에서 제외되었습니다.</p>}
          <div className="no-print mt-4 grid grid-cols-2 gap-2">
            <Button onClick={() => window.print()}>인쇄하기</Button>
            <Button tone="plain" onClick={() => setCompany('')}>명세 닫기</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
