import { useQuery, useQueryClient } from '@tanstack/react-query';
import { strToU8, zipSync } from 'fflate';
import { useState } from 'react';
import { api, apiBlob, fmtDate, kstMonth, kstToday, saveBlob } from '../api';
import { Badge, Button, Card, Field, useToast } from '../ui';

interface Candidate {
  key: string;
  ids: number[];
  companies: string;
  colors: string;
  kinds: string;
  ordered: string;
  last_paid: string;
  orders: number;
}

const BATCH = 30; // 한 번에 보관하는 도면 수 (브라우저 메모리를 아끼려고 나눠서 한다)
const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 데이터 보관 (관리자 전용)
 *  1) 전체 백업 내려받기  2) 거래 장부(엑셀용 CSV)  3) 오래된 도면을 내 컴퓨터로 내려받은 뒤 서버에서 정리
 */
export function ArchiveCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [from, setFrom] = useState(`${kstToday().slice(0, 4)}-01`);
  const [to, setTo] = useState(kstMonth());
  const [months, setMonths] = useState('12');
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [pending, setPending] = useState<{ items: { key: string; sha256: string }[]; zipName: string; months: number } | null>(null);
  const [progress, setProgress] = useState('');
  const summary = useQuery({ queryKey: ['archive-summary'], queryFn: () => api<{ drawings: number; archived_orders: number }>('/admin/archive/summary') });

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const downloadBackup = () =>
    run('backup', async () => {
      saveBlob(await apiBlob('/admin/backup/export'), `whasung-백업-${kstToday()}.json`);
      toast('전체 백업 파일을 내려받았습니다. 안전한 곳에 보관해 주세요.');
    });

  const downloadLedger = () =>
    run('ledger', async () => {
      if (from > to) throw new Error('시작 달이 끝나는 달보다 늦습니다.');
      saveBlob(await apiBlob(`/admin/backup/ledger?from=${from}&to=${to}`), `거래장부_${from}_${to}.csv`);
      toast('거래 장부를 내려받았습니다. 엑셀로 열 수 있습니다.');
    });

  const m = () => Math.min(120, Math.max(1, Math.floor(Number(months) || 12)));

  const check = () =>
    run('check', async () => {
      setPending(null);
      setCands(await api<Candidate[]>(`/admin/archive/candidates?months=${m()}`));
    });

  // 1단계: 도면을 하나씩 받아서 zip 으로 묶어 내려받는다. 아직 서버에서는 아무것도 지우지 않는다.
  const download = () =>
    run('download', async () => {
      const batch = (cands ?? []).slice(0, BATCH);
      const files: Record<string, Uint8Array> = {};
      const items: { key: string; sha256: string }[] = [];
      const manifest = ['작업번호,업체,구분,색상,지시일,마지막 납입일,파일,sha256'];
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        setProgress(`도면 받는 중... ${i + 1} / ${batch.length}`);
        const buf = await (await apiBlob(`/admin/archive/file?key=${encodeURIComponent(c.key)}`)).arrayBuffer();
        const sha = hex(await crypto.subtle.digest('SHA-256', buf));
        const path = `${c.ordered.slice(0, 7)}/작업${c.ids.join('-')}_${safe(c.companies)}_${safe(c.colors)}.html`;
        files[path] = new Uint8Array(buf);
        items.push({ key: c.key, sha256: sha });
        const kind = c.kinds.includes('make') ? '제작' : '절단';
        manifest.push([c.ids.join(' '), `"${c.companies.replace(/"/g, '""')}"`, kind, c.colors, c.ordered, c.last_paid, `"${path}"`, sha].join(','));
      }
      files['목록.csv'] = strToU8('﻿' + manifest.join('\r\n') + '\r\n');
      setProgress('압축 파일 만드는 중...');
      const zip = zipSync(files, { level: 1 });
      const zipName = `도면보관_${kstToday()}_${batch.length}개.zip`;
      saveBlob(new Blob([zip], { type: 'application/zip' }), zipName);
      setPending({ items, zipName, months: m() });
      setProgress('');
      toast(`${zipName} 을(를) 내려받았습니다. 파일을 확인한 뒤 서버에서 지워 주세요.`);
    });

  // 2단계: 사람이 내려받은 파일을 확인한 뒤에만 서버에서 지운다. 서버도 파일이 같은지 한 번 더 확인한다.
  const commit = () =>
    run('commit', async () => {
      if (!pending) return;
      if (!window.confirm(`도면 ${pending.items.length}개를 서버에서 지웁니다.\n\n내려받은 '${pending.zipName}' 파일이 컴퓨터에 저장되어 있고 열리는 것을 확인하셨나요?\n지운 뒤에는 서버에 사본이 남지 않습니다.`)) return;
      const r = await api<{ archived: number; results: { key: string; ok: boolean; error?: string }[] }>('/admin/archive/commit', {
        body: { months: pending.months, items: pending.items },
      });
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? `${r.archived}개 정리, ${failed.length}개는 지우지 않았습니다: ${failed[0].error}` : `도면 ${r.archived}개를 서버에서 정리했습니다.`, failed.length ? 'error' : 'ok');
      setPending(null);
      setCands(await api<Candidate[]>(`/admin/archive/candidates?months=${pending.months}`));
      qc.invalidateQueries();
    });

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-bold">데이터 보관 (관리자 전용)</h2>

      <section className="space-y-2">
        <h3 className="text-sm font-bold text-slate-700">1. 전체 백업 내려받기</h3>
        <p className="text-sm text-slate-500">
          작업, 바, 단가, 업체, 직원, 수정 이력이 모두 들어 있는 복구용 파일입니다(3D 도면은 아래 3번에서 따로). 업체 이메일 같은 개인정보가 있으니 안전한 곳에 보관하세요. 한 달에 한 번 정도 받아 두는 것을 권합니다.
        </p>
        <Button disabled={!!busy} onClick={downloadBackup}>{busy === 'backup' ? '받는 중...' : '전체 백업 받기'}</Button>
      </section>

      <section className="space-y-2 border-t border-slate-300 pt-3">
        <h3 className="text-sm font-bold text-slate-700">2. 거래 장부 (엑셀용)</h3>
        <p className="text-sm text-slate-500">지시일 기준으로 기간을 골라 거래 장부(CSV)를 내려받습니다. 엑셀에서 바로 열립니다.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="시작 달"><input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="끝나는 달"><input type="month" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
        </div>
        <Button disabled={!!busy} onClick={downloadLedger}>{busy === 'ledger' ? '받는 중...' : '거래 장부 받기'}</Button>
      </section>

      <section className="space-y-2 border-t border-slate-300 pt-3">
        <h3 className="text-sm font-bold text-slate-700">3. 오래된 도면 보관 · 서버 정리</h3>
        <p className="text-sm text-slate-500">
          서버에 저장된 3D 도면은 {summary.data ? <b>{summary.data.drawings}개</b> : '...'}이고, 무료 저장 공간(약 1GB)은 도면 수백 개면 찹니다.
          공간이 모자라기 전에, 납입이 끝난 오래된 도면을 내 컴퓨터로 내려받아 보관하고 서버에서는 지웁니다.
          작업 기록(업체, 무게, 금액)은 그대로 남고, 해당 작업에는 <b>"도면 보관됨"</b>으로 표시됩니다.
        </p>
        <ol className="list-decimal space-y-0.5 pl-5 text-sm text-slate-600">
          <li>기준 기간을 정하고 "대상 확인"을 누릅니다.</li>
          <li>"도면 내려받기"로 압축 파일(zip)을 받습니다. 이때는 서버에서 아무것도 지우지 않습니다.</li>
          <li>받은 파일이 열리는지 확인한 뒤 "서버에서 지우기"를 누릅니다.</li>
        </ol>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28"><Field label="완납 후 (개월)"><input inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} /></Field></div>
          <span className="pb-3 text-sm text-slate-600">개월이 지난 도면</span>
          <Button tone="plain" disabled={!!busy} onClick={check}>{busy === 'check' ? '확인 중...' : '대상 확인'}</Button>
        </div>

        {cands && (
          <div className="space-y-2 rounded-xl border border-slate-300 bg-slate-50 p-3">
            {cands.length === 0 ? (
              <p className="text-base">보관할 도면이 없습니다. (납입이 끝난 지 {m()}개월이 지난 도면이 없습니다)</p>
            ) : (
              <>
                <p className="text-base font-semibold">보관 대상 도면 {cands.length}개{cands.length > BATCH && ` (한 번에 ${BATCH}개씩 처리)`}</p>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-slate-700">
                  {cands.slice(0, BATCH).map((c) => (
                    <li key={c.key}>작업 {c.ids.join(', ')} · {c.companies} · {c.colors} · 지시 {fmtDate(c.ordered + ' 00:00:00')}</li>
                  ))}
                </ul>
                {!pending ? (
                  <>
                    <Button className="w-full" disabled={!!busy} onClick={download}>{busy === 'download' ? progress || '받는 중...' : `도면 ${Math.min(cands.length, BATCH)}개 내려받기`}</Button>
                    {busy === 'download' && progress && <p className="text-sm text-slate-600">{progress}</p>}
                  </>
                ) : (
                  <div className="space-y-2 rounded-xl border border-red-800 bg-red-100 p-3">
                    <p className="text-sm font-semibold text-red-800">
                      <Badge color="red">확인 필요</Badge> '{pending.zipName}' 을(를) 내려받았습니다. 컴퓨터에 저장되었고 압축이 풀리는지 확인한 뒤 아래 버튼을 눌러 주세요. 누르기 전에는 서버의 도면이 그대로 있습니다.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button tone="plain" disabled={!!busy} onClick={() => setPending(null)}>지우지 않고 취소</Button>
                      <Button tone="danger" disabled={!!busy} onClick={commit}>{busy === 'commit' ? '정리 중...' : '서버에서 지우기'}</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {summary.data && summary.data.archived_orders > 0 && (
          <p className="text-sm text-slate-500">지금까지 도면 보관 처리된 작업 {summary.data.archived_orders}건. 보관한 도면은 작업의 "도면 보기"에서 다시 올리면 복원됩니다(복원 화면은 추후 추가).</p>
        )}
      </section>
    </Card>
  );
}
