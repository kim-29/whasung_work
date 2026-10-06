import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { useAuth } from '../auth';
import { PushCard } from '../push';
import { ArchiveCard } from './Archive';
import { COLORS, type Bar, type ColorPrice, type Company } from '../types';
import { Badge, Button, Card, Field, Modal, useToast } from '../ui';

export default function Settings() {
  const { user, logout } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">설정</h1>
      <Card className="divide-y divide-slate-200 !p-0">
        <MenuLink to="/settings/companies" title="업체 관리" sub="거래 업체의 이름·전화·이메일" />
        <MenuLink to="/settings/bars" title="바(자재) 목록" sub="바 이름과 1미터당 무게(kg/m)" />
      </Card>
      <PushCard />
      <Prices />
      {user!.role === 'admin' && <AdminPanel />}
      <Card className="flex items-center justify-between">
        <span className="text-base">{user!.name}님으로 로그인됨</span>
        <Button tone="plain" onClick={() => window.confirm('이 기기에서 로그아웃할까요?') && logout()}>로그아웃</Button>
      </Card>
    </div>
  );
}

/** 설정 안의 하위 메뉴 한 줄 (누르면 별도 페이지로 이동) */
function MenuLink({ to, title, sub }: { to: string; title: string; sub: string }) {
  return (
    <Link to={to} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
      <span>
        <span className="block text-base font-bold">{title}</span>
        <span className="block text-sm text-slate-500">{sub}</span>
      </span>
      <span aria-hidden className="text-2xl leading-none text-slate-400">›</span>
    </Link>
  );
}

/** 설정 하위 페이지의 머리 (설정으로 돌아가기) */
function SubPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="rounded px-2 py-1 text-base font-semibold text-slate-600 hover:bg-slate-200">‹ 설정</Link>
        <h1 className="text-xl font-bold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function CompaniesPage() {
  return <SubPage title="업체 관리"><Companies /></SubPage>;
}

export function BarsPage() {
  return <SubPage title="바(자재) 목록"><Bars /></SubPage>;
}

/** 색상별 kg당 단가. 바꾸면 그 시점 이후에 지시되는 작업부터 새 단가가 적용된다. */
function Prices() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['prices'], queryFn: () => api<ColorPrice[]>('/prices') });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.map((p) => [p.color, p.price_per_kg == null ? '' : String(p.price_per_kg)])));
  }, [q.data]);

  const save = async (c: ColorPrice) => {
    const v = Number(draft[c.color]);
    if (!(v >= 0) || draft[c.color] === '') return toast('단가를 숫자로 입력해 주세요.', 'error');
    if (c.price_per_kg != null && !window.confirm(`${c.color} 단가를 ${c.price_per_kg.toLocaleString('ko-KR')}원 → ${v.toLocaleString('ko-KR')}원으로 바꿀까요?\n지금 이후에 지시되는 작업부터 새 단가가 적용됩니다.`)) return;
    try {
      await api('/prices', { method: 'PUT', body: { color: c.color, price_per_kg: v } });
      qc.invalidateQueries();
      toast(`${c.color} 단가를 저장했습니다.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Card className="space-y-2.5">
      <h2 className="text-base font-bold">색상별 단가 (kg당)</h2>
      <p className="text-sm text-slate-500">단가를 바꾸면 바꾼 시점 이후에 지시된 작업부터 새 단가가 적용됩니다. 이미 지시된 작업은 그때의 단가가 유지됩니다.</p>
      {COLORS.map((color) => {
        const p = q.data?.find((x) => x.color === color);
        const changed = p && draft[color] !== (p.price_per_kg == null ? '' : String(p.price_per_kg));
        return (
          <div key={color} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-base font-semibold">{color}</span>
            <div className="relative flex-1">
              <input inputMode="decimal" value={draft[color] ?? ''} placeholder="미설정"
                onChange={(e) => setDraft({ ...draft, [color]: e.target.value.replace(/[^\d.]/g, '') })} />
            </div>
            <span className="text-sm text-slate-500">원</span>
            <Button className="!px-3" disabled={!p || !changed} onClick={() => p && save(p)}>저장</Button>
            <span className="hidden w-24 text-right text-xs text-slate-500 sm:block">
              {p?.effective_from ? (p.effective_from.startsWith('1970') ? '최초 등록' : fmtDate(p.effective_from)) : ''}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

/** 업체 정보(이름, 전화번호, 이메일). 작업지시서에서 새 업체명을 쓰면 자동으로 여기에 등록된다. */
function Companies() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/companies') });
  const [edit, setEdit] = useState<{ id?: number; name: string; phone: string; email: string } | null>(null);
  const [filter, setFilter] = useState('');

  const save = async () => {
    if (!edit) return;
    const body = { name: edit.name, phone: edit.phone, email: edit.email };
    const exists = q.data?.some((c) => c.id !== edit.id && c.name === edit.name.replace(/\s+/g, ' ').trim());
    if (edit.id && exists && !window.confirm(`'${edit.name.trim()}' 은(는) 이미 있는 업체입니다.\n두 업체를 하나로 합칠까요? (작업이 모두 옮겨지며 되돌릴 수 없습니다)`)) return;
    try {
      const r = edit.id
        ? await api<{ merged: boolean }>(`/companies/${edit.id}`, { method: 'PUT', body })
        : await api<{ id: number }>('/companies', { body });
      qc.invalidateQueries();
      toast('merged' in r && r.merged ? '업체를 합쳤습니다.' : '저장했습니다.');
      setEdit(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (c: Company) => {
    if (!window.confirm(`${c.name} 을(를) 삭제할까요?`)) return;
    try {
      await api(`/companies/${c.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['companies'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const list = (q.data ?? []).filter((c) => !filter.trim() || c.name.includes(filter.trim()) || (c.email ?? '').includes(filter.trim()));

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">업체 관리</h2>
        <Button onClick={() => setEdit({ name: '', phone: '', email: '' })}>+ 업체 추가</Button>
      </div>
      <p className="mb-2 text-sm text-slate-500">
        이메일은 거래내역을 메일로 보낼 때 쓰이고, 전화번호는 비워도 됩니다. 같은 업체가 다른 이름으로 나뉘어 있으면 이름을 같게 고쳐 하나로 합칠 수 있습니다.
      </p>
      {(q.data?.length ?? 0) > 6 && <input className="mb-2" placeholder="업체명·이메일로 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="divide-y divide-slate-200">
        {list.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <span className="text-base font-semibold">{c.name}</span>
            <span className="text-sm text-slate-500">{c.order_count}건</span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
              {c.email ? c.email : <b className="text-red-600">이메일 없음</b>}{c.phone ? ` · ${c.phone}` : ''}
            </span>
            <Button tone="plain" className="!min-h-9 text-sm" onClick={() => setEdit({ id: c.id, name: c.name, phone: c.phone ?? '', email: c.email ?? '' })}>수정</Button>
            {c.order_count === 0 && <Button tone="plain" className="!min-h-9 text-sm" onClick={() => remove(c)}>삭제</Button>}
          </div>
        ))}
        {q.data?.length === 0 && <p className="py-6 text-center text-slate-500">등록된 업체가 없습니다.</p>}
      </div>
      {edit && (
        <Modal title={edit.id ? '업체 수정' : '업체 추가'} onClose={() => setEdit(null)}>
          <div className="space-y-3">
            <Field label="업체명"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="이메일"><input type="email" inputMode="email" value={edit.email} placeholder="예) hana@example.com" onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="전화번호 (선택)"><input inputMode="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            {edit.id && <p className="text-sm text-slate-500">업체명을 바꾸면 이 업체의 모든 작업의 업체명도 함께 바뀝니다. 이미 있는 업체명이면 두 업체가 합쳐집니다.</p>}
            <Button className="w-full" disabled={!edit.name.trim()} onClick={save}>저장</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
function Bars() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['bars'], queryFn: () => api<Bar[]>('/bars') });
  const [edit, setEdit] = useState<{ id?: number; name: string; kg_per_m: string; note: string } | null>(null);

  const save = async () => {
    if (!edit) return;
    const body = { name: edit.name.trim(), kg_per_m: Number(edit.kg_per_m), note: edit.note };
    try {
      if (edit.id) await api(`/bars/${edit.id}`, { method: 'PUT', body });
      else await api('/bars', { body });
      qc.invalidateQueries({ queryKey: ['bars'] });
      toast('저장했습니다.');
      setEdit(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (b: Bar) => {
    if (!window.confirm(`${b.name} 을(를) 목록에서 삭제할까요?\n(이미 접수된 작업에는 영향이 없습니다)`)) return;
    await api(`/bars/${b.id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['bars'] });
  };

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-bold">바(자재) 목록</h2>
        <Button onClick={() => setEdit({ name: '', kg_per_m: '', note: '' })}>+ 바 추가</Button>
      </div>
      <p className="mb-2 text-sm text-slate-500">무게는 1미터당 kg 입니다. 고쳐도 이미 접수된 작업의 무게는 바뀌지 않습니다.</p>
      <div className="divide-y divide-slate-200">
        {q.data?.map((b) => (
          <div key={b.id} className="flex items-center gap-2 py-2.5">
            <span className="flex-1 text-base font-semibold">{b.name}</span>
            <span className="text-base">{b.kg_per_m} kg/m</span>
            <Button tone="plain" className="!min-h-9 text-sm" onClick={() => setEdit({ id: b.id, name: b.name, kg_per_m: String(b.kg_per_m), note: b.note ?? '' })}>수정</Button>
            <Button tone="plain" className="!min-h-9 text-sm" onClick={() => remove(b)}>삭제</Button>
          </div>
        ))}
        {q.data?.length === 0 && <p className="py-6 text-center text-slate-500">등록된 바가 없습니다. 먼저 바를 추가해 주세요.</p>}
      </div>
      {edit && (
        <Modal title={edit.id ? '바 수정' : '바 추가'} onClose={() => setEdit(null)}>
          <div className="space-y-3">
            <Field label="바 이름"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="1미터당 무게(kg/m)"><input inputMode="decimal" value={edit.kg_per_m} onChange={(e) => setEdit({ ...edit, kg_per_m: e.target.value })} /></Field>
            <Field label="메모"><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
            <Button className="w-full" disabled={!edit.name.trim() || !(Number(edit.kg_per_m) > 0)} onClick={save}>저장</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

interface UserRow { id: number; name: string; role: string; active: number }
interface DeviceRow { id: number; user_name: string; role: string; label: string | null; last_used_at: string }

function AdminPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ title: string; pin: string } | null>(null);
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<UserRow[]>('/admin/users') });
  const devices = useQuery({ queryKey: ['admin-devices'], queryFn: () => api<DeviceRow[]>('/admin/devices') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] }).then(() => qc.invalidateQueries({ queryKey: ['admin-devices'] }));

  const guard = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const addStaff = () => guard(async () => {
    const r = await api<{ pin: string }>('/admin/users', { body: { name: name.trim() } });
    setIssued({ title: `${name.trim()} 님의 PIN`, pin: r.pin });
    setName('');
    refresh();
  });
  const reissue = (u: UserRow) => guard(async () => {
    if (!window.confirm(`${u.name} 님의 PIN을 새로 발급할까요?\n기존 PIN과 등록된 기기는 모두 사용할 수 없게 됩니다.`)) return;
    const r = await api<{ pin: string }>(`/admin/users/${u.id}/reissue-pin`, { body: {} });
    setIssued({ title: `${u.name} 님의 새 PIN`, pin: r.pin });
    refresh();
  });
  const toggle = (u: UserRow) => guard(async () => {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
    refresh();
  });
  const workshopPin = () => guard(async () => {
    if (!window.confirm('작업장 PIN을 새로 발급할까요?\n지금 쓰는 작업장 기기는 모두 PIN을 다시 입력해야 합니다.')) return;
    const r = await api<{ pin: string }>('/admin/workshop-pin', { body: {} });
    setIssued({ title: '작업장 PIN', pin: r.pin });
    refresh();
  });

  return (
    <>
      <Card className="space-y-2.5">
        <h2 className="text-base font-bold">직원 관리 (관리자 전용)</h2>
        <div className="flex gap-2">
          <input placeholder="새 직원 이름" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name.trim()} onClick={addStaff} className="shrink-0">PIN 발급</Button>
        </div>
        <div className="divide-y divide-slate-200">
          {users.data?.filter((u) => u.role !== 'workshop').map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="text-base font-semibold">{u.name}</span>
              <Badge color={u.role === 'admin' ? 'blue' : 'slate'}>{u.role === 'admin' ? '관리자' : '직원'}</Badge>
              {!u.active && <Badge color="red">사용 중지</Badge>}
              {u.role !== 'admin' && (
                <span className="ml-auto flex gap-2">
                  <Button tone="plain" className="!min-h-9 text-sm" onClick={() => reissue(u)}>PIN 재발급</Button>
                  <Button tone="plain" className="!min-h-9 text-sm" onClick={() => toggle(u)}>{u.active ? '사용 중지' : '다시 사용'}</Button>
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-2">
        <h2 className="text-base font-bold">작업장 PIN</h2>
        <p className="text-sm text-slate-500">작업장 태블릿/폰이 처음 한 번 입력하는 번호입니다.</p>
        <Button onClick={workshopPin}>{users.data?.some((u) => u.role === 'workshop') ? '작업장 PIN 다시 발급' : '작업장 PIN 발급'}</Button>
      </Card>

      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">등록된 기기</h2>
          <Button tone="plain" className="!min-h-9 text-sm" onClick={() => api('/admin/unlock', { body: {} }).then(() => toast('로그인 잠금을 풀었습니다.'))}>잠금 풀기</Button>
        </div>
        <div className="divide-y divide-slate-200">
          {devices.data?.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="font-semibold">{d.user_name}</span>
              <span className="text-sm text-slate-500">{d.label} · 마지막 사용 {fmtDate(d.last_used_at, true)}</span>
              <Button tone="plain" className="ml-auto !min-h-9 text-sm" onClick={() => window.confirm('이 기기를 해제할까요?') && guard(async () => { await api(`/admin/devices/${d.id}`, { method: 'DELETE' }); refresh(); })}>해제</Button>
            </div>
          ))}
        </div>
      </Card>

      <ArchiveCard />

      {issued && (
        <Modal title={issued.title} onClose={() => setIssued(null)}>
          <p className="my-6 text-center text-5xl font-bold tracking-widest">{issued.pin}</p>
          <p className="text-center text-base font-semibold text-red-600">이 번호는 지금 한 번만 보여집니다. 꼭 적어 두세요.</p>
        </Modal>
      )}
    </>
  );
}
