import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';
import type { MailService, User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 내 메일 서비스·주소 저장 (거래 내용을 보낼 때 열 메일 서비스) */
  saveMail: (mail_service: MailService | null, mail_address: string) => Promise<void>;
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

  const saveMail = useCallback(async (mail_service: MailService | null, mail_address: string) => {
    const r = await api<{ mail_service: MailService | null; mail_address: string | null }>('/auth/mail', {
      method: 'PUT',
      body: { mail_service, mail_address },
    });
    setUser((u) => (u ? { ...u, mail_service: r.mail_service, mail_address: r.mail_address } : u));
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout, saveMail }}>{children}</Ctx.Provider>;
}
