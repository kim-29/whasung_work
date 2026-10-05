import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

const tones = {
  primary: 'bg-blue-600 text-white active:bg-blue-700',
  success: 'bg-emerald-600 text-white active:bg-emerald-700',
  danger: 'bg-red-600 text-white active:bg-red-700',
  plain: 'bg-white text-slate-800 border-2 border-slate-300 active:bg-slate-100',
} as const;

export function Button({
  tone = 'primary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof tones }) {
  return (
    <button
      {...p}
      className={`min-h-12 rounded-xl px-5 text-base font-bold disabled:opacity-50 ${tones[tone]} ${className}`}
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-4 shadow-sm ${className}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-bold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function Badge({ children, color = 'slate' }: { children: ReactNode; color?: 'slate' | 'blue' | 'amber' | 'red' | 'green' }) {
  const c = {
    slate: 'bg-slate-200 text-slate-700',
    blue: 'bg-blue-100 text-blue-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    green: 'bg-emerald-100 text-emerald-800',
  }[color];
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${c}`}>{children}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{title}</h2>
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
      <div className="no-print pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-md rounded-2xl px-5 py-4 text-lg font-bold text-white shadow-lg ${
              t.kind === 'ok' ? 'bg-emerald-600' : 'bg-red-600'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
