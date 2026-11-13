import { useState } from 'react';
import { api, tokenStore } from '../api/client.js';
import { useAuth, useBranding, useToast } from '../state/AppState.jsx';
import { Field } from '../components/ui.jsx';
import { BrandMark, Wordmark } from '../components/BrandMark.jsx';

function Shell({ children }) {
  const { branding } = useBranding();
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={56} mode="intro" label="" />
          <h1 className="brand-name">
            <span className="brand-app">{branding.appName}</span>
            {branding.byline && <span className="brand-byline">{branding.byline}</span>}
          </h1>
        </div>
        {children}
        <div className="login-company">
          <Wordmark height={34} />
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { signIn } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <Field label="Work email">
          <input
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="small muted center" style={{ paddingTop: 4 }}>
          Ask an administrator to add you if you do not have an account.
        </div>
      </form>
    </Shell>
  );
}

/**
 * Shown instead of the app while must_change_password is set, so a member who
 * signed in with a temporary password cannot skip past it.
 */
export function ForcePasswordChange() {
  const { user, setUser, signOut } = useAuth();
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (next.length < 8) return toast.error('Use at least 8 characters');
    if (next !== confirm) return toast.error('The two passwords do not match');

    setBusy(true);
    try {
      const data = await api.changePassword(current, next);
      tokenStore.set(data.token);
      setUser(data.user);
      toast.success('Password updated');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <div className="small dim">
          Welcome{user?.full_name ? `, ${user.full_name.split(' ')[0]}` : ''}. Choose your own password before you
          continue.
        </div>
        <Field label="Temporary password you were given">
          <input
            type="password"
            className="input"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <input
            type="password"
            className="input"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={signOut}>
          Sign in as someone else
        </button>
      </form>
    </Shell>
  );
}
