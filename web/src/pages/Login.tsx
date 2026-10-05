import { useState } from 'react';
import { useAuth } from '../auth';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '지움', '0', '←'];

export default function Login() {
  const { login } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const press = async (k: string) => {
    if (busy) return;
    setError('');
    if (k === '지움') return setPin('');
    if (k === '←') return setPin((p) => p.slice(0, -1));
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length === 6) {
      setBusy(true);
      try {
        await login(next);
      } catch (e) {
        setError((e as Error).message);
        setPin('');
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-5 py-8">
      <h1 className="mb-2 text-center text-3xl font-bold">화성 알루미늄</h1>
      <p className="mb-6 text-center text-lg text-slate-600">PIN 번호 6자리를 눌러 주세요</p>

      <div className="mb-4 flex justify-center gap-3" aria-label="입력한 자릿수">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`h-5 w-5 rounded-full ${i < pin.length ? 'bg-blue-600' : 'bg-slate-300'}`} />
        ))}
      </div>
      <p className="mb-4 min-h-14 text-center text-lg font-bold text-red-600">{error}</p>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            disabled={busy}
            className={`h-20 rounded-2xl text-3xl font-bold shadow-sm active:scale-95 ${
              k.length > 1 || k === '←' ? 'bg-slate-200 text-xl' : 'bg-white'
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <p className="mt-6 text-center text-sm text-slate-500">PIN을 모르시면 관리자에게 문의해 주세요.</p>
    </div>
  );
}
