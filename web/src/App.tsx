import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Analytics from './pages/Analytics';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import NewOrder from './pages/NewOrder';
import Settings, { BarsPage, CompaniesPage } from './pages/Settings';
import WorkList from './pages/WorkList';
import { useRealtime } from './realtime';

const TABS = [
  { to: '/dashboard', label: '대시보드' },
  { to: '/work', label: '작업목록' },
  { to: '/new', label: '작업지시서' },
  { to: '/analytics', label: '판매분석' },
  { to: '/settings', label: '설정' },
];

const ROLE_LABEL = { admin: '관리자', staff: '직원', workshop: '작업장' } as const;

/** 로고: 노란 글씨 */
function Logo() {
  return <span className="whitespace-nowrap text-lg font-bold tracking-wide text-[#facc15]">화성알루미늄</span>;
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
            <nav className="order-3 grid w-full grid-cols-5 sm:order-2 sm:flex sm:w-auto sm:gap-1">
              {TABS.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.to !== '/settings'}
                  className={({ isActive }) =>
                    `cursor-pointer whitespace-nowrap border-b-4 px-0 pb-2.5 pt-2 text-center text-[13px] font-semibold tracking-tight sm:px-4 sm:text-base sm:tracking-normal ${
                      isActive ? 'border-[#facc15] text-white' : 'border-white text-slate-300 hover:text-white'
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
          {isFront && <Route path="/new" element={<NewOrder />} />}
          {isFront && <Route path="/dashboard" element={<Dashboard />} />}
          {isFront && <Route path="/analytics" element={<Analytics />} />}
          <Route path="/work" element={<WorkList />} />
          {isFront && <Route path="/settings" element={<Settings />} />}
          {isFront && <Route path="/settings/companies" element={<CompaniesPage />} />}
          {isFront && <Route path="/settings/bars" element={<BarsPage />} />}
          <Route path="*" element={<Navigate to={isFront ? '/dashboard' : '/work'} replace />} />
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
