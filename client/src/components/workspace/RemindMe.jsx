/**
 * "Remind me about this": a private reminder on any record I can see. It
 * reaches me only, at the time I choose, and changes nothing on the record.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Icon, Modal } from '../ui.jsx';

const localValue = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; };

export default function RemindMe({ entityType, entityId, label = 'Remind me', className = 'btn btn-sm btn-ghost' }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState([]);
  const [when, setWhen] = useState(localValue(tomorrow9()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/workspace/reminders/personal', { entity_type: entityType, entity_id: entityId }).then((r) => setMine(r.reminders)).catch(() => setMine([]));
  useEffect(() => { if (entityId) load(); }, [entityType, entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/workspace/reminders/personal', { entity_type: entityType, entity_id: Number(entityId), remind_at: new Date(when).toISOString(), note: note || null });
      toast.success('Reminder set. Only you will get it');
      setOpen(false);
      setNote('');
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Icon name="clock" size={13} /> {label}{mine.length ? ` (${mine.length})` : ''}
      </button>
      {open && (
        <Modal title="Remind me about this" onClose={() => setOpen(false)}
          footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !when} onClick={save}>Set my reminder</button></>}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>Private to you. It changes no date on the record and nobody else is told. You can change or remove it in <Link to="/settings?tab=account#my-reminders">My reminders</Link>.</p>
            {mine.length > 0 && (
              <div className="small">You already have {mine.length === 1 ? 'a reminder' : `${mine.length} reminders`} here: {mine.map((m) => new Date(m.remind_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(', ')}</div>
            )}
            <label className="field"><span className="field-label">Remind me on</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
            <label className="field"><span className="field-label">Note to yourself (optional)</span><input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to check" /></label>
          </div>
        </Modal>
      )}
    </>
  );
}
