import { useEffect, useState } from 'react';
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

/**
 * "Forgot password?": always the same answer, whether or not the address has
 * an account. The emailed temporary password works alongside the current one.
 */
function ForgotPassword({ initialEmail, onBack }) {
  const toast = useToast();
  const [email, setEmail] = useState(initialEmail || '');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const r = await api.forgotPassword(email.trim());
      setAnswer(r.message);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  if (answer) {
    return (
      <div className="stack">
        <div className="mkt-callout small" role="status">{answer}</div>
        <div className="small muted">
          The email has a temporary password. Your current password keeps working until you use it. When you sign in
          with it, you choose a new one.
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onBack}>Back to sign in</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit}>
      <div className="small dim">Enter your work email. If it has an account, we'll email you a temporary password.</div>
      <Field label="Work email">
        <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
      </Field>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Email me a temporary password'}</button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>Back to sign in</button>
    </form>
  );
}

export default function Login() {
  const { signIn } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotOffered, setForgotOffered] = useState(false);
  const [forgot, setForgot] = useState(false);

  // offered only while the server can send it
  useEffect(() => {
    api.authOptions().then((r) => setForgotOffered(Boolean(r.forgot_password))).catch(() => setForgotOffered(false));
  }, []);

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

  if (forgot) {
    return (
      <Shell>
        <ForgotPassword initialEmail={email} onBack={() => setForgot(false)} />
      </Shell>
    );
  }

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
        {forgotOffered && (
          <button type="button" className="btn-link small center" onClick={() => setForgot(true)}>Forgot password?</button>
        )}
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
