import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, Field, Modal, Spinner } from '../ui.jsx';
import { CATEGORY, CHOOSABLE } from '../../lib/sales.js';

const LIFECYCLE = {
  NEW: 'New — not called yet', CONTACTED: 'Being tried', QUALIFYING: 'Interested, finding out more', QUALIFIED: 'Ready to buy',
  NURTURE: 'Keep warm, not now', WON: 'Won — the lead is closed', DISQUALIFIED: 'Lost — the lead is closed',
};
const OUTCOME = { NONE: 'No call (a starting status)', NOT_CONNECTED: 'Called, did not connect', CONNECTED: 'Spoke to them' };
const TYPES = { TEXT: 'Short text', LONG_TEXT: 'Long text', SELECT: 'One choice', MULTI_SELECT: 'Several choices', NUMBER: 'Number', DATE: 'Date', URL: 'Web address' };

// ---------------------------------------------------------------- calling statuses and lost reasons

function StatusDialog({ status, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    label: status?.label || '', lifecycle: status?.lifecycle || 'QUALIFYING', outcome: status?.outcome || 'CONNECTED',
    retry_after_minutes: status?.retry_after_minutes ?? '', max_attempts: status?.max_attempts ?? '', needs_reason: status?.needs_reason || false,
    implies_category: status?.implies_category || '', color: status?.color || '#0ea5e9',
  }));
  const save = async () => {
    const body = { ...f, retry_after_minutes: f.retry_after_minutes === '' ? null : Number(f.retry_after_minutes), max_attempts: f.max_attempts === '' ? null : Number(f.max_attempts), implies_category: f.implies_category || null };
    try {
      if (status) await api.sales.patch(`/call-statuses/${status.id}`, body); else await api.sales.post('/call-statuses', body);
      toast.success('Saved'); onSaved(); onClose();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={status ? `Edit “${status.label}”` : 'New calling status'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={f.label.trim().length < 2} onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Name, as the team says it *"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Switched off" /></Field>
        <div className="grid-2">
          <Field label="What happened on the call"><select className="select" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{Object.entries(OUTCOME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Where it leaves the lead"><select className="select" value={f.lifecycle} onChange={(e) => setF({ ...f, lifecycle: e.target.value })}>{Object.entries(LIFECYCLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Try again after (minutes)" hint="Blank: no automatic retry"><input className="input" type="number" min="5" value={f.retry_after_minutes} onChange={(e) => setF({ ...f, retry_after_minutes: e.target.value })} /></Field>
          <Field label="Stop retrying after (attempts)" hint="Then it asks the caller to close it or book a callback"><input className="input" type="number" min="1" value={f.max_attempts} onChange={(e) => setF({ ...f, max_attempts: e.target.value })} /></Field>
          <Field label="Also says who they are" hint="Sets the category of a lead nobody has classified">
            <select className="select" value={f.implies_category} onChange={(e) => setF({ ...f, implies_category: e.target.value })}><option value="">No</option>{CHOOSABLE.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}</select>
          </Field>
          <Field label="Colour"><input className="input" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
        </div>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.needs_reason} onChange={(e) => setF({ ...f, needs_reason: e.target.checked })} /> Ask why (a lost reason) when it is chosen</label>
      </div>
    </Modal>
  );
}

export function CallingSettings({ meta, onSaved }) {
  const toast = useToast();
  const [statuses, setStatuses] = useState(null);
  const [editing, setEditing] = useState(null);
  const [reasons, setReasons] = useState((meta.settings.calling?.lostReasons || []).join('\n'));
  const [newFirst, setNewFirst] = useState(meta.settings.calling?.newLeadsFirst !== false);
  const load = useCallback(() => api.sales.get('/call-statuses').then((r) => setStatuses(r.statuses)).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  const move = async (i, d) => {
    const ids = statuses.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { const r = await api.sales.post('/call-statuses/order', { ids }); setStatuses(r.statuses); onSaved(); } catch (err) { toast.error(err); }
  };
  const flip = async (s) => { try { await api.sales.patch(`/call-statuses/${s.id}`, { is_active: !s.is_active }); load(); onSaved(); } catch (err) { toast.error(err); } };
  const saveCalling = async () => {
    try {
      await api.sales.put('/settings', { calling: { lostReasons: reasons.split('\n').map((r) => r.trim()).filter(Boolean), newLeadsFirst: newFirst } });
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err); }
  };
  if (!statuses) return <Spinner />;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Calling statuses</h3><button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({})}>New status</button></div>
        <div className="card-pad stack-sm">
          <p className="small muted">What a caller chooses after each call. Each status says what happened on the call and where that leaves the lead; the names are your team’s own (these started as TeleCRM’s). A status in use can be retired but not deleted, so old leads keep theirs.</p>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Status</th><th>On the call</th><th>Leaves the lead</th><th>Retry</th><th /></tr></thead>
              <tbody>{statuses.map((s, i) => (
                <tr key={s.id} className={s.is_active ? '' : 'muted'}>
                  <td><span className="call-status" style={{ '--status-color': s.color || 'var(--ink-muted)' }}><span className="call-status-dot" />{s.label}</span>{!s.is_active && <> <Badge>retired</Badge></>}{s.needs_reason && <div className="small muted">asks why</div>}{s.implies_category && <div className="small muted">says: {CATEGORY[s.implies_category].label}</div>}</td>
                  <td className="small">{OUTCOME[s.outcome]}</td>
                  <td className="small">{LIFECYCLE[s.lifecycle]}</td>
                  <td className="small">{s.retry_after_minutes ? `after ${s.retry_after_minutes >= 120 ? `${Math.round(s.retry_after_minutes / 60)} h` : `${s.retry_after_minutes} min`}${s.max_attempts ? `, up to ${s.max_attempts} tries` : ''}` : '—'}</td>
                  <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={i === 0} aria-label={`Move ${s.label} up`} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={i === statuses.length - 1} aria-label={`Move ${s.label} down`} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(s)}>Edit</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => flip(s)}>{s.is_active ? 'Retire' : 'Bring back'}</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="card card-pad stack">
        <h3>Lost reasons and the call list</h3>
        <Field label="Reasons offered when a lead is lost" hint="One per line. A caller can also type their own."><textarea className="textarea" rows={7} value={reasons} onChange={(e) => setReasons(e.target.value)} /></Field>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={newFirst} onChange={(e) => setNewFirst(e.target.checked)} /> In the call list, new leads come before retries (callbacks that are due always come first)</label>
        <div><button type="button" className="btn btn-primary btn-sm" onClick={saveCalling}>Save</button></div>
      </section>
      {editing && <StatusDialog status={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { load(); onSaved(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- lead fields

function FieldDialog({ field, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    label: field?.label || '', type: field?.type || 'SELECT', help: field?.help || '', show_in_list: field?.show_in_list || false, filterable: field?.filterable || false,
    options: (field?.options || []).map((o) => ({ ...o, aliases: (o.aliases || []).join('; ') })),
  }));
  const choices = f.type.includes('SELECT');
  const setOption = (i, patch) => setF({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const save = async () => {
    const body = {
      label: f.label, help: f.help || null, show_in_list: f.show_in_list, filterable: f.filterable,
      ...(field ? {} : { type: f.type }),
      ...(choices ? { options: f.options.filter((o) => o.label.trim()).map((o) => ({ value: o.value || undefined, label: o.label.trim(), aliases: o.aliases.split(';').map((a) => a.trim()).filter(Boolean), category: o.category || null })) } : {}),
    };
    try {
      if (field) await api.sales.patch(`/lead-fields/${field.id}`, body); else await api.sales.post('/lead-fields', body);
      toast.success('Saved'); onSaved(); onClose();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={field ? `Edit “${field.label}”` : 'New lead field'} size="lg" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={f.label.trim().length < 2} onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Question or name *"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Crops grown" /></Field>
          <Field label="Kind of answer" hint={field ? 'Fixed once leads hold answers' : undefined}><select className="select" value={f.type} disabled={Boolean(field)} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="Help text"><input className="input" value={f.help} onChange={(e) => setF({ ...f, help: e.target.value })} /></Field>
        <div className="row wrap" style={{ gap: 16 }}>
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.show_in_list} onChange={(e) => setF({ ...f, show_in_list: e.target.checked })} /> Show in the lead list and call card</label>
          {choices && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.filterable} onChange={(e) => setF({ ...f, filterable: e.target.checked })} /> Filter the lead list by it</label>}
        </div>
        {choices && (
          <div className="stack-sm">
            <h3 className="small">Choices</h3>
            <p className="small muted">Other wordings (Hindi, how a form or a file writes it) go in “also written as”, separated by semicolons, so imports and forms find the right choice. A choice can say who the lead is.</p>
            {f.options.map((o, i) => (
              <div key={i} className="grid-3" style={{ alignItems: 'end' }}>
                <Field label={i === 0 ? 'Choice' : undefined}><input className="input" value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} /></Field>
                <Field label={i === 0 ? 'Also written as' : undefined}><input className="input" value={o.aliases} onChange={(e) => setOption(i, { aliases: e.target.value })} /></Field>
                <Field label={i === 0 ? 'Means the lead is' : undefined}>
                  <select className="select" value={o.category || ''} onChange={(e) => setOption(i, { category: e.target.value || null })}><option value="">—</option>{CHOOSABLE.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}</select>
                </Field>
              </div>
            ))}
            <div><button type="button" className="btn btn-sm" onClick={() => setF({ ...f, options: [...f.options, { label: '', aliases: '', category: null }] })}>Add a choice</button></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function LeadFieldsSettings({ onSaved }) {
  const toast = useToast();
  const [fields, setFields] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api.sales.get('/lead-fields').then((r) => setFields(r.fields)).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  const flip = async (f) => { try { await api.sales.patch(`/lead-fields/${f.id}`, { is_active: !f.is_active }); load(); onSaved(); } catch (err) { toast.error(err); } };
  if (!fields) return <Spinner />;
  return (
    <section className="card">
      <div className="card-head"><h3>Lead fields</h3><button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({})}>New field</button></div>
      <div className="card-pad stack-sm">
        <p className="small muted">The questions your forms and callers ask, kept on each lead, shown on its page, used in imports, filters and reports. A choice still held by leads cannot be removed; rename it instead.</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Field</th><th>Kind</th><th>Choices</th><th /></tr></thead>
            <tbody>{fields.map((f) => (
              <tr key={f.id} className={f.is_active ? '' : 'muted'}>
                <td><strong>{f.label}</strong>{!f.is_active && <> <Badge>hidden</Badge></>}<div className="small muted">{[f.show_in_list && 'in the list', f.filterable && 'filterable'].filter(Boolean).join(' · ')}</div></td>
                <td className="small">{TYPES[f.type]}</td>
                <td className="small">{(f.options || []).map((o) => `${o.label}${o.category ? ` (→ ${CATEGORY[o.category].short})` : ''}`).join(', ') || '—'}</td>
                <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(f)}>Edit</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => flip(f)}>{f.is_active ? 'Hide' : 'Show'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      {editing && <FieldDialog field={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { load(); onSaved(); }} />}
    </section>
  );
}
