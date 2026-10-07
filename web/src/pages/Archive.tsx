import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiBlob, fmtDate, kstMonth, kstToday, saveBlob } from '../api';
import { Button, Card, Field, useToast } from '../ui';

/**
 * 데이터 보관 (관리자 전용)
 *  1) 전체 백업 내려받기  2) 거래 장부(엑셀용 CSV)  3) 완납 후 기간이 지난 도면 삭제 (매일 00:00 자동 + 지금 삭제)
 */
export function ArchiveCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [from, setFrom] = useState(`${kstToday().slice(0, 4)}-01`);
  const [to, setTo] = useState(kstMonth());
  const [months, setMonths] = useState('');
  const summary = useQuery({
    queryKey: ['archive-summary'],
    queryFn: () => api<{ drawings: number; archived_orders: number; months: number; last_run: { at: string; months: number; deleted: number; auto?: boolean } | null }>('/admin/archive/summary'),
  });
  const saved = summary.data?.months ?? 12;
  const shown = months === '' ? String(saved) : months;

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

  const m = () => Math.min(120, Math.max(1, Math.floor(Number(shown) || 12)));

  const saveMonths = () =>
    run('save', async () => {
      await api('/admin/archive/settings', { method: 'PUT', body: { months: m() } });
      setMonths('');
      await qc.invalidateQueries({ queryKey: ['archive-summary'] });
      toast(`완납 후 ${m()}개월이 지난 도면을 지우도록 저장했습니다. 매일 한국 시간 00:00에 자동으로 지워집니다.`);
    });

  // 지금 삭제: 한 번에 일부만 지우므로 남은 것이 없을 때까지 이어서 부른다 (확인 단계 없이 바로 지운다)
  const purgeNow = () =>
    run('purge', async () => {
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const r = await api<{ deleted: number; remaining: number }>('/admin/archive/purge', { body: { months: m() } });
        total += r.deleted;
        if (r.remaining === 0 || r.deleted === 0) break;
      }
      toast(total ? `완납 후 ${m()}개월이 지난 도면 ${total}개를 지웠습니다.` : `지울 도면이 없습니다. (납입이 끝난 지 ${m()}개월이 지난 도면이 없습니다)`);
      qc.invalidateQueries();
    });

  return (
    <Card className="space-y-4">
      <h2 className="text-base font-bold">데이터 보관 (관리자 전용)</h2>

      <section className="space-y-2">
        <h3 className="text-sm font-bold text-slate-700">1. 전체 백업 내려받기</h3>
        <p className="text-sm text-slate-500">
          작업, 바, 단가, 업체, 직원, 수정 이력이 모두 들어 있는 복구용 파일입니다(3D 도면은 포함되지 않습니다). 업체 이메일 같은 개인정보가 있으니 안전한 곳에 보관하세요. 한 달에 한 번 정도 받아 두는 것을 권합니다.
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
        <h3 className="text-sm font-bold text-slate-700">3. 오래된 도면 삭제 (매일 00:00 자동)</h3>
        <p className="text-sm text-slate-500">
          서버에 저장된 3D 도면은 {summary.data ? <b>{summary.data.drawings}개</b> : '...'}이고, 무료 저장 공간(약 1GB)은 도면 수백 개면 찹니다.
          납입이 끝난 지 정한 기간이 지난 도면은 <b>백업 없이 서버에서 삭제</b>됩니다. 작업 기록(업체, 무게, 금액)은 그대로 남고, 해당 작업에는 <b>"도면 삭제됨"</b>으로 표시됩니다.
          같은 지시서에서 나뉜 작업은 모두 완납되어야 지워집니다. 미납이 하나라도 있으면 지우지 않습니다.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28"><Field label="완납 후 (개월)"><input inputMode="numeric" value={shown} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} /></Field></div>
          <span className="pb-3 text-sm text-slate-600">개월이 지난 도면 삭제</span>
          <Button tone="plain" disabled={!!busy || m() === saved} onClick={saveMonths}>{busy === 'save' ? '저장 중...' : '기간 저장'}</Button>
        </div>
        <p className="text-sm text-slate-600">
          자동 삭제는 <b>매일 한국 시간 00:00</b>에 저장된 기간(현재 <b>{saved}개월</b>)으로 실행됩니다.
          {summary.data?.last_run && <> 마지막 실행: {fmtDate(summary.data.last_run.at.replace('T', ' ').slice(0, 19), true)} ({summary.data.last_run.auto ? '자동' : '직접'}, {summary.data.last_run.deleted}개 삭제)</>}
        </p>
        <Button tone="danger" disabled={!!busy} onClick={purgeNow}>{busy === 'purge' ? '지우는 중...' : '지금 바로 삭제하기'}</Button>
        <p className="text-sm text-slate-500">누르지 않아도 매일 00:00에 자동으로 지워집니다. 한 번에 최대 40개씩 지우며 남은 것은 다음 날 이어서 지웁니다.</p>
        {summary.data && summary.data.archived_orders > 0 && (
          <p className="text-sm text-slate-500">지금까지 도면이 삭제된 작업 {summary.data.archived_orders}건. 도면 파일(.html)이 남아 있다면 작업의 "도면 보기"에서 다시 올려 복원할 수 있습니다.</p>
        )}
      </section>
    </Card>
  );
}
