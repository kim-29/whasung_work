import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { API_BASE, api, fmtDate, fmtKg, fmtWon, saveBlob } from './api';
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

/** 메일에 함께 보낼 수 있는 도면 (작업 번호와 저장할 파일 이름) */
export interface DrawingRef {
  id: number;
  filename: string;
}

/**
 * 도면이 있는 작업만 골라 첨부 후보로 만든다. 같은 지시서에서 색상별로 나뉜 작업은 도면 한 파일을 같이 쓰므로 한 번만 담는다.
 * 서버에서 지워졌거나(has_drawing 0) 없는 도면은 빠진다.
 */
export function drawingRefs(
  rows: { id: number; color: string | null; group_id?: number | null; has_drawing?: number; company?: string }[],
  company: string,
): DrawingRef[] {
  const seen = new Set<number>();
  const out: DrawingRef[] = [];
  for (const r of rows) {
    if (!r.has_drawing) continue;
    const key = r.group_id ?? -r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const safe = `${r.company ?? company}`.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
    out.push({ id: r.id, filename: `도면_${safe}_작업${r.id}.html` });
  }
  return out;
}

/** 도면을 내 컴퓨터로 내려받는다 (메일 작성 창에 끌어다 놓거나 첨부 버튼으로 붙일 수 있게). 새 창 없이 서명 링크로 받는다. */
async function downloadDrawing(d: DrawingRef) {
  const { path } = await api<{ path: string }>(`/orders/${d.id}/drawing-link`);
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error('도면을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  saveBlob(await res.blob(), d.filename);
}

const MAX_URL = 1900; // 서비스마다 주소 길이 제한이 달라 안전한 길이로 제한한다

const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /Macintosh/i.test(UA));
const IS_MOBILE = IS_IOS || /Android/i.test(UA);

/** 서비스별 메일 작성 페이지 주소 (받는 사람·제목·본문을 채워서). self 는 내 메일 주소 */
function composeUrl(service: MailService, to: string, subject: string, body: string, self: string): string {
  const q = (o: Record<string, string>) =>
    Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  // 폰: 웹 메일 작성 페이지는 앱 설치 안내로 넘어가거나 열리지 않는 일이 많아서, 폰의 메일 앱을 바로 연다.
  if (IS_MOBILE) {
    if (service === 'gmail') return IS_IOS ? `googlegmail:///co?${q({ to, subject, body })}` : mailto; // 안드로이드는 mailto 를 Gmail 앱이 받는다
    if (service === 'outlook') return `ms-outlook://compose?${q({ to, subject, body })}`;
    return mailto; // 네이버·다음·기본 앱: 폰의 기본 메일 앱 (앱이 받는 사람·제목·내용 채우기를 지원하지 않으면 복사해 둔 내용을 붙여넣기)
  }
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
  const tooLong = (service !== 'daum' || IS_MOBILE) && url.length > MAX_URL;
  if (tooLong) {
    body = IS_MOBILE ? '(내용이 길어 복사해 두었습니다. 이곳을 길게 눌러 붙여넣기 해 주세요.)' : '(내용이 길어 복사해 두었습니다. 이곳에 붙여넣기(Ctrl+V) 해 주세요.)';
    url = composeUrl(service, to, mail.subject, body, self);
  }
  if (tooLong || service === 'naver' || service === 'daum') {
    navigator.clipboard?.writeText(`받는 사람: ${to}\r\n제목: ${mail.subject}\r\n\r\n${mail.body}`).catch(() => {});
    const paste = IS_MOBILE ? '길게 눌러 붙여넣기' : '붙여넣기(Ctrl+V)';
    notify(
      service === 'daum' ? `받는 사람·제목·내용을 복사했습니다. 작성 창에서 ${paste} 하세요.`
      : service === 'naver' ? `내용을 복사해 두었습니다. 작성 창이 비어 있으면 ${paste} 하세요.`
      : `내용이 길어 클립보드에 복사했습니다. 메일 본문에 ${paste} 해 주세요.`,
    );
  }
  if (service === 'app' || IS_MOBILE) {
    // 폰에서는 새 창 대신 현재 화면에서 앱을 연다 (앱이 열리고 이 화면은 그대로 남는다)
    const a = document.createElement('a');
    a.href = url;
    a.click();
    return { state: 'opened', url };
  }
  const win = window.open(url, '_blank', 'noopener');
  return { state: win ? 'opened' : 'blocked', url };
}

type SendFn = (company: string, mail: { subject: string; body: string }, warn?: string, drawings?: DrawingRef[]) => void;

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
  const [attachAsk, setAttachAsk] = useState<{ company: string; mail: { subject: string; body: string }; drawings: DrawingRef[] } | null>(null);
  const [attached, setAttached] = useState<DrawingRef[] | null>(null);

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

  const compose = (company: string, mail: { subject: string; body: string }) => {
    const c = companies.data?.find((x) => x.name === company);
    if (c?.email) go(c.email, mail);
    else {
      setEmail('');
      setAsking({ company, mail });
    }
  };

  const send: SendFn = (company, mail, warn, drawings) => {
    if (warn && !window.confirm(`${warn}\n\n그래도 메일을 작성할까요?`)) return;
    // 도면이 있는 작업이면 도면도 함께 보낼지 먼저 묻는다
    if (drawings?.length) setAttachAsk({ company, mail, drawings });
    else compose(company, mail);
  };

  // 메일 작성 주소에는 파일을 실을 수 없다. 그래서 도면을 먼저 내려받고, 열린 작성 창에 직접 첨부하도록 안내한다.
  const sendWithDrawings = async () => {
    if (!attachAsk) return;
    const { company, mail, drawings } = attachAsk;
    setBusy(true);
    try {
      for (const d of drawings) await downloadDrawing(d);
      setAttachAsk(null);
      setAttached(drawings);
      compose(company, mail);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
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
      {attachAsk && (
        <Modal title="도면도 함께 보낼까요?" onClose={() => setAttachAsk(null)}>
          <div className="space-y-3">
            <p className="text-base">이 거래에는 3D 도면이 있습니다. 도면 파일 {attachAsk.drawings.length}개를 함께 보낼 수 있습니다.</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-600">
              {attachAsk.drawings.map((d) => <li key={d.id}>{d.filename}</li>)}
            </ul>
            <p className="text-sm text-slate-500">
              메일 작성 페이지에는 파일을 자동으로 넣을 수 없어서, 도면을 먼저 <b>내 컴퓨터(다운로드 폴더)에 저장</b>하고 메일 작성 창을 엽니다. 작성 창에서 <b>클립(첨부) 버튼</b>으로 저장된 파일을 선택하거나, 파일을 창에 끌어다 놓으면 됩니다.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button disabled={busy} onClick={sendWithDrawings}>{busy ? '도면 저장 중...' : '도면 포함해서 작성'}</Button>
              <Button tone="plain" disabled={busy} onClick={() => { const a = attachAsk; setAttachAsk(null); compose(a.company, a.mail); }}>도면 없이 작성</Button>
            </div>
          </div>
        </Modal>
      )}
      {attached && (
        <Modal title="도면 파일을 첨부해 주세요" onClose={() => setAttached(null)}>
          <div className="space-y-3">
            <p className="text-base">도면 파일을 내 컴퓨터에 저장했습니다. 열린 메일 작성 창에서 <b>클립(첨부) 버튼</b>을 눌러 아래 파일을 선택하거나, 파일을 작성 창에 끌어다 놓아 주세요. (다운로드 폴더)</p>
            <ul className="list-disc space-y-0.5 pl-5 text-base font-semibold">
              {attached.map((d) => <li key={d.id}>{d.filename}</li>)}
            </ul>
            <Button className="w-full" onClick={() => setAttached(null)}>확인</Button>
          </div>
        </Modal>
      )}
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