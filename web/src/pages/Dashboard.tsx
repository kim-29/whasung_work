import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate, fmtKg, fmtWon, kstMonth, kstToday } from '../api';
import { useAuth } from '../auth';
import { KIND_LABEL, STATUS_LABEL, type Color, type Kind, type Status } from '../types';
import { Badge, Button, Card, Field, useToast } from '../ui';
import { orderMail, statementMail, useCompanyMail, type MailOrder } from '../mail';
import { MakeCostBox, PriceLine, toStock, totalOf } from './money';
import OrderDetailModal, { openDrawing } from './OrderDetailModal';

interface UnpaidRow {
  id: number; company: string; kind: Kind; color: Color | null; group_id: number | null;
  ordered_at: string; completed_at: string | null; actual_weight: number | null;
  has_unknown_bar: number; has_drawing: number;
  price_per_kg: number | null; amount: number | null; make_cost: number | null;
}

// 보여주는 순서: 월간 → 미납 → 업체별 미납 → 자재 사용
const TABS = ['월간 거래내역', '미납 거래내역', '업체별 미납', '자재 사용내역'] as const;

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
      {tab === TABS[1] && <Unpaid />}
      {tab === TABS[2] && <ByCompany />}
      {tab === TABS[3] && <Usage />}
    </div>
  );
}

/** 제작비용·단가가 비어 있으면 메일에 '미입력/단가 미설정'으로 나간다는 경고 문구 (없으면 undefined) */
const mailWarning = (rows: { kind: Kind; make_cost: number | null; amount: number | null }[]) => {
  const noMake = rows.filter((o) => o.kind === 'make' && o.make_cost == null).length;
  const noPrice = rows.filter((o) => o.amount == null).length;
  const parts = [noMake && `제작비용이 입력되지 않은 건이 ${noMake}건 있습니다.`, noPrice && `단가가 설정되지 않은 건이 ${noPrice}건 있습니다.`].filter(Boolean);
  return parts.length ? parts.join('\n') + '\n메일에는 \"미입력\" 또는 \"단가 미설정\"으로 표시됩니다.' : undefined;
};

const Th = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <th className={`whitespace-nowrap py-2 pr-2 font-semibold ${right ? 'text-right' : ''}`}>{children}</th>
);

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  );
}

// ---------------------------------------------------------------- 월간 거래내역
function Monthly() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = user!.role === 'admin';
  const mail = useCompanyMail();
  const [month, setMonth] = useState(kstMonth());
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['monthly', month],
    queryFn: () =>
      api<{
        summary: { count: number; total_weight: number; total_amount: number; total_make_cost: number; make_cost_missing: number; paid_count: number; unpaid_count: number };
        orders: {
          id: number; company: string; kind: Kind; color: Color | null; status: Status; actual_weight: number | null;
          ordered_at: string; completed_at: string | null; paid_at: string | null; has_drawing: number; drawing_archived: number;
          price_per_kg: number | null; amount: number | null; make_cost: number | null;
        }[];
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
      <Field label="조회할 달" inline><input type="month" value={month} onChange={(e) => setMonth(e.target.value || kstMonth())} /></Field>
      <p className="text-sm text-slate-500">지시일(작업지시서를 보낸 날, 한국 시간) 기준입니다.</p>
      {s && (
        <Card className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3">
          <div><p className="text-sm text-slate-500">전체</p><p className="text-xl font-bold">{s.count}건</p></div>
          <div><p className="text-sm text-slate-500">총 무게</p><p className="text-xl font-bold">{fmtKg(s.total_weight)}</p></div>
          <div><p className="text-sm text-slate-500">금액 합계 (제작비용 포함)</p><p className="text-xl font-bold">{fmtWon(s.total_amount + s.total_make_cost)}</p></div>
          <div><p className="text-sm text-slate-500">완납</p><p className="text-xl font-bold">{s.paid_count ?? 0}건</p></div>
          <div><p className="text-sm text-slate-500">미납</p><p className="text-xl font-bold text-red-600">{s.unpaid_count ?? 0}건</p></div>
          <div><p className="text-sm text-slate-500">제작비용 미입력</p><p className={`text-xl font-bold ${s.make_cost_missing ? 'text-red-600' : ''}`}>{s.make_cost_missing ?? 0}건</p></div>
        </Card>
      )}
      {q.data?.orders.map((o) => (
        <Card key={o.id} className="space-y-1.5 !px-3 !py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base font-bold">{o.company}</span>
            <Badge>{KIND_LABEL[o.kind]}</Badge>
            {o.color && <Badge>{o.color}</Badge>}
            <Badge color={o.status === 'paid' ? 'green' : o.status === 'unpaid' ? 'red' : 'amber'}>{STATUS_LABEL[o.status]}</Badge>
            <span className="ml-auto text-sm text-slate-500">
              지시 {fmtDate(o.ordered_at)}
              {o.completed_at && <> · 완료 {fmtDate(o.completed_at)}</>}
              {o.paid_at && <> · 납입 {fmtDate(o.paid_at)}</>}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <PriceLine weight={o.actual_weight} pricePerKg={o.price_per_kg} amount={o.amount} />
            {o.kind === 'make' && <MakeCostBox inline orderId={o.id} status={o.status} makeCost={o.make_cost} />}
            {o.actual_weight != null && (
              <span className="ml-auto whitespace-nowrap text-base font-bold">합계 {fmtWon(totalOf(o.amount, o.kind === 'make' ? o.make_cost : null))}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button tone="plain" className="!min-h-9 text-sm" onClick={() => setDetail(o.id)}>세부내역</Button>
            {o.has_drawing ? <Button tone="plain" className="!min-h-9 text-sm" onClick={() => openDrawing(o.id).catch((e) => toast(e.message, 'error'))}>도면</Button> : null}
            {!o.has_drawing && o.drawing_archived ? <Badge>도면 보관됨</Badge> : null}
            {(o.status === 'unpaid' || o.status === 'paid') && (
              <Button tone="plain" className="!min-h-9 text-sm" onClick={() => mail.send(o.company, orderMail(o), mailWarning([o]))}>이메일로 내용 전송</Button>
            )}
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
      {mail.prompt}
    </div>
  );
}

// ---------------------------------------------------------------- 자재 사용내역
function Usage() {
  const [from, setFrom] = useState(`${kstMonth()}-01`);
  const [to, setTo] = useState(kstToday());
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
        <p className="mb-1 text-sm font-semibold text-slate-700">※ 지시일(작업지시서를 보낸 날, 한국 시간)을 기준으로 산정한 사용내역입니다.</p>
        <p className="mb-2 text-sm text-slate-500">많이 사용한 순서입니다. 진행 중인 작업도 포함됩니다. 환산수량은 사용 길이를 정척 6m 한 본으로 나눈 값입니다.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-base">
            <thead><tr className="border-b border-slate-400"><Th>순위</Th><Th>바 이름</Th><Th>사용 길이</Th><Th>환산수량</Th><Th>예상 무게</Th></tr></thead>
            <tbody>
              {q.data?.map((r, i) => (
                <tr key={r.bar_name} className="border-b border-slate-200">
                  <td className="py-2 pr-2">{i + 1}</td><td className="pr-2 font-semibold">{r.bar_name}</td>
                  <td className="whitespace-nowrap pr-2">{r.total_m.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}m</td>
                  <td className="whitespace-nowrap pr-2 font-semibold">{toStock(r.total_m)}</td>
                  <td className="whitespace-nowrap">{fmtKg(r.theory_kg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {q.data?.length === 0 && <p className="py-6 text-center text-slate-500">사용 내역이 없습니다.</p>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 미납 거래내역
function Unpaid() {
  const qc = useQueryClient();
  const toast = useToast();
  const mail = useCompanyMail();
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['unpaid'], queryFn: () => api<UnpaidRow[]>('/dashboard/unpaid') });
  const rows = q.data ?? [];
  const rowTotal = (r: UnpaidRow) => totalOf(r.amount, r.kind === 'make' ? r.make_cost : null) ?? 0;
  const grand = rows.reduce((a, r) => a + rowTotal(r), 0);
  // 같은 지시서에서 색상별로 나뉜 건(둘 이상)을 찾는다
  const byGroup = new Map<number, UnpaidRow[]>();
  rows.forEach((r) => r.group_id != null && byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r]));
  const siblings = (r: UnpaidRow) => (r.group_id != null ? byGroup.get(r.group_id) ?? [r] : [r]);

  const payRows = async (list: UnpaidRow[]) => {
    const total = list.reduce((a, r) => a + rowTotal(r), 0);
    const missing = list.filter((r) => r.kind === 'make' && r.make_cost == null).length;
    const names = [...new Set(list.map((r) => r.company))].join(', ');
    const msg = `${names} ${list.length}건, 합계 ${fmtWon(total)}\n납입 처리할까요? 오늘 날짜로 완납 처리됩니다.` +
      (missing ? `\n\n⚠ 제작비용이 입력되지 않은 건이 ${missing}건 있습니다. 그대로 납입하면 이후 제작비용을 입력할 수 없습니다.` : '');
    if (!window.confirm(msg)) return;
    try {
      if (list.length === 1) await api(`/orders/${list[0].id}/pay`, { body: {} });
      else await api('/orders/pay-batch', { body: { ids: list.map((r) => r.id) } });
      toast(`${names} 납입 처리했습니다. (${list.length}건)`);
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-2.5">
      {q.isLoading && <p className="text-base">불러오는 중...</p>}
      {rows.length > 0 && (
        <Card className="flex items-center justify-between !p-3">
          <span className="text-base font-semibold">미납 합계 {rows.length}건 (제작비용 포함)</span>
          <span className="text-lg font-bold">{fmtWon(grand)}</span>
        </Card>
      )}
      {rows.length === 0 && !q.isLoading && <p className="py-10 text-center text-lg text-slate-500">미납 내역이 없습니다.</p>}
      {rows.map((r) => {
        const group = siblings(r);
        return (
          <Card key={r.id} className="space-y-1.5 !px-3 !py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-base font-bold">{r.company}</span>
              <Badge>{KIND_LABEL[r.kind]}</Badge>
              {r.color && <Badge>{r.color}</Badge>}
              {group.length > 1 && <Badge>같은 지시서 {group.length}건</Badge>}
              {r.has_unknown_bar ? <Badge color="red">미등록 바</Badge> : null}
              <span className="ml-auto text-sm text-slate-500">지시 {fmtDate(r.ordered_at)} · 완료 {fmtDate(r.completed_at)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <PriceLine weight={r.actual_weight} pricePerKg={r.price_per_kg} amount={r.amount} />
              {r.kind === 'make' && <MakeCostBox inline orderId={r.id} status="unpaid" makeCost={r.make_cost} />}
              <span className="ml-auto whitespace-nowrap text-base font-bold">합계 {fmtWon(rowTotal(r))}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button tone="plain" className="!min-h-9 text-sm" onClick={() => setDetail(r.id)}>세부내역</Button>
              {r.has_drawing ? <Button tone="plain" className="!min-h-9 text-sm" onClick={() => openDrawing(r.id).catch((e) => toast(e.message, 'error'))}>도면</Button> : null}
              <Button tone="plain" className="!min-h-9 text-sm" onClick={() => mail.send(r.company, orderMail(r), mailWarning([r]))}>이메일로 내용 전송</Button>
              <span className="ml-auto flex gap-2">
                {group.length > 1 && <Button tone="plain" className="!min-h-9 text-sm" onClick={() => payRows(group)}>같은 지시서 {group.length}건 함께 납입</Button>}
                <Button tone="success" className="!min-h-9 text-sm" onClick={() => payRows([r])}>납입</Button>
              </span>
            </div>
          </Card>
        );
      })}
      {detail !== null && <OrderDetailModal id={detail} canEdit onClose={() => setDetail(null)} />}
      {mail.prompt}
    </div>
  );
}

// ---------------------------------------------------------------- 업체별 미납
interface CompanyDetailRow {
  id: number; kind: Kind; color: Color | null; group_id: number | null;
  ordered_at: string; completed_at: string | null; actual_weight: number | null;
  price_per_kg: number | null; amount: number | null; make_cost: number | null;
}

function ByCompany() {
  const qc = useQueryClient();
  const toast = useToast();
  const mail = useCompanyMail();
  const [company, setCompany] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const summary = useQuery({
    queryKey: ['by-company'],
    queryFn: () => api<{ company: string; count: number; total_weight: number; total_amount: number; total_make_cost: number; make_cost_missing: number; unpriced: number }[]>('/dashboard/by-company'),
  });
  const detail = useQuery({
    queryKey: ['by-company', company],
    enabled: !!company,
    queryFn: () => api<CompanyDetailRow[]>(`/dashboard/by-company?company=${encodeURIComponent(company)}`),
  });
  const rows = detail.data ?? [];
  const makeOf = (r: CompanyDetailRow) => (r.kind === 'make' ? r.make_cost : null);
  const rowTotal = (r: CompanyDetailRow) => totalOf(r.amount, makeOf(r)) ?? 0;
  const totalKg = rows.reduce((a, r) => a + (r.actual_weight ?? 0), 0);
  const totalAmount = rows.reduce((a, r) => a + (r.amount ?? 0), 0);
  const totalMake = rows.reduce((a, r) => a + (makeOf(r) ?? 0), 0);
  const unpriced = rows.filter((r) => r.amount == null).length;
  const missingMake = rows.filter((r) => r.kind === 'make' && r.make_cost == null).length;

  // 같은 지시서에서 나뉜 건은 함께 체크/해제된다
  const toggle = (r: CompanyDetailRow) => {
    const ids = r.group_id != null ? rows.filter((x) => x.group_id === r.group_id).map((x) => x.id) : [r.id];
    const next = new Set(selected);
    const on = !selected.has(r.id);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    setSelected(next);
  };
  const chosen = rows.filter((r) => selected.has(r.id));

  const paySelected = async () => {
    const total = chosen.reduce((a, r) => a + rowTotal(r), 0);
    const missing = chosen.filter((r) => r.kind === 'make' && r.make_cost == null).length;
    const msg = `${company} ${chosen.length}건, 합계 ${fmtWon(total)}\n선택한 건을 납입 처리할까요? 오늘 날짜로 완납 처리됩니다.` +
      (missing ? `\n\n⚠ 제작비용이 입력되지 않은 건이 ${missing}건 있습니다. 그대로 납입하면 이후 제작비용을 입력할 수 없습니다.` : '');
    if (!window.confirm(msg)) return;
    try {
      if (chosen.length === 1) await api(`/orders/${chosen[0].id}/pay`, { body: {} });
      else await api('/orders/pay-batch', { body: { ids: chosen.map((r) => r.id) } });
      toast(`${company} ${chosen.length}건 납입 처리했습니다.`);
      setSelected(new Set());
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const close = () => { setCompany(''); setSelected(new Set()); };

  return (
    <div className="space-y-2.5">
      <div className="no-print">
        <Field label="업체 선택" inline>
          <select value={company} onChange={(e) => { setCompany(e.target.value); setSelected(new Set()); }}>
            <option value="">전체 업체 보기</option>
            {summary.data?.map((c) => <option key={c.company} value={c.company}>{c.company} ({c.count}건)</option>)}
          </select>
        </Field>
      </div>
      {!company && summary.data?.length === 0 && <p className="py-8 text-center text-slate-500">미납 업체가 없습니다.</p>}
      {!company && summary.data?.map((c) => (
        <Card key={c.company} className="space-y-1 !p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-base font-bold">{c.company}</span>
            <span className="text-sm text-slate-600">{c.count}건 · {fmtKg(c.total_weight)}</span>
            <span className="ml-auto text-base font-bold">{fmtWon(c.total_amount + c.total_make_cost)}</span>
            <Button tone="plain" className="no-print !min-h-9 text-sm" onClick={() => setCompany(c.company)}>명세 보기</Button>
          </div>
          <p className="text-sm text-slate-500">
            판매금액 {fmtWon(c.total_amount)} + 제작비용 {fmtWon(c.total_make_cost)}
            {c.make_cost_missing > 0 && <b className="ml-2 text-red-600">제작비용 미입력 {c.make_cost_missing}건</b>}
            {c.unpriced > 0 && <b className="ml-2 text-red-600">단가 미설정 {c.unpriced}건 제외</b>}
          </p>
        </Card>
      ))}
      {company && detail.data && (
        <Card>
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold">{company} 미납 명세</h2>
              <p className="text-sm text-slate-500">출력일 {new Date().toLocaleDateString('ko-KR')}</p>
            </div>
            <Button tone="plain" className="no-print" onClick={close}>명세 닫기</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-base">
              <thead>
                <tr className="border-b border-slate-400">
                  <th className="no-print w-8 py-2">
                    <input type="checkbox" aria-label="전체 선택" checked={rows.length > 0 && selected.size === rows.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </th>
                  <Th>지시일</Th><Th>완료일</Th><Th>구분</Th><Th>색상</Th><Th right>무게</Th><Th right>단가(원/kg)</Th><Th right>금액</Th><Th right>제작비용</Th><Th right>합계</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-200">
                    <td className="no-print py-2"><input type="checkbox" aria-label="선택" checked={selected.has(r.id)} onChange={() => toggle(r)} /></td>
                    <td className="whitespace-nowrap py-2 pr-2">{fmtDate(r.ordered_at)}</td>
                    <td className="whitespace-nowrap pr-2">{fmtDate(r.completed_at)}</td>
                    <td className="pr-2">{KIND_LABEL[r.kind]}</td><td className="pr-2">{r.color || '-'}</td>
                    <td className="whitespace-nowrap pr-2 text-right">{fmtKg(r.actual_weight)}</td>
                    <td className={`whitespace-nowrap pr-2 text-right ${r.price_per_kg == null ? 'text-red-600' : ''}`}>{r.price_per_kg == null ? '미설정' : r.price_per_kg.toLocaleString('ko-KR')}</td>
                    <td className="whitespace-nowrap pr-2 text-right">{r.amount == null ? '-' : fmtWon(r.amount)}</td>
                    <td className={`whitespace-nowrap pr-2 text-right ${r.kind === 'make' && r.make_cost == null ? 'text-red-600' : ''}`}>
                      {r.kind !== 'make' ? '-' : r.make_cost == null ? '미입력' : fmtWon(r.make_cost)}
                    </td>
                    <td className="whitespace-nowrap text-right font-semibold">{fmtWon(rowTotal(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-500">
                  <td className="no-print" />
                  <td colSpan={4} className="pt-3 font-semibold">합계 {rows.length}건</td>
                  <td className="pt-3 pr-2 text-right font-bold">{fmtKg(totalKg)}</td>
                  <td />
                  <td className="pt-3 pr-2 text-right font-bold">{fmtWon(totalAmount)}</td>
                  <td className="pt-3 pr-2 text-right font-bold">{fmtWon(totalMake)}</td>
                  <td className="pt-3 text-right text-lg font-bold">{fmtWon(totalAmount + totalMake)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="mt-2 space-y-0.5 text-sm font-semibold text-red-600">
            {missingMake > 0 && <p>제작비용 미입력 {missingMake}건 (미입력은 0원으로 계산되어 있습니다)</p>}
            {unpriced > 0 && <p>단가가 설정되지 않은 {unpriced}건은 금액에서 제외되었습니다.</p>}
          </div>
          <div className="no-print mt-4 grid grid-cols-2 gap-2">
            <Button onClick={() => window.print()}>인쇄하기</Button>
            <Button onClick={() => mail.send(company, statementMail(company, rows.map((r) => ({ ...r, company }) as MailOrder)), mailWarning(rows))}>이메일로 내용 전송</Button>
            <Button tone="success" className="col-span-2" disabled={chosen.length === 0} onClick={paySelected}>
              선택 납입{chosen.length ? ` (${chosen.length}건)` : ''}
            </Button>
          </div>
          <p className="no-print mt-1 text-sm text-slate-500">납입할 건을 체크하세요. 같은 지시서에서 나뉜 건은 함께 체크됩니다.</p>
        </Card>
      )}
      {mail.prompt}
    </div>
  );
}
