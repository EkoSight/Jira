import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon } from './ui.jsx';

/**
 * Shown to an admin only while there is no super admin at all: they can take
 * the first place by confirming their password. After that it never shows
 * again; further super admins are made on the Team page.
 */
export default function SuperAdminClaim() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    api.accessStatus().then(setStatus).catch(() => setStatus(null));
  }, [user?.role]);

  if (!status?.can_claim) return null;

  const claim = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.claimSuperAdmin(password);
      const me = await api.me();
      setUser(me.user);
      setStatus({ ...status, can_claim: false });
      toast.success('You are now a super admin. Make the other founder one on the Team page.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <section className="card card-pad stack-sm" aria-label="Become a super admin">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="alert" />
        <h3>There is no super admin yet</h3>
      </div>
      <div className="small">
        Super admins are the founders: every power, including approving payroll, and no attendance or check-in. Until one
        exists, nobody can approve payroll. If you are a founder, confirm your password to become the first. Every other
        admin is told, and it is recorded.
      </div>
      <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={claim}>
        <Field label="Your password">
          <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? 'Confirming…' : 'Make me a super admin'}</button>
      </form>
    </section>
  );
}
