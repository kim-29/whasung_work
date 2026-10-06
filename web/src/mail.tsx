import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, fmtDate, fmtKg, fmtWon } from './api';
import { KIND_LABEL, type Company, type Kind, type Status } from './types';
import { Button, Field, Modal, useToast } from './ui';

// 거래 내용을 메일로 보내는 기능 (메일 앱 열기 방식).
// 버튼을 누르면 사장님의 메일 프로그램(또는 웹메일)에 받는 사람·제목·내용이 채워져 열리고, 직접 '보내기'를 누른다.
// 서버가 대신 보내는 것이 아니므로 비용·설정이 없고, 보낸 메일은 사장님 메일함에 남는다.

const SIGNATURE = '화성알루미늄';
const NL = '\r\n';

export interface MailOrder {
  company: string;
  kind: Kind;
  color: string | null;
  status?: Status;
  ordered_at: string;
  completed_at: string | null;
  paid_at?: string | null;
  actual_weight: number | null;
  price_per_kg: number | null;
  amount: number | null;
  make_cost: number | null;
}

const won = (n: number | null | undefined) => (n == null ? '단가 미설정' : fmtWon(n));

/** 한 줄 설명: 무게 × 단가 = 금액 (+ 제작비용) = 합계 */
function moneyLines(o: Pick<MailOrder, 'kind' | 'actual_weight' | 'price_per_kg' | 'amount' | 'make_cost'>): string[] {
  const lines: string[] = [];
  const unit = o.price_per_kg == null ? '단가 미설정' : `${o.price_per_kg.toLocaleString('ko-KR')}원/kg`;
  lines.push(`무게·금액: ${fmtKg(o.actual_weight)} × ${unit} = ${won(o.amount)}`);
  const make = o.kind === 'make' ? o.make_cost : null;
  if (o.kind === 'make') lines.push(`제작비용(인건비+부속): ${o.make_cost == null ? '미입력' : fmtWon(o.make_cost)}`);
  const total = o.amount == null && make == null ? null : (o.amount ?? 0) + (make ?? 0);
  lines.push(`합계: ${won(total)}`);
  return lines;
}

/** 작업 한 건의 내용을 메일로 */
export function orderMail(o: MailOrder): { subject: string; body: string } {
  const what = `${KIND_LABEL[o.kind]}${o.color ? ` / ${o.color}` : ''}`;
  const body = [
    `${o.company} 담당자님께,`,
    '',
    '안녕하세요. 화성알루미늄입니다.',
    '아래와 같이 작업이 완료되어 거래 내용을 보내 드립니다.',
    '',
    `■ 작업: ${what}`,
    `■ 지시일: ${fmtDate(o.ordered_at)}   완료일: ${fmtDate(o.completed_at)}${o.paid_at ? `   납입일: ${fmtDate(o.paid_at)}` : ''}`,
    ...moneyLines(o).map((l) => `■ ${l}`),
    '',
    '감사합니다.',
    SIGNATURE,
  ].join(NL);
  return { subject: `[${SIGNATURE}] ${o.company} 거래 내용 (${what}, ${fmtDate(o.ordered_at)})`, body };
}

/** 업체별 미납 명세 전체를 메일로 */
export function statementMail(company: string, rows: MailOrder[]): { subject: string; body: string } {
  let kg = 0;
  let amount = 0;
  let make = 0;
  const lines = rows.map((o, i) => {
    kg += o.actual_weight ?? 0;
    amount += o.amount ?? 0;
    make += o.kind === 'make' ? o.make_cost ?? 0 : 0;
    const total = (o.amount ?? 0) + (o.kind === 'make' ? o.make_cost ?? 0 : 0);
    const unit = o.price_per_kg == null ? '단가 미설정' : `${o.price_per_kg.toLocaleString('ko-KR')}원/kg`;
    return (
      `${i + 1}. ${fmtDate(o.ordered_at)} ${KIND_LABEL[o.kind]}${o.color ? `/${o.color}` : ''}  ` +
      `${fmtKg(o.actual_weight)} × ${unit} = ${won(o.amount)}` +
      (o.kind === 'make' ? `  + 제작비용 ${o.make_cost == null ? '미입력' : fmtWon(o.make_cost)}` : '') +
      `  → ${fmtWon(total)}`
    );
  });
  const missing = rows.filter((o) => o.kind === 'make' && o.make_cost == null).length;
  const body = [
    `${company} 담당자님께,`,
    '',
    '안녕하세요. 화성알루미늄입니다.',
    `현재 미납 내역 ${rows.length}건의 명세를 보내 드립니다.`,
    '',
    ...lines,
    '',
    `■ 무게 합계: ${fmtKg(kg)}`,
    `■ 판매금액: ${fmtWon(amount)}`,
    `■ 제작비용: ${fmtWon(make)}${missing ? ` (제작비용 미입력 ${missing}건 제외)` : ''}`,
    `■ 총 합계: ${fmtWon(amount + make)}`,
    '',
    '확인 부탁드립니다. 감사합니다.',
    SIGNATURE,
  ].join(NL);
  return { subject: `[${SIGNATURE}] ${company} 미납 명세 (${new Date().toLocaleDateString('ko-KR')})`, body };
}

const MAX_URL = 1900; // 메일 프로그램마다 주소 길이 제한이 달라 안전한 길이로 제한한다

/** 메일 앱을 연다. 내용이 너무 길면 클립보드에 복사해 두고 짧은 안내만 채워서 연다. */
function openMailApp(email: string, subject: string, body: string, notify: (m: string) => void) {
  let text = body;
  let url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  if (url.length > MAX_URL) {
    navigator.clipboard?.writeText(body).catch(() => {});
    text = '(내용이 길어 복사해 두었습니다. 이곳에 붙여넣기(Ctrl+V) 해 주세요.)';
    url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    notify('내용이 길어 클립보드에 복사했습니다. 메일 본문에 붙여넣기(Ctrl+V) 해 주세요.');
  }
  const a = document.createElement('a');
  a.href = url;
  a.click();
}

/**
 * 메일 보내기 기능. send(업체명, 제목, 내용) 를 부르면 그 업체의 이메일로 메일 앱을 연다.
 * 업체에 이메일이 없으면 입력창(prompt)이 뜨고, 입력한 주소는 업체 정보에 저장된다.
 * 사용하는 화면은 반환된 prompt 를 화면 어딘가에 그려 두어야 한다.
 */
export function useCompanyMail(): { send: (company: string, mail: { subject: string; body: string }, warn?: string) => void; prompt: ReactNode } {
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/companies'), staleTime: 30_000 });
  const [asking, setAsking] = useState<{ company: string; subject: string; body: string } | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const send = (company: string, mail: { subject: string; body: string }, warn?: string) => {
    if (warn && !window.confirm(`${warn}\n\n그래도 메일을 작성할까요?`)) return;
    const c = companies.data?.find((x) => x.name === company);
    if (c?.email) {
      openMailApp(c.email, mail.subject, mail.body, toast);
    } else {
      setEmail('');
      setAsking({ company, ...mail });
    }
  };

  const saveAndSend = async () => {
    if (!asking) return;
    const c = companies.data?.find((x) => x.name === asking.company);
    setBusy(true);
    try {
      const body = { name: asking.company, phone: c?.phone ?? '', email: email.trim() };
      if (c) await api(`/companies/${c.id}`, { method: 'PUT', body });
      else await api('/companies', { body });
      qc.invalidateQueries({ queryKey: ['companies'] });
      openMailApp(email.trim(), asking.subject, asking.body, toast);
      setAsking(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const prompt = asking ? (
    <Modal title="이메일 주소 입력" onClose={() => setAsking(null)}>
      <div className="space-y-3">
        <p className="text-base"><b>{asking.company}</b> 의 이메일 주소가 아직 없습니다. 입력하면 업체 정보에 저장되어 다음부터는 바로 열립니다.</p>
        <Field label="이메일">
          <input type="email" inputMode="email" autoFocus value={email} placeholder="예) hana@example.com" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button className="w-full" disabled={busy || !email.includes('@')} onClick={saveAndSend}>저장하고 메일 열기</Button>
      </div>
    </Modal>
  ) : null;

  return { send, prompt };
}
