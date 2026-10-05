import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import NewOrder from './pages/NewOrder';
import Settings from './pages/Settings';
import WorkList from './pages/WorkList';
import { useRealtime } from './realtime';

const TABS = [
  { to: '/', label: '대시보드' },
  { to: '/new', label: '작업지시서' },
  { to: '/work', label: '작업목록' },
  { to: '/settings', label: '설정' },
];

const ROLE_LABEL = { admin: '관리자', staff: '직원', workshop: '작업장' } as const;

function Shell() {
  const { user } = useAuth();
  useRealtime();
  const isFront = user!.role !== 'workshop';

  return (
    <div className="mx-auto min-h-screen max-w-5xl bg-slate-100 pb-20 shadow-sm">
      <header className="no-print sticky top-0 z-30 flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
        <span className="text-lg font-bold tracking-wide">화성 알루미늄</span>
        <span className="text-sm text-slate-300">
          {user!.name} · {ROLE_LABEL[user!.role]}
        </span>
      </header>
      <main className="p-3 sm:p-5">
        <Routes>
          {isFront && <Route path="/" element={<Dashboard />} />}
          {isFront && <Route path="/new" element={<NewOrder />} />}
          <Route path="/work" element={<WorkList />} />
          {isFront && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<Navigate to={isFront ? '/' : '/work'} replace />} />
        </Routes>
      </main>
      {isFront && (
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 bg-slate-900 pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto grid max-w-5xl grid-cols-4">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end
                className={({ isActive }) =>
                  `border-t-4 py-3.5 text-center text-base font-semibold ${
                    isActive ? 'border-white bg-slate-800 text-white' : 'border-transparent text-slate-400'
                  }`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-10 text-center text-lg">불러오는 중...</p>;
  if (!user) return <Login />;
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
