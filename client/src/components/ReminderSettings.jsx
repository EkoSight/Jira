import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Field, Spinner } from './ui.jsx';
import { todayInIndia } from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

/**
 * In My account: when my pipeline reminders arrive. Leave stops them by itself;
 * a pause is for a short, dated spell with a reason.
 */
export default function ReminderSettings() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.myReminders().then((r) => {
      setData(r);
      setForm({
        digest_time: r.preferences.digest_time,
        digest_days: r.preferences.digest_days,
        cover_while_away: r.preferences.cover_while_away,
        paused_until: r.preferences.paused_until && r.preferences.paused_until >= todayInIndia() ? r.preferences.paused_until : '',
        pause_reason: r.preferences.pause_reason || '',
      });
    }).catch(() => setData(false));
  }, []);

  if (data === false) return null;
  if (!data || !form) return <div className="card card-pad"><Spinner label="Loading your reminders" /></div>;

  const toggleDay = (day) => setForm((f) => ({
    ...f,
    digest_days: f.digest_days.includes(day) ? f.digest_days.filter((d) => d !== day) : [...f.digest_days, day].sort(),
  }));

  const save = async () => {
    if (!form.digest_days.length) return toast.error('Pick at least one day');
    if (form.paused_until && form.pause_reason.trim().length < 3) return toast.error('Say why reminders are paused');
    setSaving(true);
    try {
      const r = await api.setMyReminders({
        digest_time: form.digest_time,
        digest_days: form.digest_days,
        cover_while_away: form.cover_while_away,
        paused_until: form.paused_until || null,
        pause_reason: form.paused_until ? form.pause_reason.trim() : null,
      });
      setData((d) => ({ ...d, preferences: r.preferences }));
      toast.success(r.preferences.paused_until
        ? `Pipeline reminders paused until ${formatDate(r.preferences.paused_until)}`
        : `Pipeline reminders at ${r.preferences.digest_time}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  const maxPause = new Date(Date.now() + data.defaults.max_pause_days * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="card">
      <div className="card-head"><h2>Pipeline reminders</h2></div>
      <div className="card-pad stack">
        <div className="small muted">
          One digest a day at most, on the days you pick, with what needs you. It is not sent while you are on leave,
          and an unchanged one is not repeated for {data.defaults.repeat_same_days} days.
          {data.preferences.is_default ? ' You are on the organization’s default.' : ''}
        </div>
        <div className="grid-2">
          <Field label="Time (India)">
            <input className="input" type="time" value={form.digest_time}
              onChange={(e) => setForm({ ...form, digest_time: e.target.value })} />
          </Field>
          <Field label="Days">
            <div className="row wrap" style={{ gap: 4 }}>
              {DAYS.map(([day, label]) => (
                <button key={day} type="button" className={`kind-chip${form.digest_days.includes(day) ? ' is-active' : ''}`}
                  aria-pressed={form.digest_days.includes(day)} onClick={() => toggleDay(day)}>
                  {label}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <label className="check small">
          <input type="checkbox" checked={form.cover_while_away}
            onChange={(e) => setForm({ ...form, cover_while_away: e.target.checked })} />
          While I am on leave, send next actions that fall due before I am back to each deal’s escalation point
        </label>
        <div className="grid-2">
          <Field label="Pause until" hint={`A short break — at most ${data.defaults.max_pause_days} days. For leave, book the leave instead.`}>
            <input className="input" type="date" min={todayInIndia()} max={maxPause} value={form.paused_until}
              onChange={(e) => setForm({ ...form, paused_until: e.target.value })} />
          </Field>
          {form.paused_until && (
            <Field label="Why *">
              <input className="input" value={form.pause_reason} onChange={(e) => setForm({ ...form, pause_reason: e.target.value })}
                placeholder="Offsite planning days" />
            </Field>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          {form.paused_until && (
            <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, paused_until: '', pause_reason: '' })}>Remove the pause</button>
          )}
        </div>
        {data.recent.length > 0 && (
          <div className="stack-sm">
            <div className="stat-label">Lately</div>
            {data.recent.slice(0, 5).map((r) => (
              <div key={`${r.created_at}-${r.kind}`} className="small">
                <span className="muted tnum">{formatDate(r.created_at, { withTime: true })}</span>{' '}
                {r.kind === 'COVER' ? `Covering for ${r.covering_for_name}: ` : ''}{r.title || `${r.signal_count} item${r.signal_count === 1 ? '' : 's'}`}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
