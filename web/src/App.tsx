import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import NewOrder from './pages/NewOrder';
import Settings from './pages/Settings';
import WorkList from './pages/WorkList';
import { useRealtime } from './realtime';

const TABS = [
  { to: '/', label: '대시보드', icon: '📊', front: true },
  { to: '/new', label: '작업지시서', icon: '📝', front: true },
  { to: '/work', label: '작업목록', icon: '🔧', front: false },
  { to: '/settings', label: '설정', icon: '⚙️', front: true },
];

function Shell() {
  const { user } = useAuth();
  useRealtime();
  const isFront = user!.role !== 'workshop';
  const tabs = TABS.filter((t) => isFront || !t.front);

  return (
    <div className="mx-auto min-h-screen max-w-5xl pb-28">
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
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t-2 border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto grid max-w-5xl grid-cols-4">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-3 text-base font-bold ${isActive ? 'text-blue-600' : 'text-slate-500'}`
                }
              >
                <span className="text-2xl">{t.icon}</span>
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
  if (loading) return <p className="p-10 text-center text-xl">불러오는 중...</p>;
  if (!user) return <Login />;
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
