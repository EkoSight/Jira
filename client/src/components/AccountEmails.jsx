/**
 * Account emails on the Team page and in Settings (docs/ACCOUNT_EMAILS.md):
 * the "email their sign-in details" tick box, the result of creating an
 * account or resetting a password, "Resend sign-in details", a person's
 * account email history, and Settings → Email.
 *
 * A temporary password is shown only when it could not be emailed, once, and
 * is never kept in the browser.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Badge, Field, Modal, Spinner } from './ui.jsx';
import { formatDate } from '../lib/format.js';

/** Whether account emails can go out right now (for the tick boxes). */
export function useEmailReadiness(active = true) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    let gone = false;
    api.accountEmailReadiness()
      .then((r) => { if (!gone) setState(r); })
      .catch(() => { if (!gone) setState({ ready: false, reason: 'Could not check whether email is set up' }); });
    return () => { gone = true; };
  }, [active]);
  return state;
}

/** "Email their sign-in details to …", on by default when email can go out. */
export function EmailTick({ readiness, checked, onChange, label }) {
  if (!readiness) return <div className="small muted">Checking whether email is set up…</div>;
  return (
    <div className="stack-xs">
      <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={Boolean(readiness.ready && checked)} disabled={!readiness.ready} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {!readiness.ready && (
        <div className="small muted" style={{ paddingLeft: 24 }}>
          Email is not set up ({readiness.reason}). You'll see the password here to pass on.
        </div>
      )}
    </div>
  );
}

/** The temporary password, shown once, when it was not emailed. */
function PasswordOnce({ password, expiresAt, name, reason }) {
  return (
    <div className="stack">
      {reason && <div className="mkt-callout is-warning small">We couldn't email it ({reason}). Pass this on yourself.</div>}
      <p style={{ margin: 0 }}>Share this temporary password with {name}. They will be asked to choose their own when they sign in.</p>
      <div
        className="card card-pad tnum center ae-password"
        style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.06em', userSelect: 'all' }}
      >
        {password}
      </div>
      <div className="small muted">
        {expiresAt ? `It works until ${formatDate(expiresAt, { withTime: true })}. ` : ''}
        It cannot be shown again; you can always issue a new one.
      </div>
    </div>
  );
}

/** What happened: emailed, or the password once (with why it was not emailed). */
export function SignInResult({ result, name }) {
  if (result.temporary_password) {
    return <PasswordOnce password={result.temporary_password} expiresAt={result.temporary_password_expires_at} name={name} reason={result.email && !result.email.sent ? result.email.reason : null} />;
  }
  if (result.email?.sent) {
    return (
      <div className="stack-sm">
        <div className="mkt-callout small" role="status">
          <strong>Sign-in details emailed to {result.email.to}.</strong>
        </div>
        {result.temporary_password_expires_at && (
          <div className="small muted">
            Their temporary password works until {formatDate(result.temporary_password_expires_at, { withTime: true })}.
            They choose their own when they sign in.
          </div>
        )}
      </div>
    );
  }
  return <div className="small muted">Done.</div>;
}

/** Team → Reset password: the old password stops working; the new one emailed, or shown once. */
export function ResetPasswordDialog({ member, onClose }) {
  const toast = useToast();
  const readiness = useEmailReadiness();
  const [emailIt, setEmailIt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const reset = async () => {
    setBusy(true);
    try {
      setResult(await api.resetPassword(member.id, { email_details: Boolean(readiness?.ready && emailIt) }));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={result ? 'Password reset' : `Reset ${member.full_name}'s password?`}
      onClose={onClose}
      footer={result
        ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        : (
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || !readiness} onClick={reset}>{busy ? 'Resetting…' : 'Reset password'}</button>
          </>
        )}
    >
      {result ? <SignInResult result={result} name={member.full_name} /> : (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>
            Their current password stops working and they are signed out everywhere. They get a temporary password
            and choose their own when they next sign in.
          </p>
          <EmailTick readiness={readiness} checked={emailIt} onChange={setEmailIt} label={`Email the new temporary password to ${member.email}`} />
        </div>
      )}
    </Modal>
  );
}

const KIND_WORDS = {
  WELCOME: 'Sign-in details',
  RESET: 'Password reset',
  CHAT_STEPS: 'Steps to connect Google Chat',
  FORGOT: '"Forgot password?"',
  PASSWORD_CHANGED: 'Password changed',
  TEST: 'Test',
};
const STATUS = { SENT: ['Sent', 'good'], FAILED: ['Not sent', 'critical'], NOT_SET_UP: ['Email not set up', 'warning'] };

/** How reminders reach this person: Chat connected or not, email reachable or bounced, with "Clear the bounce". */
function ReminderReach({ member }) {
  const toast = useToast();
  const [reach, setReach] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/users/${member.id}/reminder-reach`).then(setReach).catch(() => setReach(false));
  useEffect(() => { load(); }, [member.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!reach) return null;
  const clear = async () => {
    if (!window.confirm(`Clear the bounce for ${member.email}? Do this once the address is fixed: reminder emails to it start again.`)) return;
    setBusy(true);
    try { await api.post(`/users/${member.id}/clear-email-bounce`); toast.success('Cleared. Reminder emails to this address resume'); load(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <div className="stack-xs">
      <div className="stat-label">Reminders reach them</div>
      <div className="reach-row small">
        <span>Google Chat</span>
        <Badge tone={reach.chat.connected ? 'good' : 'warning'}>{reach.chat.connected ? 'connected' : 'not connected'}</Badge>
        {!reach.chat.connected && <span className="muted">{reach.chat.why}</span>}
      </div>
      <div className="reach-row small">
        <span>Email</span>
        {reach.email.bounced ? <Badge tone="critical">bounced</Badge> : reach.email.ready ? <Badge tone="good">ok</Badge> : <Badge tone="neutral">not set up</Badge>}
        {reach.email.bounced && <span className="muted">{formatDate(reach.email.bounced_at, { withTime: true })}: {reach.email.bounced_reason}</span>}
        {reach.email.bounced && <button type="button" className="btn btn-sm" disabled={busy} onClick={clear}>Clear the bounce</button>}
        {!reach.email.bounced && !reach.email.ready && <span className="muted">{reach.email.why}</span>}
      </div>
      <div className="small muted">Task reminders: {reach.words.task_reminders}. Summaries: {reach.words.summaries}.</div>
    </div>
  );
}

/** Team → a person: whether they have signed in yet, "Resend sign-in details", and their account emails. */
export function SignInPanel({ member, canManage }) {
  const toast = useToast();
  const readiness = useEmailReadiness(canManage);
  const [emails, setEmails] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const load = () => api.accountEmails(member.id).then((r) => setEmails(r.emails)).catch(() => setEmails([]));
  useEffect(() => { if (canManage) load(); }, [member.id, canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canManage) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const r = await api.resendSignIn(member.id);
      setResult(r);
      setConfirming(false);
      if (r.email?.sent) toast.success(`Sign-in details emailed to ${r.email.to}`);
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const expires = member.temp_password_expires_at ? new Date(member.temp_password_expires_at) : null;
  const expired = expires && expires <= new Date();

  return (
    <section className="card card-pad stack-sm" aria-labelledby={`signin-${member.id}`}>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <h3 id={`signin-${member.id}`}>Sign-in</h3>
        {member.must_change_password
          ? <Badge tone={expired ? 'critical' : 'warning'}>{expired ? 'Temporary password expired' : 'Has not chosen a password yet'}</Badge>
          : <Badge tone="good">Using their own password</Badge>}
      </div>
      {member.must_change_password && (
        <div className="stack-sm">
          <div className="small muted">
            {expires
              ? (expired ? `Their temporary password stopped working on ${formatDate(expires, { withTime: true })}.` : `Their temporary password works until ${formatDate(expires, { withTime: true })}.`)
              : 'They have a temporary password from before passwords expired.'}
          </div>
          {result ? <SignInResult result={result} name={member.full_name} /> : confirming ? (
            <div className="mkt-callout small stack-xs">
              <span>This replaces the earlier password: the one sent before stops working.</span>
              <span className="row wrap" style={{ gap: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={resend}>{busy ? 'Sending…' : `Email new details to ${member.email}`}</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
              </span>
            </div>
          ) : (
            <div className="stack-xs">
              <span><button type="button" className="btn btn-sm" disabled={!readiness?.ready} onClick={() => setConfirming(true)}>Resend sign-in details</button></span>
              {readiness && !readiness.ready && <span className="small muted">Email is not set up ({readiness.reason}). Use Reset password to see a new one here.</span>}
            </div>
          )}
        </div>
      )}
      <ReminderReach member={member} />
      <div className="stack-xs">
        <div className="stat-label">Account emails</div>
        {!emails ? <Spinner label="Loading" /> : emails.length === 0 ? <div className="small muted">None yet.</div> : (
          <ul className="plain-list small stack-xs ae-history">
            {emails.map((e) => {
              const [label, tone] = STATUS[e.status] || [e.status, 'neutral'];
              return (
                <li key={e.id} className="row wrap" style={{ gap: 6 }}>
                  <span className="tnum muted">{formatDate(e.created_at, { withTime: true })}</span>
                  <span>{KIND_WORDS[e.kind] || e.kind}</span>
                  <Badge tone={tone}>{label}</Badge>
                  <span className="muted">{e.triggered_by_name ? `by ${e.triggered_by_name}` : e.kind === 'FORGOT' ? 'asked for by them' : ''}</span>
                  {e.status !== 'SENT' && e.error && <span className="muted">· {e.error}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Settings → Email: who account emails come from, how long a temporary password works, and a test. */
export function EmailSettings() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = () => Promise.all([api.accountEmailStatus(), api.settings()])
    .then(([s, all]) => { setStatus(s); setForm({ ...all.defaults.accountEmails, ...all.settings.accountEmails }); })
    .catch((err) => toast.error(err));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!form || !status) return <Spinner label="Loading email settings" />;
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings('accountEmails', {
        senderName: form.senderName.trim(),
        senderEmail: form.senderEmail.trim(),
        replyTo: form.replyTo.trim(),
        expiryHours: Number(form.expiryHours),
        forgotPassword: Boolean(form.forgotPassword),
      });
      toast.success('Saved');
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const { email } = await api.sendAccountTestEmail();
      if (email.sent) toast.success(`Test sent to ${email.to}${status.outbox_only ? ' (outbox only: recorded, not delivered)' : ''}`);
      else toast.error(`Not sent: ${email.reason}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="stack">
      <section className="card card-pad stack-sm">
        <div className="row-between wrap" style={{ gap: 8 }}>
          <h2>Account emails</h2>
          <Badge tone={status.ready ? 'good' : 'warning'}>{status.ready ? 'Ready' : 'Not sending yet'}</Badge>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Sign-in details for new accounts, password resets, "Forgot password?" and "your password was changed". These
          are not marketing: no unsubscribe link, and they never count in campaign figures.
        </p>
        {!status.ready && <div className="mkt-callout is-warning small">{status.reason}. Until then, a temporary password is shown on screen for the administrator to pass on.</div>}
        <div className="small">
          <strong>Email service on the server:</strong> {status.provider_label || 'Not set up'}
          {status.missing?.length > 0 && <div className="muted">Missing: {status.missing.join(', ')}</div>}
        </div>
      </section>

      <section className="card card-pad stack-sm">
        <h3>Who they come from</h3>
        <div className="grid-2">
          <Field label="Sender name">
            <input className="input" value={form.senderName} maxLength={80} onChange={set('senderName')} />
          </Field>
          <Field label="Sender address" hint="On a domain your email service has verified, for example no-reply@ your domain">
            <input type="email" className="input" value={form.senderEmail} onChange={set('senderEmail')} placeholder="no-reply@example.com" />
          </Field>
          <Field label="Replies go to (optional)" hint="Leave empty to use the sender address">
            <input type="email" className="input" value={form.replyTo} onChange={set('replyTo')} />
          </Field>
          <Field label="A temporary password works for (hours)" hint="1 to 168 (7 days). The default is 24.">
            <input type="number" min="1" max="168" className="input" value={form.expiryHours} onChange={set('expiryHours')} />
          </Field>
        </div>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={Boolean(form.forgotPassword)} onChange={set('forgotPassword')} />
          Show "Forgot password?" on the sign-in page (only while email is set up)
        </label>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn" disabled={testing || !status.ready} onClick={test}>{testing ? 'Sending…' : 'Send a test to me'}</button>
        </div>
        <div className="small muted">The test goes to your own address and contains no password.</div>
      </section>
    </div>
  );
}
