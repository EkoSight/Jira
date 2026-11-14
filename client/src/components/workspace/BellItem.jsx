/**
 * A workspace reminder in the bell: what to do and why you got it, the
 * record and its date, and three actions: Open (access re-checked when
 * pressed), Snooze (only your bell changes), Manage my reminder.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, Icon } from '../ui.jsx';

const at9 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d; };

export default function BellItem({ n, onChanged, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [snoozing, setSnoozing] = useState(false);
  const open = async () => {
    try {
      const r = await api.get(`/notifications/${n.id}/open`);
      if (!r.available || !r.url) { toast.error('This item is not available to you'); return; }
      onClose();
      navigate(r.url);
    } catch (err) { toast.error(err); }
  };
  const snooze = async (until) => {
    try {
      await api.post(`/notifications/${n.id}/snooze`, { until: until.toISOString() });
      toast.success(`Snoozed until ${until.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Only your bell changed`);
      setSnoozing(false);
      onChanged();
    } catch (err) { toast.error(err); }
  };
  if (n.available === false) {
    return (
      <div className="activity-line ws-bell" style={{ borderBottom: '1px solid var(--border)', padding: '9px 0' }}>
        <Icon name="bell" />
        <div className="grow small muted">This item is not available to you</div>
      </div>
    );
  }
  return (
    <div className={`activity-line ws-bell${n.resolved_at || n.cancelled_at ? ' ws-bell-done' : ''}`} style={{ borderBottom: '1px solid var(--border)', padding: '9px 0' }}>
      <Icon name="clock" />
      <div className="grow stack-sm" style={{ gap: 4 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <strong>{n.title}</strong>
          {!n.is_read && !n.resolved_at && <Badge tone="brand">New</Badge>}
          {n.resolved_at && <Badge tone="good">Resolved</Badge>}
          {n.cancelled_at && <Badge>No longer applies</Badge>}
        </div>
        {n.body && <div className="small muted" style={{ whiteSpace: 'pre-line' }}>{n.body}</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={open}>Open</button>
          {!n.resolved_at && !n.cancelled_at && <button type="button" className="btn btn-sm btn-ghost" aria-expanded={snoozing} onClick={() => setSnoozing((s) => !s)}>Snooze</button>}
          <Link className="btn btn-sm btn-ghost" to="/settings?tab=account#my-reminders" onClick={onClose}>Manage my reminder</Link>
        </div>
        {snoozing && (
          <div className="row wrap" role="group" aria-label="Snooze until" style={{ gap: 6 }}>
            <span className="small muted">Only your bell changes; the record and its dates do not.</span>
            <button type="button" className="btn btn-sm" onClick={() => snooze(new Date(Date.now() + 3_600_000))}>1 hour</button>
            <button type="button" className="btn btn-sm" onClick={() => snooze(at9(1))}>Tomorrow 09:00</button>
            <button type="button" className="btn btn-sm" onClick={() => snooze(at9(3))}>In 3 days</button>
          </div>
        )}
      </div>
      <span className="small muted">{new Date(n.created_at).toLocaleDateString()}</span>
    </div>
  );
}
