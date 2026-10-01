import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Field, Icon, Spinner } from './ui.jsx';

/**
 * Google Chat in Settings: the admin's view (is it set up, who has connected,
 * which spaces follow which department) and each person's own choices.
 */

/** In My account: am I connected, and what do I want in Chat. */
export function ChatPreferencesCard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [testing, setTesting] = useState(false);
  const load = useCallback(() => { api.chatMe().then(setData).catch(() => setData(null)); }, []);
  useEffect(load, [load]);
  if (!data || !data.configured) return null;

  const save = async (changes) => {
    try {
      const res = await api.chatPreferences(changes);
      setData((d) => ({ ...d, preferences: res.preferences }));
    } catch (err) { toast.error(err); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Google Chat</h2>
        {data.linked ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>}
      </div>
      <div className="card-pad stack">
        {!data.linked ? (
          <div className="stack-sm small">
            <div>Get your TaskFlow alerts as Google Chat messages:</div>
            <ol className="chat-steps">
              <li>Open <a href="https://chat.google.com" target="_blank" rel="noopener noreferrer">Google Chat</a> with your work account.</li>
              <li>Choose <strong>New chat</strong>, search for <strong>TaskFlow</strong> under apps, and start a chat.</li>
              <li>TaskFlow replies “You’re connected”. Come back here to send a test.</li>
            </ol>
            <div className="muted">Your Google Workspace email must match the email on your TaskFlow profile.</div>
          </div>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={data.preferences.instant} onChange={(e) => save({ instant: e.target.checked })} />
              <span><strong>Instant alerts</strong> — assignments, deadlines, leave and attendance, as they happen</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={data.preferences.morning_summary} onChange={(e) => save({ morning_summary: e.target.checked })} />
              <span><strong>Morning summary</strong> — what is due today, overdue, and waiting for you (working days)</span>
            </label>
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={testing}
                onClick={async () => {
                  setTesting(true);
                  try {
                    const res = await api.chatTest();
                    if (res.ok) toast.success('Sent — check Google Chat');
                    else toast.error(res.error || 'Google did not accept the message yet; it will retry');
                  } catch (err) { toast.error(err); } finally { setTesting(false); }
                }}
              >
                {testing ? 'Sending…' : 'Send me a test message'}
              </button>
              <span className="small muted">You can also reply <code>stop</code> or <code>start</code> to TaskFlow in Chat.</span>
            </div>
          </>
        )}
        <div className="small muted">Everything still appears in TaskFlow’s bell too. Leave reasons, locations and pay are never sent to Chat.</div>
      </div>
    </section>
  );
}

/** The admin tab. */
export default function GoogleChatSettings() {
  const toast = useToast();
  const { settings, departments, refresh } = useRefData();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const load = useCallback(() => { api.chatAdmin().then(setData).catch(toast.error); }, [toast]);
  useEffect(load, [load]);
  useEffect(() => { if (settings?.googleChat) setDraft(settings.googleChat); }, [settings]);

  if (!data || !draft) return <Spinner />;
  const linked = data.people.filter((p) => p.linked);
  const notLinked = data.people.filter((p) => !p.linked);
  const spaces = data.spaces.filter((s) => s.kind === 'SPACE');

  const saveSettings = async (next) => {
    try {
      await api.updateSettings('googleChat', next);
      setDraft(next);
      refresh();
      toast.success('Saved');
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="stack">
      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <div>
            <h2>Google Chat</h2>
            <div className="small muted">Alerts as direct messages, and a daily team summary in department spaces.</div>
          </div>
          {!data.configured ? <Badge tone="serious">Not set up on the server</Badge>
            : data.usable ? <Badge tone="good">Credentials found on the server</Badge>
              : <Badge tone="serious">Key cannot be read</Badge>}
        </div>
        {data.configured && !data.usable && (
          <div className="callout small" style={{ borderLeftColor: 'var(--critical)', background: 'var(--critical-wash)' }}>
            <Icon name="alert" />
            <span>
              {data.key_problem}. On the server, run <code>npm run chat:check</code> in the <code>server</code> folder for details,
              fix <code>server/.env</code>, then restart TaskFlow.
            </span>
          </div>
        )}
        {data.configured ? (
          <dl className="att-dl">
            <dt>Sending as</dt><dd className="truncate">{data.client_email}</dd>
            <dt>Project</dt><dd>{data.project_id || '—'}</dd>
            <dt>Endpoint for Google Cloud</dt><dd><code className="chat-code">{data.endpoint_url}</code></dd>
            <dt>Last 7 days</dt><dd>{data.last_7_days.SENT || 0} sent · {data.last_7_days.PENDING || 0} waiting · {data.last_7_days.FAILED || 0} failed</dd>
          </dl>
        ) : (
          <div className="callout is-quiet small">
            <Icon name="alert" />
            <span>Add GOOGLE_CHAT_CLIENT_EMAIL, GOOGLE_CHAT_PRIVATE_KEY and GOOGLE_CHAT_PROJECT_ID to the server’s .env and restart TaskFlow.</span>
          </div>
        )}
        <label className="check" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={draft.enabled} disabled={!data.configured} onChange={(e) => saveSettings({ ...draft, enabled: e.target.checked })} />
          <span><strong>Send alerts and summaries to Google Chat</strong> {draft.enabled ? '' : '— off. Send yourself a test from My account first.'}</span>
        </label>
      </section>

      <section className="card card-pad stack">
        <h3>What is sent</h3>
        <div className="grid-2">
          <Field label="Morning summary to each person (India time)" hint="Working days only. Skipped when there is nothing to say.">
            <input className="input" type="time" value={draft.morningSummaryTime} onChange={(e) => setDraft({ ...draft, morningSummaryTime: e.target.value })} />
          </Field>
          <Field label="Team summary in department spaces (India time)">
            <input className="input" type="time" value={draft.teamSummaryTime} onChange={(e) => setDraft({ ...draft, teamSummaryTime: e.target.value })} />
          </Field>
        </div>
        <div className="stack-sm">
          <strong className="small">Instant alerts</strong>
          <div className="chat-types">
            {Object.entries(data.alert_types).map(([type, label]) => (
              <label key={type} className="check small">
                <input
                  type="checkbox"
                  checked={draft.alertTypes.includes(type)}
                  onChange={(e) => setDraft({ ...draft, alertTypes: e.target.checked ? [...draft.alertTypes, type] : draft.alertTypes.filter((x) => x !== type) })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div><button type="button" className="btn btn-primary btn-sm" onClick={() => saveSettings(draft)}>Save</button></div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Department spaces</h2></div>
        <div className="card-pad stack-sm">
          <div className="small muted">Add TaskFlow to a Google Chat space (space name → Apps &amp; integrations → Add apps). It appears here; choose the department it follows.</div>
          {spaces.length === 0 ? <div className="small muted">No spaces yet.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Space</th><th>Department</th><th>Daily summary</th><th>Status</th></tr></thead>
                <tbody>
                  {spaces.map((s) => (
                    <tr key={s.id}>
                      <td>{s.display_name || s.space_name}</td>
                      <td>
                        <select
                          className="select"
                          value={s.department_id || ''}
                          disabled={!s.active}
                          onChange={async (e) => {
                            try { await api.chatUpdateSpace(s.id, { department_id: e.target.value ? Number(e.target.value) : null }); load(); } catch (err) { toast.error(err); }
                          }}
                        >
                          <option value="">— choose —</option>
                          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Daily summary in ${s.display_name || s.space_name}`}
                          checked={s.team_summary}
                          disabled={!s.active}
                          onChange={async (e) => { try { await api.chatUpdateSpace(s.id, { team_summary: e.target.checked }); load(); } catch (err) { toast.error(err); } }}
                        />
                      </td>
                      <td>{s.active ? <Badge tone="good">Active</Badge> : <Badge>App removed</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>People</h2><span className="small muted">{linked.length} of {data.people.length} connected</span></div>
        <div className="card-pad stack-sm">
          {notLinked.length > 0 && (
            <div className="small muted">Not yet connected: {notLinked.map((p) => p.full_name).join(', ')}. Each person adds TaskFlow once in Google Chat (New chat → apps → TaskFlow).</div>
          )}
          <div className="chat-people">
            {linked.map((p) => (
              <span key={p.id} className="chat-person"><Avatar name={p.full_name} color={p.avatar_color} size={20} /> {p.full_name}</span>
            ))}
          </div>
        </div>
      </section>

      {data.failures.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Messages Google did not accept</h2>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => { try { const r = await api.chatRetry(); toast.success(`Retried ${r.retried}: ${r.sent} sent`); load(); } catch (err) { toast.error(err); } }}
            >
              Try again
            </button>
          </div>
          <div className="card-pad stack-sm small">
            {data.failures.map((f) => (
              <div key={f.id}><strong>{f.full_name || f.space_name}</strong> · {f.kind.toLowerCase()} · {f.last_error}</div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
