import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

/**
 * Today's attendance for the signed-in person, shared by the dashboard card,
 * the check-in screen and the sign-out reminder. Refreshed on focus, every few
 * minutes, and immediately when the server turns a change away for want of a
 * check-in.
 */

const AttendanceContext = createContext(null);

export function AttendanceProvider({ children }) {
  const [today, setToday] = useState(null);
  const [error, setError] = useState(null);

  const reload = useCallback(
    () => api.attendanceToday().then((data) => { setToday(data); setError(null); return data; }).catch((err) => { setError(err); return null; }),
    [],
  );

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 3 * 60 * 1000);
    const onFocus = () => reload();
    const onRequired = () => reload();
    window.addEventListener('focus', onFocus);
    window.addEventListener('taskflow:attendance-required', onRequired);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('taskflow:attendance-required', onRequired);
    };
  }, [reload]);

  const value = useMemo(() => {
    const open = today?.open_session || null;
    return {
      today,
      error,
      reload,
      // the check-in screen shows only when the server says so — never on a guess
      blocked: Boolean(today?.gate?.required && !today?.gate?.satisfied),
      openSession: open,
    };
  }, [today, error, reload]);

  return <AttendanceContext.Provider value={value}>{children}</AttendanceContext.Provider>;
}

export const useAttendance = () => useContext(AttendanceContext) || { today: null, reload: () => Promise.resolve(null), blocked: false, openSession: null };
