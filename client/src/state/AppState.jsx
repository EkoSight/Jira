import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, tokenStore, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);
const ToastContext = createContext(null);
const RefDataContext = createContext(null);

// ---------------------------------------------------------------- toasts

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const push = useCallback((message, tone = 'info') => {
    const id = (counter.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4500);
  }, []);

  const value = useMemo(
    () => ({
      info: (m) => push(m, 'info'),
      success: (m) => push(m, 'success'),
      error: (m) => push(typeof m === 'string' ? m : m?.message || 'Something went wrong', 'error'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------------------------------------------------------------- auth

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      tokenStore.clear();
      setUser(null);
    });
  }, []);

  useEffect(() => {
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (email, password) => {
    const data = await api.login(email, password);
    tokenStore.set(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      setUser,
      can: (permission) => Boolean(user?.permissions?.includes(permission)),
      canAny: (...permissions) => permissions.some((p) => user?.permissions?.includes(p)),
    }),
    [user, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// ---------------------------------------------------------------- reference data

/**
 * Departments, statuses and people barely change but are needed on nearly every
 * screen, so they are fetched once and refreshed on demand.
 */
export function RefDataProvider({ children }) {
  const { user } = useAuth();
  const [data, setData] = useState({ departments: [], statuses: [], users: [], settings: null });
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [departments, statuses, users, settings] = await Promise.all([
      api.departments().catch(() => ({ departments: [] })),
      api.statuses().catch(() => ({ statuses: [] })),
      api.users().catch(() => ({ users: [] })),
      api.settings().catch(() => ({ settings: null })),
    ]);
    setData({
      departments: departments.departments || [],
      statuses: statuses.statuses || [],
      users: users.users || [],
      settings: settings.settings || null,
    });
    setReady(true);
  }, [user]);

  useEffect(() => {
    if (user) refresh();
    else setReady(false);
  }, [user, refresh]);

  const value = useMemo(
    () => ({
      ...data,
      ready,
      refresh,
      departmentById: Object.fromEntries(data.departments.map((d) => [d.id, d])),
      statusById: Object.fromEntries(data.statuses.map((s) => [s.id, s])),
      userById: Object.fromEntries(data.users.map((u) => [u.id, u])),
    }),
    [data, ready, refresh],
  );

  return <RefDataContext.Provider value={value}>{children}</RefDataContext.Provider>;
}

export const useRefData = () => useContext(RefDataContext);

// ---------------------------------------------------------------- misc hooks

export function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('taskflow.theme') || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('taskflow.theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}
