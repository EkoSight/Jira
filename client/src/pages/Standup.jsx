import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal } from '../components/ui.jsx';
import { LoadState } from '../components/LoadState.jsx';
import { useLoad } from '../lib/useLoad.js';
import { todayIn } from '../lib/attendance.js';

/**
 * The daily standup: a plan for the day, posted by 09:40.
 *
 * Everyone posts their own here or in Google Chat. On a shared login the
 * person is chosen by name every time — never assumed. Reviewers see who
 * posted on time, late, not at all, who was excused, and who could not be
 * reached, with the evidence of what was sent and when. Nothing here changes
 * attendance, leave, pay or black marks.
 */
export default function Standup() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    ['mine', 'My standup'],
    ...(can('standup.review') || can('standup.manage') ? [['review', 'Review']] : []),
    ...(can('standup.manage') ? [['people', 'People'], ['setup', 'Set-up']] : []),
  ];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'mine';
  const setTab = (key) => setParams(key === 'mine' ? {} : { tab: key }, { replace: true });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <h1>Daily standup</h1>
        <div className="small muted">Your plan for the day: three to five items, each tied to a TaskFlow task, with what will exist when it is done and by when.</div>
      </div>
      {tabs.length > 1 && (
        <div className="tabs tabs-scroll">
          {tabs.map(([key, label]) => (
            <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'mine' && <MyStandup />}
      {tab === 'review' && <ReviewTab initialDate={params.get('date')} />}
      {tab === 'people' && <PeopleTab />}
      {tab === 'setup' && <SetupTab />}
    </div>
  );
}

// ---------------------------------------------------------------- my standup

const blankItem = () => ({ task: '', action: '', target: '', done_by: '' });
const clockText = (s) => (s === null || s === undefined ? '' : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`);
const timeOf = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '');

const QUALITY = {
  PENDING: { label: 'Not reviewed yet', tone: 'neutral' },
  OK: { label: 'Clear', tone: 'good' },
  NEEDS_CORRECTION: { label: 'Correction requested', tone: 'warning' },
  CORRECTED: { label: 'Corrected', tone: 'good' },
};

function MyStandup() {
  const toast = useToast();
  const loaded = useLoad(() => api.standupMe(), []);
  const { data } = loaded;
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState('');
  const [items, setItems] = useState([blankItem(), blankItem(), blankItem()]);
  const [blockers, setBlockers] = useState([]);
  const [findings, setFindings] = useState([]);
  const [saving, setSaving] = useState(false);
  const [tasks, setTasks] = useState([]);
  const loadedFor = useRef(null);

  useEffect(() => { api.myTasks().then((d) => setTasks(d.tasks || [])).catch(() => {}); }, []);
  const members = data?.members || [];
  const shared = members.length > 1;
  const member = shared ? members.find((m) => String(m.id) === String(memberId)) : members[0];
  const existing = member ? (data?.submissions || []).find((s) => s.member_id === member.id) : null;

  // editing an existing standup starts from what was posted
  useEffect(() => {
    if (!member || loadedFor.current === member.id) return;
    loadedFor.current = member.id;
    setRole(existing?.content?.role || member.role_title || '');
    if (existing) {
      setItems(existing.content.items.map((i) => ({ task: i.task, action: i.action, target: i.target, done_by: clockText(i.done_by) })));
      setBlockers((existing.content.blockers || []).map((b) => ({ text: b.text, owner: b.owner || '', needed_by: clockText(b.needed_by) })));
    } else {
      setItems([blankItem(), blankItem(), blankItem()]);
      setBlockers([]);
    }
  }, [member, existing]);

  // the reviewer's checks, as guidance while typing
  const body = { member_id: member?.id ?? null, role, items, blockers };
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!member || !items.some((i) => i.task || i.action || i.target)) { setFindings([]); return undefined; }
    const timer = setTimeout(() => { api.standupCheck(body).then((d) => setFindings(d.findings)).catch(() => {}); }, 600);
    return () => clearTimeout(timer);
  }, [bodyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loaded.status !== 'ready') return <LoadState load={loaded} label="Loading your standup" what="your standup" />;
  if (!data.enabled) return <EmptyState title="The daily standup is not switched on yet">An admin sets it up under Daily standup → Set-up.</EmptyState>;
  if (!members.length) return <EmptyState title="You are not on the standup list yet">Ask an admin to add you under Daily standup → People.</EmptyState>;

  const setItem = (i, key, value) => setItems((list) => list.map((item, n) => (n === i ? { ...item, [key]: value } : item)));
  const setBlocker = (i, key, value) => setBlockers((list) => list.map((b, n) => (n === i ? { ...b, [key]: value } : b)));
  const save = async () => {
    setSaving(true);
    try {
      const res = await api.standupSubmit(body);
      toast.success(res.version > 1 ? `Correction saved (version ${res.version})` : `Standup posted for ${res.member.full_name}`);
      loadedFor.current = null;
      loaded.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <div className="callout is-quiet small">
        <Icon name="clock" size={14} />
        <span>
          {data.working_day
            ? <>Reminder at <strong>{data.reminder_time}</strong> in the standup space; post by <strong>{data.effective_deadline_at ? timeOf(data.effective_deadline_at) : data.deadline}</strong>. You can also post in Google Chat.</>
            : <>No standup today ({String(data.not_working_reason || '').replace('WEEKLY_OFF', 'weekly off').replace('HOLIDAY: ', 'holiday — ')}).</>}
          {' '}{data.consequences}
        </span>
      </div>

      {shared && (
        <Field label="Whose standup is this?" hint="This login is shared, so choose the person each time. The standup carries their name, not the login’s.">
          <select className="select" value={memberId} onChange={(e) => { setMemberId(e.target.value); loadedFor.current = null; }}>
            <option value="">Choose a person…</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}{m.role_title ? ` — ${m.role_title}` : ''}</option>)}
          </select>
        </Field>
      )}

      {member && existing && (
        <div className="row wrap small" style={{ gap: 8 }}>
          <Badge tone={(QUALITY[existing.quality] || QUALITY.PENDING).tone}>{(QUALITY[existing.quality] || QUALITY.PENDING).label}</Badge>
          <span className="muted">
            First posted {timeOf(existing.first_submitted_at)}{existing.current_version > 1 ? ` · version ${existing.current_version}` : ''}
            {existing.timing ? ` · ${existing.timing === 'ON_TIME' ? 'on time' : 'late'}` : ''}
          </span>
        </div>
      )}
      {member && existing?.quality === 'NEEDS_CORRECTION' && existing.findings?.length > 0 && (
        <div className="callout small" style={{ borderLeftColor: 'var(--warning)', background: 'var(--warning-wash)' }}>
          <Icon name="alert" />
          <div className="grow">
            <strong>The reviewer asked for a few changes</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{existing.findings.map((f) => <li key={`${f.code}${f.item}`}>{f.message}</li>)}</ul>
          </div>
        </div>
      )}

      {member && (
        <section className="card card-pad stack">
          <div className="grid-2">
            <Field label="Name"><input className="input" value={member.full_name} disabled /></Field>
            <Field label="Role"><input className="input" value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Field executive" /></Field>
          </div>
          <datalist id="standup-tasks">
            {tasks.map((t) => <option key={t.id} value={t.ref}>{t.title}</option>)}
          </datalist>
          <div className="stack-sm">
            <div className="row-between"><h3>Today’s plan</h3><span className="small muted">{data.min_items}–{data.max_items} items</span></div>
            {items.map((item, i) => (
              <div key={i} className="standup-item">
                <span className="standup-num tnum">{i + 1}</span>
                <input className="input" list="standup-tasks" aria-label={`Item ${i + 1} TaskFlow task`} placeholder="Task ID or link" value={item.task} onChange={(e) => setItem(i, 'task', e.target.value)} />
                <input className="input" aria-label={`Item ${i + 1} action`} placeholder="What you will do" value={item.action} onChange={(e) => setItem(i, 'action', e.target.value)} />
                <input className="input" aria-label={`Item ${i + 1} target`} placeholder="What will exist when it is done" value={item.target} onChange={(e) => setItem(i, 'target', e.target.value)} />
                <input className="input" type="time" aria-label={`Item ${i + 1} done by`} value={item.done_by} onChange={(e) => setItem(i, 'done_by', e.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove item ${i + 1}`} disabled={items.length <= 1} onClick={() => setItems((l) => l.filter((_, n) => n !== i))}><Icon name="close" size={14} /></button>
              </div>
            ))}
            {items.length < data.max_items && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setItems((l) => [...l, blankItem()])}><Icon name="plus" size={14} /> Add an item</button>
            )}
          </div>
          <div className="stack-sm">
            <h3>Blockers</h3>
            {blockers.length === 0 && <div className="small muted">None. Add one if you need help from someone today.</div>}
            {blockers.map((b, i) => (
              <div key={i} className="standup-blocker">
                <input className="input" aria-label="Help needed" placeholder="What help you need" value={b.text} onChange={(e) => setBlocker(i, 'text', e.target.value)} />
                <input className="input" aria-label="Owner" placeholder="Who can help" value={b.owner} onChange={(e) => setBlocker(i, 'owner', e.target.value)} />
                <input className="input" type="time" aria-label="Needed by" value={b.needed_by} onChange={(e) => setBlocker(i, 'needed_by', e.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Remove blocker" onClick={() => setBlockers((l) => l.filter((_, n) => n !== i))}><Icon name="close" size={14} /></button>
              </div>
            ))}
            {blockers.length < 3 && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setBlockers((l) => [...l, { text: '', owner: '', needed_by: '' }])}><Icon name="plus" size={14} /> Add a blocker</button>
            )}
          </div>
          {findings.length > 0 && (
            <div className="callout is-quiet small">
              <Icon name="alert" />
              <div className="grow">
                <strong>Before you post — the reviewer will look for:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{findings.map((f) => <li key={`${f.code}${f.item}`}>{f.message}</li>)}</ul>
                <div className="muted" style={{ marginTop: 4 }}>You can post anyway. Numbers you write are your own plan — nobody sets them for you.</div>
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !data.working_day}>
              {saving ? 'Posting…' : existing ? 'Save correction' : 'Post standup'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- review

const STATUS = {
  ON_TIME: { label: 'On time', tone: 'good' },
  LATE: { label: 'Late', tone: 'warning' },
  MISSING: { label: 'Not seen', tone: 'serious' },
  EXEMPT: { label: 'Exempt', tone: 'neutral' },
  INACCESSIBLE: { label: 'Could not be reached', tone: 'neutral' },
};
const REASON = {
  LEAVE: 'on approved leave', LEAVE_MORNING: 'on leave this morning', LEAVE_PENDING: 'leave request pending',
  WEEKLY_OFF: 'weekly off', NOT_YET_JOINED: 'not joined yet', SUBMITTED_AFTER_REVIEW: 'arrived after the review',
  REMINDER_NOT_DELIVERED: 'the reminder was not delivered', REMINDER_NOT_SENT: 'no reminder went out',
  FORMER_STAFF: 'former staff', IDENTITY_NOT_VERIFIED: 'Chat identity not verified', NOT_TRACKED: 'super admin — not expected',
  UNKNOWN_SENDER: 'Chat account not on the list', SHARED_ACCOUNT_NAME_NOT_MATCHED: 'shared account; name not matched',
  NAME_DOES_NOT_MATCH_ACCOUNT: 'name does not match the account', EXTERNAL_ACCOUNT_NOT_MAPPED: 'outside account not mapped',
};
const reasonWords = (r) => (r ? REASON[r] || String(r).replace(/^HOLIDAY: /, 'holiday — ') : '');

function ReviewTab({ initialDate }) {
  const { can } = useAuth();
  const [date, setDate] = useState(initialDate || todayIn());
  const days = useLoad(() => api.standupDays(), []);
  const board = useLoad(() => api.standupDay(date), [date], { accept: (d) => d?.date === date });
  const [resolving, setResolving] = useState(null);
  const [attributing, setAttributing] = useState(null);
  const b = board.data;
  const counts = useMemo(() => {
    const out = { ON_TIME: 0, LATE: 0, MISSING: 0, EXEMPT: 0, INACCESSIBLE: 0 };
    for (const r of b?.reviews || []) out[r.status] += 1;
    return out;
  }, [b]);

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
        {days.data?.days?.slice(0, 7).map((d) => (
          <button key={d.work_date} type="button" className={`kind-chip${d.work_date === date ? ' is-active' : ''}`} onClick={() => setDate(d.work_date)}>
            {d.work_date.slice(5)}{d.status === 'SKIPPED' ? ' · off' : d.missing ? ` · ${d.missing} not seen` : ''}
          </button>
        ))}
      </div>
      {board.status !== 'ready' ? <LoadState load={board} label="Loading the review" what="the review" /> : (
        <>
          <div className="small muted">{b.consequences} A missing or vague standup is not proof of anything about anyone’s work.</div>
          {!b.day ? <EmptyState title="No standup on this day">It had not started yet, or the standup was not switched on.</EmptyState> : (
            <>
              <section className="card card-pad stack-sm">
                <h3>What was sent, and when</h3>
                {b.day.status === 'SKIPPED' ? <div className="small">Skipped: {reasonWords(b.day.skipped_reason)}.</div> : (
                  <div className="small stack-sm">
                    <div>Reminder due {timeOf(b.day.reminder_due_at)} · {b.day.reminder_sent_at ? <>delivered <strong>{timeOf(b.day.reminder_sent_at)}</strong></> : <strong>not delivered</strong>}
                      {' '}· deadline {timeOf(b.day.deadline_at)}{b.day.effective_deadline_at && b.day.effective_deadline_at !== b.day.deadline_at ? <> → <strong>{timeOf(b.day.effective_deadline_at)}</strong> (the reminder’s full window)</> : ''}
                      {' '}· {b.day.reviewed_at ? `reviewed ${timeOf(b.day.reviewed_at)}` : 'not reviewed yet'}{b.day.escalated_at ? ` · follow-up ${timeOf(b.day.escalated_at)}` : ''}</div>
                    {(b.day.notes || []).map((n) => <div key={n.code} className="muted">• {n.text}</div>)}
                  </div>
                )}
                <details className="small">
                  <summary>{b.deliveries.length} Chat message{b.deliveries.length === 1 ? '' : 's'} on record</summary>
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>What</th><th>Status</th><th>Tries</th><th>Sent</th><th>Google message</th><th>Error</th></tr></thead>
                      <tbody>
                        {b.deliveries.map((d) => (
                          <tr key={d.dedupe_key}>
                            <td>{d.kind.replace('STANDUP_', '').toLowerCase()}</td>
                            <td><Badge tone={d.status === 'SENT' ? 'good' : d.status === 'FAILED' ? 'serious' : 'warning'}>{d.status.toLowerCase()}</Badge></td>
                            <td className="tnum">{d.attempts}</td>
                            <td className="tnum">{timeOf(d.sent_at)}</td>
                            <td className="small muted">{d.message_name || '—'}</td>
                            <td className="small">{d.last_error || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </section>

              <div className="row wrap" style={{ gap: 6 }}>
                {Object.entries(STATUS).map(([k, v]) => <Badge key={k} tone={counts[k] ? v.tone : 'neutral'}>{v.label}: {counts[k]}</Badge>)}
              </div>

              <div className="card table-wrap">
                <table className="data">
                  <thead><tr><th>Person</th><th>Status</th><th>First posted</th><th>Plan</th><th>Follow-up</th></tr></thead>
                  <tbody>
                    {b.reviews.length === 0 && <tr><td colSpan={5} className="small muted">Not reviewed yet.</td></tr>}
                    {b.reviews.map((r) => {
                      const s = b.submissions.find((x) => x.member_id === r.member_id);
                      const st = STATUS[r.status];
                      return (
                        <tr key={r.id}>
                          <td>{r.full_name}{r.role_title ? <div className="small muted">{r.role_title}</div> : null}</td>
                          <td><Badge tone={st.tone}>{st.label}</Badge>{r.reason && <div className="small muted">{reasonWords(r.reason)}</div>}</td>
                          <td className="tnum">{s ? timeOf(s.first_submitted_at) : '—'}{s?.current_version > 1 && <div className="small muted">{s.current_version} versions</div>}</td>
                          <td>
                            {s ? <Badge tone={(QUALITY[s.quality] || QUALITY.PENDING).tone}>{(QUALITY[s.quality] || QUALITY.PENDING).label}</Badge> : '—'}
                            {s && (
                              <details className="small">
                                <summary>Show</summary>
                                {s.versions.map((v) => (
                                  <div key={v.version} className="standup-version">
                                    <div className="muted">Version {v.version} · {timeOf(v.received_at)} · {v.source === 'APP' ? `TaskFlow${v.submitted_by ? ` (${v.submitted_by})` : ''}` : v.source === 'CHAT_DM' ? 'private message' : 'standup space'}</div>
                                    <ol style={{ margin: '2px 0', paddingLeft: 18 }}>
                                      {v.content.items.map((i, n) => <li key={n}>{i.task} — {i.action} → {i.target} · {clockText(i.done_by) || 'no time'}</li>)}
                                    </ol>
                                    {(v.content.blockers || []).map((x, n) => <div key={n}>Blocker: {x.text} · {x.owner || 'no owner'} · {clockText(x.needed_by) || 'no time'}</div>)}
                                  </div>
                                ))}
                                {s.findings?.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{s.findings.map((f) => <li key={`${f.code}${f.item}`}>{f.message}</li>)}</ul>}
                              </details>
                            )}
                          </td>
                          <td className="small">
                            {r.resolution ? <>{r.resolution.toLowerCase().replace('_', ' ')}{r.resolution_note ? ` — ${r.resolution_note}` : ''}<div className="muted">{r.resolved_by_name}</div></>
                              : ['MISSING', 'INACCESSIBLE', 'LATE'].includes(r.status) && <button type="button" className="btn btn-sm" onClick={() => setResolving(r)}>Follow up</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {(b.unmatched.length > 0 || b.excluded.length > 0) && (
                <section className="card card-pad stack-sm">
                  <h3>Held for a person</h3>
                  {b.unmatched.map((u) => (
                    <div key={u.id} className="row wrap small" style={{ gap: 8 }}>
                      <Badge tone={u.resolved_at ? 'neutral' : 'warning'}>{u.resolved_at ? 'resolved' : 'not counted'}</Badge>
                      <span className="grow">“{u.named_person || 'no name'}” from {u.sender_email || u.sender_chat || 'an unknown account'} at {timeOf(u.received_at)} — {reasonWords(u.reason)}</span>
                      {!u.resolved_at && can('standup.manage') && <button type="button" className="btn btn-sm" onClick={() => setAttributing(u)}>Decide</button>}
                    </div>
                  ))}
                  {b.excluded.map((e) => (
                    <div key={e.id} className="small muted">{e.full_name} — not included: {reasonWords(e.reason)}</div>
                  ))}
                </section>
              )}
            </>
          )}
        </>
      )}
      {resolving && <ResolveDialog review={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); board.reload(); }} />}
      {attributing && <AttributeDialog held={attributing} onClose={() => setAttributing(null)} onDone={() => { setAttributing(null); board.reload(); }} />}
    </div>
  );
}

function ResolveDialog({ review, onClose, onDone }) {
  const toast = useToast();
  const [resolution, setResolution] = useState('FOLLOWED_UP');
  const [note, setNote] = useState('');
  const save = async () => {
    try { await api.standupResolve(review.id, { resolution, note }); toast.success('Recorded'); onDone(); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={`Follow up — ${review.full_name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="What happened">
          <select className="select" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <option value="FOLLOWED_UP">Spoke with them</option>
            <option value="EXCUSED">Excused — there was a good reason</option>
            <option value="IDENTITY_FIXED">Identity or access fixed</option>
            <option value="NO_ACTION">No action needed</option>
          </select>
        </Field>
        <Field label="Note (kept with the review)"><input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="small muted">This records a follow-up. It does not change attendance, leave, pay or black marks.</div>
      </div>
    </Modal>
  );
}

function AttributeDialog({ held, onClose, onDone }) {
  const toast = useToast();
  const members = useLoad(() => api.standupMembers(), []);
  const [memberId, setMemberId] = useState('');
  const save = async (value) => {
    try { await api.standupAttribute(held.id, { member_id: value }); toast.success(value ? 'Counted for them' : 'Dismissed'); onDone(); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Who wrote this standup?" onClose={onClose} footer={<><button type="button" className="btn" onClick={() => save(null)}>Dismiss — not a standup</button><button type="button" className="btn btn-primary" disabled={!memberId} onClick={() => save(Number(memberId))}>Count it for them</button></>}>
      <div className="stack">
        <pre className="small standup-raw">{held.raw_text}</pre>
        <Field label="Person" hint="Only when you know who wrote it. Their Chat account is not linked by this — verify it under People.">
          <select className="select" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Choose…</option>
            {(members.data?.members || []).filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- people

const IDENTITY = { VERIFIED: { label: 'Verified', tone: 'good' }, UNVERIFIED: { label: 'Not verified', tone: 'warning' }, REJECTED: { label: 'Rejected', tone: 'serious' } };

function PeopleTab() {
  const toast = useToast();
  const loaded = useLoad(() => api.standupMembers(), []);
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState(null);
  const enrol = async () => {
    try {
      const res = await api.standupEnrolActive();
      toast.success(`${res.added} added${res.waiting_for_verification.length ? ` · ${res.waiting_for_verification.length} need their identity verified` : ''}`);
      loaded.reload();
    } catch (err) { toast.error(err); }
  };
  const setActive = async (m, active) => {
    try { await api.standupUpdateMember(m.id, { active }); loaded.reload(); } catch (err) { toast.error(err); }
  };
  if (loaded.status !== 'ready') return <LoadState load={loaded} label="Loading the standup list" what="the standup list" />;
  const members = loaded.data.members;
  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div className="small muted">Only active people with a verified identity are expected each day. Former staff and anyone whose Chat account is not verified are left out until resolved.</div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={enrol}>Add everyone active</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a person</button>
        </div>
      </div>
      <div className="card table-wrap">
        <table className="data">
          <thead><tr><th>Person</th><th>Posts as</th><th>Chat identity</th><th /></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={4} className="small muted">Nobody yet.</td></tr>}
            {members.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'att-off'}>
                <td>{m.full_name}<div className="small muted">{m.role_title || ''}{!m.active ? ' · left the standup' : ''}{m.user_active === false ? ' · account deactivated' : ''}</div></td>
                <td className="small">{m.user_id ? `${m.user_email}` : m.shared_account_id ? `shared login: ${m.shared_account_email}` : 'Chat only'}</td>
                <td className="small">
                  <Badge tone={IDENTITY[m.identity_status].tone}>{IDENTITY[m.identity_status].label}</Badge>
                  <div className="muted">{m.chat_email || m.user_email || ''}{m.chat_user_name || m.linked_chat_user ? ` · ${m.chat_user_name || m.linked_chat_user}` : ''}</div>
                  {m.identity_note && <div className="muted">“{m.identity_note}” — {m.verified_by_name}</div>}
                </td>
                <td className="att-row-actions">
                  {m.identity_status !== 'VERIFIED' && m.active && <button type="button" className="btn btn-sm" onClick={() => setVerifying(m)}>Verify</button>}
                  {m.active ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActive(m, false)}>Remove</button>
                    : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActive(m, true)}>Restore</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddMemberDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); loaded.reload(); }} />}
      {verifying && <VerifyDialog member={verifying} onClose={() => setVerifying(null)} onDone={() => { setVerifying(null); loaded.reload(); }} />}
    </div>
  );
}

function AddMemberDialog({ onClose, onDone }) {
  const toast = useToast();
  const { users } = useRefData();
  const [kind, setKind] = useState('own');
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const active = (users || []).filter((u) => u.is_active !== false);
  const save = async () => {
    const body = { full_name: name.trim(), role_title: role.trim() || null };
    if (kind === 'own') body.user_id = Number(userId);
    if (kind === 'shared') { body.shared_account_id = Number(userId); body.chat_email = email.trim() || null; }
    if (kind === 'chat') body.chat_email = email.trim();
    try { await api.standupAddMember(body); toast.success('Added'); onDone(); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Add a person to the standup" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={name.trim().length < 2 || (kind !== 'chat' && !userId) || (kind === 'chat' && !email.trim())}>Add</button></>}>
      <div className="stack">
        <div className="seg" role="radiogroup" aria-label="How they post">
          {[['own', 'Own login'], ['shared', 'Shared login'], ['chat', 'Chat only']].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        {kind !== 'chat' && (
          <Field label={kind === 'own' ? 'Their TaskFlow login' : 'The shared TaskFlow login'}>
            <select className="select" value={userId} onChange={(e) => { setUserId(e.target.value); if (kind === 'own') setName(active.find((u) => String(u.id) === e.target.value)?.full_name || ''); }}>
              <option value="">Choose…</option>
              {active.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
            </select>
          </Field>
        )}
        <Field label="Full name" hint={kind === 'shared' ? 'Each person on a shared login is added separately; their standup must carry this name exactly.' : null}>
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role"><input className="input" value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} /></Field>
        {kind !== 'own' && (
          <Field label="Google Chat email they post from" hint="An account outside the company is not counted until you verify it.">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function VerifyDialog({ member, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const decide = async (decision) => {
    try { await api.standupVerifyMember(member.id, { decision, note }); toast.success(decision === 'VERIFIED' ? 'Verified' : 'Rejected'); onDone(); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={`Verify ${member.full_name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={() => decide('REJECTED')} disabled={note.trim().length < 3}>Not theirs</button><button type="button" className="btn btn-primary" onClick={() => decide('VERIFIED')} disabled={note.trim().length < 3}>Verified</button></>}>
      <div className="stack">
        <div className="small">Chat account: <strong>{member.chat_email || member.user_email || '—'}</strong>{member.chat_user_name ? ` (${member.chat_user_name})` : ''}</div>
        <Field label="How you confirmed it" hint="Kept on record, e.g. “Confirmed in person on 12 Nov”.">
          <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- set-up

function SetupTab() {
  const toast = useToast();
  const { users } = useRefData();
  const loaded = useLoad(() => api.standupSettings(), []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loaded.data) {
      const s = loaded.data.settings;
      setForm({ space: s.spaceName || '', reminderTime: s.reminderTime, deadline: s.deadline, escalationTime: s.escalationTime, reviewCutoff: s.reviewCutoff, minItems: s.minItems, maxItems: s.maxItems, escalateTo: s.escalateTo || [], readSpaceAs: s.readSpaceAs || '' });
    }
  }, [loaded.data]);
  if (loaded.status !== 'ready' || !form) return <LoadState load={loaded} label="Loading the set-up" what="the standup set-up" />;
  const s = loaded.data.settings;
  const check = s.spaceCheck && s.spaceCheck.space === s.spaceName ? s.spaceCheck : null;
  const run = async (fn, done) => {
    setBusy(true);
    try { const res = await fn(); toast.success(done(res)); loaded.reload(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const save = () => run(() => api.standupSaveSettings({
    space: form.space || null, reminderTime: form.reminderTime, deadline: form.deadline, escalationTime: form.escalationTime,
    reviewCutoff: form.reviewCutoff, minItems: Number(form.minItems), maxItems: Number(form.maxItems),
    escalateTo: form.escalateTo.map(Number), readSpaceAs: form.readSpaceAs.trim() || null,
  }), () => 'Saved');
  const toggleReviewer = (id) => setForm((f) => ({ ...f, escalateTo: f.escalateTo.includes(id) ? f.escalateTo.filter((x) => x !== id) : [...f.escalateTo, id] }));

  return (
    <div className="stack">
      <section className="card card-pad stack">
        <div className="row-between wrap">
          <h3>Status</h3>
          <Badge tone={s.enabled ? 'good' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge>
        </div>
        <div className="small muted">
          The standup is posted only in a private company space that TaskFlow has been added to, and only after the space passes the check below.
          It does not replace the individual or department summaries. Consequences: none — it does not change attendance, leave, pay or black marks.
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || (!s.enabled && !check?.ok)} onClick={() => run(() => api.standupSaveSettings({ enabled: !s.enabled }), (r) => (r.settings.enabled ? 'Switched on' : 'Switched off'))}>
            {s.enabled ? 'Switch off' : 'Switch on'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy || !s.enabled} onClick={() => run(() => api.standupRun(), (r) => `Ran: ${r.status || 'nothing due yet'}`)}>Run the schedule now</button>
        </div>
      </section>

      <section className="card card-pad stack">
        <h3>Space</h3>
        <Field label="Google Chat space link or name" hint="Open the space in Google Chat and copy its link — or spaces/…. Add the TaskFlow app to the space first.">
          <input className="input" value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })} placeholder="https://chat.google.com/app/chat/…" />
        </Field>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" disabled={busy || !s.spaceName} onClick={() => run(() => api.standupCheckSpace(), (r) => (r.check.ok ? 'The space is private' : 'The space did not pass'))}>Check the space</button>
          {check && (
            <span className="small">
              <Badge tone={check.ok ? 'good' : 'serious'}>{check.ok ? 'Private company space' : 'Not ready'}</Badge>
              {' '}{check.display_name || s.spaceName} · checked {new Date(check.checked_at).toLocaleString('en-IN')}
            </span>
          )}
        </div>
        {check && !check.ok && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </section>

      <section className="card card-pad stack">
        <h3>Times (India time, company working days)</h3>
        <div className="grid-2">
          <Field label="Reminder"><input className="input" type="time" value={form.reminderTime} onChange={(e) => setForm({ ...form, reminderTime: e.target.value })} /></Field>
          <Field label="Deadline" hint="Counted from the reminder’s delivery if it arrives late"><input className="input" type="time" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></Field>
          <Field label="Private follow-up to reviewers"><input className="input" type="time" value={form.escalationTime} onChange={(e) => setForm({ ...form, escalationTime: e.target.value })} /></Field>
          <Field label="Review by, even without a reminder"><input className="input" type="time" value={form.reviewCutoff} onChange={(e) => setForm({ ...form, reviewCutoff: e.target.value })} /></Field>
          <Field label="Fewest items"><input className="input" type="number" min="1" max="10" value={form.minItems} onChange={(e) => setForm({ ...form, minItems: e.target.value })} /></Field>
          <Field label="Most items"><input className="input" type="number" min="1" max="10" value={form.maxItems} onChange={(e) => setForm({ ...form, maxItems: e.target.value })} /></Field>
        </div>
        <Field label="Who gets the private follow-up" hint="They need the “standup review” permission. Names stay in TaskFlow; Chat gets counts only.">
          <div className="row wrap" style={{ gap: 6 }}>
            {(users || []).filter((u) => u.is_active !== false && ['super_admin', 'admin', 'manager'].includes(u.role)).map((u) => (
              <button key={u.id} type="button" className={`kind-chip${form.escalateTo.includes(u.id) ? ' is-active' : ''}`} onClick={() => toggleReviewer(u.id)}>{u.full_name}</button>
            ))}
          </div>
        </Field>
        <Field label="Read standups posted in the space without a mention (optional)" hint="A member’s Workspace email. Needs an admin to grant the read-only chat.messages.readonly scope to TaskFlow’s service account. Leave empty to accept only mentions, private messages and the form.">
          <input className="input" type="email" value={form.readSpaceAs} onChange={(e) => setForm({ ...form, readSpaceAs: e.target.value })} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save</button></div>
      </section>
    </div>
  );
}
