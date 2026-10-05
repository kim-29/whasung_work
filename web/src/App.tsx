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

/** 알루미늄 바 단면을 본뜬 간단한 로고 */
function Logo() {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap text-lg font-bold tracking-wide text-white">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect x="1" y="3" width="20" height="3.5" fill="#d5d9dd" />
        <rect x="1" y="9.25" width="20" height="3.5" fill="#fff" />
        <rect x="1" y="15.5" width="20" height="3.5" fill="#d5d9dd" />
      </svg>
      화성알루미늄
    </span>
  );
}

function Shell() {
  const { user } = useAuth();
  useRealtime();
  const isFront = user!.role !== 'workshop';

  return (
    <div className="mx-auto min-h-screen max-w-5xl bg-slate-100 pb-8">
      <header className="no-print sticky top-0 z-30 bg-slate-900 px-4 pt-3 text-white">
        <div className="flex flex-wrap items-end gap-x-6">
          <div className="order-1 flex flex-1 items-center justify-between pb-3 sm:flex-none sm:justify-start">
            <Logo />
          </div>
          {isFront && (
            <nav className="order-3 grid w-full grid-cols-4 sm:order-2 sm:flex sm:w-auto sm:gap-1">
              {TABS.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end
                  className={({ isActive }) =>
                    `cursor-pointer whitespace-nowrap border-b-4 px-1 pb-2.5 pt-2 text-center text-[15px] font-semibold sm:px-4 sm:text-base ${
                      isActive ? 'border-orange-500 text-white' : 'border-white text-slate-300 hover:text-white'
                    }`
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          )}
          <span className="order-2 ml-auto whitespace-nowrap pb-3 text-sm text-slate-300 sm:order-3">
            {user!.name} · {ROLE_LABEL[user!.role]}
          </span>
        </div>
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
