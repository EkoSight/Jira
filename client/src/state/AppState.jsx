import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, tokenStore, setUnauthorizedHandler } from '../api/client.js';
import { REFRESH_MS, applyBranding, cachedBranding, fetchBranding, rememberLook, resolveMode, storedAccent, storedMode } from '../lib/brand.js';
import { clearPhotoVersions, loadPhotoVersions } from '../lib/photos.js';

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
    clearPhotoVersions();
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
    loadPhotoVersions({ force: true });
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

// ---------------------------------------------------------------- branding and look

const BrandContext = createContext(null);

/**
 * The organisation's name, colours and logos, and the person's own look
 * (light, dark or match the device; an optional accent). Their saved choice
 * follows them to every device; the organisation's changes arrive without a
 * redeploy (checked on return to the app and every two minutes).
 */
export function BrandingProvider({ children }) {
  const { user, setUser } = useAuth();
  const [branding, setBranding] = useState(cachedBranding);
  const [mode, setModeState] = useState(() => user?.theme_mode || storedMode());
  const [accent, setAccentState] = useState(() => (user ? user.theme_accent ?? null : storedAccent()));

  // a person's saved look wins once they are signed in
  useEffect(() => {
    if (!user) return;
    if (user.theme_mode) setModeState(user.theme_mode);
    setAccentState(user.theme_accent ?? null);
  }, [user?.id, user?.theme_mode, user?.theme_accent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyBranding(branding, { mode, accent });
    rememberLook({ mode, accent });
    if (mode !== 'SYSTEM' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => applyBranding(branding, { mode, accent });
    mq.addEventListener?.('change', follow);
    return () => mq.removeEventListener?.('change', follow);
  }, [branding, mode, accent]);

  const refresh = useCallback(() => fetchBranding()
    .then((b) => setBranding((current) => (JSON.stringify(current) === JSON.stringify(b) ? current : b)))
    .catch(() => {}), []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const back = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, [refresh]);

  const savePrefs = useCallback(async (changes) => {
    if (!tokenStore.get()) return;
    try {
      const saved = await api.put('/auth/me/preferences', changes);
      setUser((u) => (u ? { ...u, ...saved } : u));
    } catch { /* kept in this browser; saved to the account next time */ }
  }, [setUser]);

  const value = useMemo(() => {
    const setMode = (m) => { setModeState(m); savePrefs({ theme_mode: m }); };
    const setAccent = (a) => { setAccentState(a || null); savePrefs({ theme_accent: a || null }); };
    return {
      branding, setBranding, refresh, mode, accent, setMode, setAccent,
      resolved: resolveMode(mode),
      toggle: () => setMode(resolveMode(mode) === 'dark' ? 'LIGHT' : 'DARK'),
    };
  }, [branding, refresh, mode, accent, savePrefs]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export const useBranding = () => useContext(BrandContext);

/** [light|dark, switch] for the top bar's quick switch. */
export function useTheme() {
  const b = useContext(BrandContext);
  return [b.resolved, b.toggle];
}
