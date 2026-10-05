import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtDate } from '../api';
import { useAuth } from '../auth';
import { PushCard } from '../push';
import type { Bar } from '../types';
import { Badge, Button, Card, Field, Modal, useToast } from '../ui';

export default function Settings() {
  const { user, logout } = useAuth();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">설정</h1>
      <PushCard />
      <Bars />
      {user!.role === 'admin' && <AdminPanel />}
      <Card className="flex items-center justify-between">
        <span className="text-lg">{user!.name}님으로 로그인됨</span>
        <Button tone="plain" onClick={() => window.confirm('이 기기에서 로그아웃할까요?') && logout()}>로그아웃</Button>
      </Card>
    </div>
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
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-bold">바(자재) 목록</h2>
        <Button onClick={() => setEdit({ name: '', kg_per_m: '', note: '' })}>+ 바 추가</Button>
      </div>
      <p className="mb-3 text-base text-slate-500">무게는 1미터당 kg 입니다. 고쳐도 이미 접수된 작업의 무게는 바뀌지 않습니다.</p>
      <div className="divide-y">
        {q.data?.map((b) => (
          <div key={b.id} className="flex items-center gap-2 py-3">
            <span className="flex-1 text-lg font-bold">{b.name}</span>
            <span className="text-lg">{b.kg_per_m} kg/m</span>
            <Button tone="plain" onClick={() => setEdit({ id: b.id, name: b.name, kg_per_m: String(b.kg_per_m), note: b.note ?? '' })}>수정</Button>
            <Button tone="plain" onClick={() => remove(b)}>삭제</Button>
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
      <Card className="space-y-3">
        <h2 className="text-xl font-bold">직원 관리 (관리자 전용)</h2>
        <div className="flex gap-2">
          <input placeholder="새 직원 이름" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name.trim()} onClick={addStaff} className="shrink-0">PIN 발급</Button>
        </div>
        <div className="divide-y">
          {users.data?.filter((u) => u.role !== 'workshop').map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 py-3">
              <span className="text-lg font-bold">{u.name}</span>
              <Badge color={u.role === 'admin' ? 'blue' : 'slate'}>{u.role === 'admin' ? '관리자' : '직원'}</Badge>
              {!u.active && <Badge color="red">사용 중지</Badge>}
              {u.role !== 'admin' && (
                <span className="ml-auto flex gap-2">
                  <Button tone="plain" onClick={() => reissue(u)}>PIN 재발급</Button>
                  <Button tone="plain" onClick={() => toggle(u)}>{u.active ? '사용 중지' : '다시 사용'}</Button>
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-xl font-bold">작업장 PIN</h2>
        <p className="text-base text-slate-500">작업장 태블릿/폰이 처음 한 번 입력하는 번호입니다.</p>
        <Button onClick={workshopPin}>{users.data?.some((u) => u.role === 'workshop') ? '작업장 PIN 다시 발급' : '작업장 PIN 발급'}</Button>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">등록된 기기</h2>
          <Button tone="plain" onClick={() => api('/admin/unlock', { body: {} }).then(() => toast('로그인 잠금을 풀었습니다.'))}>잠금 풀기</Button>
        </div>
        <div className="divide-y">
          {devices.data?.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 py-3">
              <span className="font-bold">{d.user_name}</span>
              <span className="text-base text-slate-500">{d.label} · 마지막 사용 {fmtDate(d.last_used_at, true)}</span>
              <Button tone="plain" className="ml-auto" onClick={() => window.confirm('이 기기를 해제할까요?') && guard(async () => { await api(`/admin/devices/${d.id}`, { method: 'DELETE' }); refresh(); })}>해제</Button>
            </div>
          ))}
        </div>
      </Card>

      {issued && (
        <Modal title={issued.title} onClose={() => setIssued(null)}>
          <p className="my-6 text-center text-6xl font-bold tracking-widest">{issued.pin}</p>
          <p className="text-center text-lg font-bold text-red-600">이 번호는 지금 한 번만 보여집니다. 꼭 적어 두세요.</p>
        </Modal>
      )}
    </>
  );
}
