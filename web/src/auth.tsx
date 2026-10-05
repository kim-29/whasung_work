import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  useEffect(() => {
    if (!tokenStore.get()) return;
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener('whasung:logout', onLogout);
    return () => window.removeEventListener('whasung:logout', onLogout);
  }, []);

  const login = useCallback(async (pin: string) => {
    const label = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? '모바일/태블릿' : 'PC';
    const r = await api<{ token: string; user: User }>('/auth/login', { body: { pin, label } });
    tokenStore.set(r.token);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    tokenStore.clear();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
