import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, fmtDate, fmtKg, fmtWon } from './api';
import { useAuth } from './auth';
import { KIND_LABEL, MAIL_SERVICES, type Company, type Kind, type MailService, type Status } from './types';
import { Button, Field, Modal, useToast } from './ui';

// 거래 내용을 메일로 보내는 기능 (메일 작성 페이지 열기 방식).
// 버튼을 누르면 '내 메일'로 저장해 둔 서비스(Gmail, Outlook, 네이버, 다음, 기본 메일 앱)의 작성 페이지가 열리고,
// 받는 사람·제목·내용이 채워진다. 직접 '보내기'를 누른다. 서버가 대신 보내지 않으므로 비용·설정이 없고 보낸 메일은 내 메일함에 남는다.

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

const MAX_URL = 1900; // 서비스마다 주소 길이 제한이 달라 안전한 길이로 제한한다

/** 서비스별 메일 작성 페이지 주소 (받는 사람·제목·본문을 채워서). self 는 내 메일 주소 */
function composeUrl(service: MailService, to: string, subject: string, body: string, self: string): string {
  const q = (o: Record<string, string>) =>
    Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  switch (service) {
    case 'gmail': // authuser 에 내 주소를 주면 여러 구글 계정이 로그인되어 있어도 이 계정으로 열린다
      return `https://mail.google.com/mail/?${q({ view: 'cm', fs: '1', authuser: self, to, su: subject, body })}`;
    case 'outlook':
      return `https://outlook.live.com/mail/0/deeplink/compose?${q({ to, subject, body })}`;
    case 'naver': // 받는 사람·제목·내용을 주소에 실어 보내 보되, 안 채워지는 경우를 대비해 클립보드에도 복사한다
      return `https://mail.naver.com/write/popup?${q({ to, subject, body })}`;
    case 'daum':
      return 'https://mail.daum.net/';
    default:
      return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}

/** 메일 작성 페이지를 연다. 팝업이 막혀 열지 못하면 'blocked' 와 주소를 돌려준다. */
function openCompose(
  service: MailService, to: string, mail: { subject: string; body: string }, self: string, notify: (m: string) => void,
): { state: 'opened' | 'blocked'; url: string } {
  let body = mail.body;
  let url = composeUrl(service, to, mail.subject, body, self);
  const tooLong = service !== 'daum' && url.length > MAX_URL;
  if (tooLong) {
    body = '(내용이 길어 복사해 두었습니다. 이곳에 붙여넣기(Ctrl+V) 해 주세요.)';
    url = composeUrl(service, to, mail.subject, body, self);
  }
  if (tooLong || service === 'naver' || service === 'daum') {
    navigator.clipboard?.writeText(`받는 사람: ${to}\r\n제목: ${mail.subject}\r\n\r\n${mail.body}`).catch(() => {});
    notify(
      service === 'daum' ? '받는 사람·제목·내용을 복사했습니다. 작성 창에서 붙여넣기(Ctrl+V) 하세요.'
      : service === 'naver' ? '내용을 복사해 두었습니다. 작성 창이 비어 있으면 붙여넣기(Ctrl+V) 하세요.'
      : '내용이 길어 클립보드에 복사했습니다. 메일 본문에 붙여넣기(Ctrl+V) 해 주세요.',
    );
  }
  if (service === 'app') {
    const a = document.createElement('a');
    a.href = url;
    a.click();
    return { state: 'opened', url };
  }
  const win = window.open(url, '_blank', 'noopener');
  return { state: win ? 'opened' : 'blocked', url };
}

type SendFn = (company: string, mail: { subject: string; body: string }, warn?: string) => void;

/**
 * 메일 보내기 기능. send(업체명, {제목, 내용}) 를 부르면:
 *  1) 업체 이메일이 없으면 입력창 → 업체 정보에 저장
 *  2) 내 메일 서비스를 아직 안 골랐으면 고르는 창 → '내 메일'로 저장
 *  3) 고른 서비스의 메일 작성 페이지를 연다 (받는 사람·제목·내용이 채워져 있다)
 * 사용하는 화면은 반환된 prompt 를 화면 어딘가에 그려 두어야 한다.
 */
export function useCompanyMail(): { send: SendFn; prompt: ReactNode } {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, saveMail } = useAuth();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/companies'), staleTime: 30_000 });
  const [asking, setAsking] = useState<{ company: string; mail: { subject: string; body: string } } | null>(null);
  const [email, setEmail] = useState('');
  const [choosing, setChoosing] = useState<{ to: string; mail: { subject: string; body: string } } | null>(null);
  const [selfAddr, setSelfAddr] = useState('');
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (service: MailService, to: string, mail: { subject: string; body: string }, self: string) => {
    const r = openCompose(service, to, mail, self, toast);
    if (r.state === 'blocked') setBlockedUrl(r.url); // 브라우저가 새 창을 막았을 때: 눌러서 열 수 있는 창을 보여 준다
  };

  const go = (to: string, mail: { subject: string; body: string }) => {
    if (!user?.mail_service) {
      setSelfAddr(user?.mail_address ?? '');
      setChoosing({ to, mail });
      return;
    }
    run(user.mail_service, to, mail, user.mail_address ?? '');
  };

  const send: SendFn = (company, mail, warn) => {
    if (warn && !window.confirm(`${warn}\n\n그래도 메일을 작성할까요?`)) return;
    const c = companies.data?.find((x) => x.name === company);
    if (c?.email) go(c.email, mail);
    else {
      setEmail('');
      setAsking({ company, mail });
    }
  };

  const saveCompanyEmail = async () => {
    if (!asking) return;
    const c = companies.data?.find((x) => x.name === asking.company);
    setBusy(true);
    try {
      const body = { name: asking.company, phone: c?.phone ?? '', email: email.trim() };
      if (c) await api(`/companies/${c.id}`, { method: 'PUT', body });
      else await api('/companies', { body });
      qc.invalidateQueries({ queryKey: ['companies'] });
      const { mail } = asking;
      setAsking(null);
      go(email.trim(), mail);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const choose = async (service: MailService) => {
    if (!choosing) return;
    setBusy(true);
    try {
      await saveMail(service, selfAddr.trim()); // 다음부터는 묻지 않는다
      const { to, mail } = choosing;
      setChoosing(null);
      run(service, to, mail, selfAddr.trim());
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const prompt = (
    <>
      {asking && (
        <Modal title="이메일 주소 입력" onClose={() => setAsking(null)}>
          <div className="space-y-3">
            <p className="text-base"><b>{asking.company}</b> 의 이메일 주소가 아직 없습니다. 입력하면 업체 정보에 저장되어 다음부터는 바로 열립니다.</p>
            <Field label="이메일">
              <input type="email" inputMode="email" autoFocus value={email} placeholder="예) hana@example.com" onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Button className="w-full" disabled={busy || !email.includes('@')} onClick={saveCompanyEmail}>저장하고 메일 열기</Button>
          </div>
        </Modal>
      )}
      {choosing && (
        <Modal title="어느 메일로 보낼까요?" onClose={() => setChoosing(null)}>
          <div className="space-y-3">
            <p className="text-base">내가 쓰는 메일을 한 번만 골라 주세요. 다음부터는 이 메일의 작성 페이지가 바로 열립니다. (설정 &gt; 내 메일에서 바꿀 수 있습니다)</p>
            <div className="space-y-2">
              {MAIL_SERVICES.map((s) => (
                <button key={s.key} disabled={busy} onClick={() => choose(s.key)}
                  className="block w-full rounded-xl border border-slate-400 bg-white px-4 py-3 text-left active:bg-slate-200 disabled:opacity-50">
                  <span className="block text-base font-bold">{s.label}</span>
                  <span className="block text-sm text-slate-500">{s.hint}</span>
                </button>
              ))}
            </div>
            <Field label="내 메일 주소 (선택 · Gmail 계정 구분에 쓰입니다)">
              <input type="email" inputMode="email" value={selfAddr} placeholder="예) me@gmail.com" onChange={(e) => setSelfAddr(e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
      {blockedUrl && (
        <Modal title="메일 작성 페이지 열기" onClose={() => setBlockedUrl(null)}>
          <div className="space-y-3">
            <p className="text-base">브라우저가 새 창을 막았습니다. 아래 버튼을 눌러 메일 작성 페이지를 열어 주세요.</p>
            <a href={blockedUrl} target="_blank" rel="noopener noreferrer" onClick={() => setBlockedUrl(null)}
              className="block min-h-11 rounded-xl bg-blue-600 px-4 py-3 text-center text-base font-semibold text-white">
              메일 작성 페이지 열기
            </a>
          </div>
        </Modal>
      )}
    </>
  );

  return { send, prompt };
}