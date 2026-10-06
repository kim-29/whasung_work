import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

const tones = {
  primary: 'bg-blue-600 text-white active:bg-blue-700',
  success: 'bg-emerald-600 text-white active:bg-emerald-700',
  danger: 'bg-red-600 text-white active:bg-red-700',
  plain: 'bg-white text-slate-800 border border-slate-400 active:bg-slate-200',
} as const;

export function Button({
  tone = 'primary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof tones }) {
  return (
    <button
      {...p}
      className={`min-h-11 rounded-xl px-4 text-base font-semibold disabled:opacity-40 ${tones[tone]} ${className}`}
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-300 bg-white p-4 ${className}`}>{children}</div>;
}

/** 제목과 입력칸을 한 줄에 나란히 놓는다(inline). 기본은 제목이 위. */
export function Field({ label, children, inline }: { label: string; children: ReactNode; inline?: boolean }) {
  return inline ? (
    <label className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-sm font-semibold text-slate-600">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  ) : (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function Badge({ children, color = 'slate' }: { children: ReactNode; color?: 'slate' | 'blue' | 'amber' | 'red' | 'green' }) {
  const c = {
    slate: 'bg-slate-200 text-slate-700',
    blue: 'bg-blue-600 text-white',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-600 text-white',
    green: 'bg-emerald-100 text-emerald-800',
  }[color];
  return <span className={`inline-block rounded-xl px-2.5 py-0.5 text-sm font-semibold ${c}`}>{children}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between border-b border-slate-300 pb-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <Button tone="plain" onClick={onClose}>
            닫기
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- 알림 메시지(토스트) ----------
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'error' }[]>([]);
  const push = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed inset-x-0 top-24 z-50 flex flex-col items-center gap-2 px-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-md rounded-xl border px-4 py-3 text-base font-semibold text-white shadow-lg ${
              t.kind === 'ok' ? 'border-black bg-slate-900' : 'border-red-800 bg-red-600'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** 휴지통 아이콘 (삭제 버튼용) */
export function TrashIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  );
}
