import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, Field, Icon, Modal, Spinner } from './ui.jsx';
import { PRIVACY_NOTICE, WEEKDAYS, dayName, todayIn } from '../lib/attendance.js';

/**
 * Attendance and pay policy, kept visibly in three groups: what the company
 * confirmed, what the brief proposed (used for drafts; an admin must accept
 * it), and what has not been supplied yet (drafts run without it, nothing is
 * finalised until it is set).
 */
export default function AttendanceSettings() {
  const [section, setSection] = useState('policy');
  return (
    <div className="stack">
      <div className="seg">
        {[['policy', 'Policy'], ['holidays', 'Holidays'], ['people', 'Employee schedules'], ['access', 'Who sees whom']].map(([k, label]) => (
          <button key={k} type="button" className={section === k ? 'is-on' : ''} onClick={() => setSection(k)}>{label}</button>
        ))}
      </div>
      {section === 'policy' && <PolicySection />}
      {section === 'holidays' && <HolidaysSection />}
      {section === 'people' && <PeopleSection />}
      {section === 'access' && <AccessSection />}
    </div>
  );
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const setIn = (obj, path, value) => {
  const keys = path.split('.');
  const out = { ...obj };
  let cur = out;
  keys.slice(0, -1).forEach((k) => { cur[k] = { ...(cur[k] || {}) }; cur = cur[k]; });
  cur[keys.at(-1)] = value;
  return out;
};

function PolicySection() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.attendancePolicy().then((d) => { setData(d); setDraft(d.versions[0].config); }).catch(toast.error);
  }, [toast]);
  useEffect(load, [load]);

  if (!data || !draft) return <Spinner />;
  const current = data.versions[0];
  const locked = current.in_use_by_closed_payroll;
  const field = (path) => ({ value: get(draft, path) ?? '', onChange: (v) => setDraft((d) => setIn(d, path, v)) });

  const save = async () => {
    setSaving(true);
    try {
      if (locked) {
        if (!effectiveFrom) { toast.error('Choose the date the new version starts'); return; }
        await api.createPolicyVersion({ effective_from: effectiveFrom, config: draft });
        toast.success('New version saved. It needs accepting before payroll can use it.');
      } else {
        const res = await api.updatePolicy(current.id, draft);
        toast.success(res.acceptance_cleared ? 'Saved. It changed, so it needs accepting again.' : 'Saved');
      }
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <div>
            <h2>Policy in force</h2>
            <div className="small muted">
              Version {current.id}, from {current.effective_from === '2000-01-01' ? 'the start' : dayName(current.effective_from)}
              {current.accepted_at ? ` · accepted by ${current.accepted_by_name}` : ' · not yet accepted'}
            </div>
          </div>
          {!current.accepted_at && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => { try { await api.acceptPolicy(current.id); toast.success('Accepted'); load(); } catch (err) { toast.error(err); } }}
            >
              Accept this version, proposed defaults included
            </button>
          )}
        </div>
        <ul className="att-checklist">
          {current.setup.items.map((i) => (
            <li key={i.key} className={i.done ? 'is-done' : ''}>
              <Icon name={i.done ? 'check' : 'alert'} size={14} /> {i.label}
            </li>
          ))}
        </ul>
        {!draft.startDate && (
          <div className="callout is-quiet small">
            <Icon name="alert" />
            <span>Nothing is required of anyone until you set the date attendance starts. Before that, checking in is optional and no day is ever counted as an absence.</span>
          </div>
        )}
      </section>

      <PolicyGroup title="Confirmed by the company" note="From the brief. Change them here if the company changes them.">
        <TimeField label="Office starts" {...field('officeStart')} />
        <TimeField label="Office ends" {...field('officeEnd')} />
        <NumberField label="Arrival grace (minutes)" min={0} max={120} {...field('graceMinutes')} />
        <NumberField label="Paid leave days a month" min={0} max={10} step={0.5} {...field('leave.monthlyPaidDays')} />
        <NumberField label="Notice for planned leave (hours)" min={0} max={720} {...field('leave.noticeHours')} />
        <Field label="Working days">
          <div className="att-weekdays">
            {WEEKDAYS.map((name, i) => (
              <label key={name} className={`att-chip ${draft.workingDays.includes(i) ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={draft.workingDays.includes(i)}
                  onChange={(e) => setDraft((d) => ({ ...d, workingDays: e.target.checked ? [...d.workingDays, i].sort() : d.workingDays.filter((x) => x !== i) }))}
                />
                {name}
              </label>
            ))}
          </div>
        </Field>
      </PolicyGroup>

      <PolicyGroup title="Proposed — used for drafts, needs your acceptance" tone="warning" note="Interpretations the brief proposed. Accepting the version above accepts these.">
        <SelectField label="How grace works" {...field('graceMode')} options={[
          ['THRESHOLD', 'Within the window: the late minutes are credited. After it: no grace, late counts from office start'],
          ['FORGIVE_FIRST', 'The first minutes of the window are always forgiven, even when later'],
          ['NONE', 'No grace credit at all'],
        ]} />
        <SelectField label="Time before office hours" {...field('creditBeforeStart')} boolean options={[[false, 'Recorded but not banked'], [true, 'Banked as extra time']]} />
        <SelectField label="Time after office hours" {...field('extraRequiresReview')} boolean options={[[true, 'Offsets only once a reviewer counts it'], [false, 'Offsets automatically']]} />
        <SelectField label="Paid leave allowance" {...field('leave.allowanceMode')} options={[['POOLED', 'One pool for casual, sick and other'], ['SPLIT', 'Split equally between casual and sick']]} />
        <SelectField label="Allowance starts" {...field('leave.eligibility')} options={[['JOINED_BEFORE_MONTH', 'From the first full month after joining'], ['IMMEDIATE', 'From the joining month']]} />
      </PolicyGroup>

      <PolicyGroup title="Not supplied yet — needed before any month is finalised" tone="serious" note="Drafts run without these and say so.">
        <div className="stack-sm" style={{ gridColumn: '1 / -1' }}>
          <strong className="small">Lunch and rest breaks</strong>
          {draft.breaks.length === 0 && <div className="small muted">No break configured — none is deducted.</div>}
          {draft.breaks.map((b, i) => (
            <div key={i} className="row wrap" style={{ gap: 8 }}>
              <input className="input" style={{ width: 140 }} value={b.name} onChange={(e) => setDraft((d) => ({ ...d, breaks: d.breaks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
              <input className="input" type="time" style={{ width: 120 }} value={b.start} onChange={(e) => setDraft((d) => ({ ...d, breaks: d.breaks.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) }))} />
              <input className="input" type="time" style={{ width: 120 }} value={b.end} onChange={(e) => setDraft((d) => ({ ...d, breaks: d.breaks.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) }))} />
              <label className="check small"><input type="checkbox" checked={b.paid} onChange={(e) => setDraft((d) => ({ ...d, breaks: d.breaks.map((x, j) => (j === i ? { ...x, paid: e.target.checked } : x)) }))} /> Paid</label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft((d) => ({ ...d, breaks: d.breaks.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setDraft((d) => ({ ...d, breaks: [...d.breaks, { name: 'Lunch', start: '13:30', end: '14:00', paid: false }] }))}>Add a break</button>
            <label className="check small"><input type="checkbox" checked={draft.breaksConfirmed} onChange={(e) => setDraft((d) => ({ ...d, breaksConfirmed: e.target.checked }))} /> These breaks are confirmed (including “no breaks”)</label>
          </div>
        </div>
        <label className="check small" style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={Boolean(draft.payroll?.methodConfirmed)} onChange={(e) => setDraft((d) => setIn(d, 'payroll.methodConfirmed', e.target.checked))} />
          HR / payroll has confirmed the salary method: attendance-sensitive amount × unpaid time ÷ scheduled required time
        </label>
      </PolicyGroup>

      <PolicyGroup title="Running attendance" note="Operational settings.">
        <Field label="Attendance starts on" hint="Leave empty to keep it optional. No day before this is ever an absence.">
          <input className="input" type="date" value={draft.startDate || ''} onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value || null }))} />
        </Field>
        <SelectField label="Before someone checks in" {...field('enforcement')} options={[['REQUIRE', 'They cannot change tasks, goals or leads'], ['OFF', 'Nothing is blocked; attendance is only recorded']]} />
        <TimeField label="Missing check-out after (next day)" {...field('missingCheckoutCutoff')} />
        <TimeField label="Half day splits at" {...field('halfDaySplit')} />
        <NumberField label="Flag readings less accurate than (metres)" min={10} {...field('lowAccuracyMeters')} />
        <NumberField label="Wait for a location (seconds)" min={5} max={120} {...field('locationTimeoutSeconds')} />
        <NumberField label="Flag sessions longer than (hours)" min={4} max={24} {...field('maxSessionHours')} />
        <SelectField label="Map links on locations" {...field('mapLinks')} options={[['GOOGLE', 'Offer “Open in Google Maps” (sent only when clicked)'], ['NONE', 'Coordinates only']]} />
        <SelectField label="Employees see their own salary estimate" {...field('payroll.employeesSeeOwnEstimate')} boolean options={[[false, 'No'], [true, 'Yes']]} />
      </PolicyGroup>

      <div className="callout is-quiet small">
        <Icon name="alert" />
        <span>Shown to everyone at check-in: “{PRIVACY_NOTICE}”</span>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        {locked && (
          <Field label="New version starts on" hint="A closed payroll month used the current version, so changes start a new one.">
            <input className="input" type="date" value={effectiveFrom} min={todayIn()} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </Field>
        )}
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : locked ? 'Save as a new version' : 'Save policy'}</button>
        <button type="button" className="btn" onClick={() => setDraft(current.config)}>Discard changes</button>
      </div>
    </div>
  );
}

function PolicyGroup({ title, note, tone, children }) {
  return (
    <section className={`card card-pad att-policy-group ${tone ? `is-${tone}` : ''}`}>
      <div className="att-policy-head">
        <h3>{title}</h3>
        {note && <div className="small muted">{note}</div>}
      </div>
      <div className="att-policy-grid">{children}</div>
    </section>
  );
}

const TimeField = ({ label, value, onChange }) => (
  <Field label={label}><input className="input" type="time" value={value} onChange={(e) => onChange(e.target.value)} /></Field>
);
const NumberField = ({ label, value, onChange, ...rest }) => (
  <Field label={label}><input className="input" type="number" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} {...rest} /></Field>
);
const SelectField = ({ label, value, onChange, options, boolean }) => (
  <Field label={label}>
    <select className="select" value={String(value)} onChange={(e) => onChange(boolean ? e.target.value === 'true' : e.target.value)}>
      {options.map(([v, text]) => <option key={String(v)} value={String(v)}>{text}</option>)}
    </select>
  </Field>
);

function HolidaysSection() {
  const toast = useToast();
  const { departments } = useRefData();
  const [year, setYear] = useState(Number(todayIn().slice(0, 4)));
  const [items, setItems] = useState(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const load = useCallback(() => { api.holidays(year).then((d) => setItems(d.holidays)).catch(toast.error); }, [year, toast]);
  useEffect(load, [load]);
  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <h2>Paid holidays</h2>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => setYear(year - 1)}>{year - 1}</button>
          <strong>{year}</strong>
          <button type="button" className="btn btn-sm" onClick={() => setYear(year + 1)}>{year + 1}</button>
        </div>
      </div>
      <form
        className="row wrap"
        style={{ gap: 8, alignItems: 'flex-end' }}
        onSubmit={async (e) => {
          e.preventDefault();
          try { await api.addHoliday({ holiday_date: date, name, department_id: dept ? Number(dept) : null }); setName(''); load(); } catch (err) { toast.error(err); }
        }}
      >
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Diwali" /></Field>
        <Field label="For">
          <select className="select" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">Everyone</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <button type="submit" className="btn btn-primary">Add holiday</button>
      </form>
      {!items ? <Spinner /> : items.length === 0 ? <div className="small muted">No holidays in {year}.</div> : (
        <table className="data">
          <tbody>
            {items.map((h) => (
              <tr key={h.id}>
                <td className="nowrap">{dayName(h.holiday_date)}</td>
                <td>{h.name}</td>
                <td className="small muted">{h.department_name || 'Everyone'}</td>
                <td><ConfirmButton label="Remove" onConfirm={async () => { try { await api.removeHoliday(h.id); load(); } catch (err) { toast.error(err); } }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PeopleSection() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => { api.workProfiles().then((d) => setRows(d.profiles)).catch(toast.error); }, [toast]);
  useEffect(load, [load]);
  if (!rows) return <Spinner />;
  return (
    <section className="card">
      <div className="card-head"><h2>Employee schedules</h2></div>
      <div className="card-pad small muted" style={{ paddingTop: 0 }}>Joining dates are needed for payroll. Working days override the company default for one person.</div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Person</th><th>Joined</th><th>Working days</th><th>Mode</th><th>Reports to</th><th>Attendance</th><th /></tr></thead>
          <tbody>
            {rows.filter((r) => r.is_active).map((r) => (
              <tr key={r.user_id}>
                <td><div className="row" style={{ gap: 8 }}><Avatar name={r.full_name} color={r.avatar_color} size={24} /> {r.full_name}</div></td>
                <td>{r.joining_date ? dayName(r.joining_date) + ' ' + r.joining_date.slice(0, 4) : <Badge tone="warning">Missing</Badge>}</td>
                <td className="small">{r.working_days ? r.working_days.map((d) => WEEKDAYS[d]).join(' ') : <span className="muted">Company default</span>}</td>
                <td className="small">{r.work_mode.toLowerCase()}</td>
                <td className="small">{r.reporting_manager_name || <span className="muted">—</span>}</td>
                <td>{r.attendance_required ? <Badge tone="brand">Required</Badge> : <Badge>Not required</Badge>}</td>
                <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <ProfileDialog row={editing} people={rows} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function ProfileDialog({ row, people, onClose, onSaved }) {
  const toast = useToast();
  const [joining, setJoining] = useState(row.joining_date || '');
  const [exit, setExit] = useState(row.exit_date || '');
  const [days, setDays] = useState(row.working_days || null);
  const [mode, setMode] = useState(row.work_mode);
  const [required, setRequired] = useState(row.attendance_required);
  const [manager, setManager] = useState(row.reporting_manager_id || '');
  const save = async () => {
    try {
      await api.saveWorkProfile(row.user_id, {
        joining_date: joining || null, exit_date: exit || null, working_days: days, work_mode: mode,
        attendance_required: required, reporting_manager_id: manager ? Number(manager) : null,
      });
      toast.success('Saved');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal
      title={row.full_name}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Joining date"><input className="input" type="date" value={joining} onChange={(e) => setJoining(e.target.value)} /></Field>
          <Field label="Exit date"><input className="input" type="date" value={exit} onChange={(e) => setExit(e.target.value)} /></Field>
        </div>
        <Field label="Working days" hint={days ? 'Overrides the company default for this person' : 'Using the company default'}>
          <div className="att-weekdays">
            {WEEKDAYS.map((name, i) => (
              <label key={name} className={`att-chip ${(days || []).includes(i) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={(days || []).includes(i)} onChange={(e) => setDays((d) => { const cur = d || []; const next = e.target.checked ? [...cur, i].sort() : cur.filter((x) => x !== i); return next.length ? next : null; })} />
                {name}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid-2">
          <Field label="Work mode">
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
              {['OFFICE', 'REMOTE', 'FIELD', 'HYBRID'].map((m) => <option key={m} value={m}>{m[0] + m.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="Reports to" hint="Their manager can see and approve their attendance">
            <select className="select" value={manager} onChange={(e) => setManager(e.target.value)}>
              <option value="">—</option>
              {people.filter((p) => p.user_id !== row.user_id && p.is_active).map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
            </select>
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Must check in before working</label>
      </div>
    </Modal>
  );
}

function AccessSection() {
  const toast = useToast();
  const { departments, users } = useRefData();
  const [access, setAccess] = useState(null);
  const load = useCallback(() => { api.teamAccess().then((d) => setAccess(d.access)).catch(toast.error); }, [toast]);
  useEffect(load, [load]);
  if (!access) return <Spinner />;
  const managers = users.filter((u) => u.role === 'manager' && u.is_active !== false);
  const has = (m, d) => access.some((a) => a.manager_id === m && a.department_id === d);
  return (
    <section className="card card-pad stack">
      <div>
        <h2>Who sees whom</h2>
        <div className="small muted">
          Being a manager does not by itself show anyone’s attendance or location. Tick the departments each manager may see.
          They also see anyone who reports to them (Employee schedules). Admins see everyone.
        </div>
      </div>
      {managers.length === 0 ? <div className="small muted">No managers yet.</div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Manager</th>{departments.map((d) => <th key={d.id}>{d.name}</th>)}</tr></thead>
            <tbody>
              {managers.map((m) => (
                <tr key={m.id}>
                  <td><div className="row" style={{ gap: 8 }}><Avatar name={m.full_name} color={m.avatar_color} size={24} /> {m.full_name}</div></td>
                  {departments.map((d) => (
                    <td key={d.id}>
                      <input
                        type="checkbox"
                        aria-label={`${m.full_name} sees ${d.name}`}
                        checked={has(m.id, d.id)}
                        onChange={async (e) => {
                          const current = access.filter((a) => a.manager_id === m.id).map((a) => a.department_id);
                          const next = e.target.checked ? [...current, d.id] : current.filter((x) => x !== d.id);
                          // show the change at once; the reload puts it back if the server refused
                          setAccess((prev) => [
                            ...prev.filter((a) => a.manager_id !== m.id),
                            ...next.map((departmentId) => ({ manager_id: m.id, department_id: departmentId })),
                          ]);
                          try { await api.setTeamAccess(m.id, next); } catch (err) { toast.error(err); }
                          load();
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
