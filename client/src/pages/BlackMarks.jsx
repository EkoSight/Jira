import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { BarList } from '../components/charts.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { formatDate, monthKey, monthLabel } from '../lib/format.js';
import { CORRECTION_LABEL, CORRECTION_STATUS, SHIFT_LABEL, shortDate } from '../lib/holidays.js';

const TRIGGER_LABEL = {
  deadline_missed: 'Deadline missed',
  overdue_escalation: 'Still overdue',
  completed_late: 'Delivered late',
  task_reopened: 'Reopened',
  manual: 'Raised manually',
};

const SEVERITY_TONE = { ok: 'good', warning: 'warning', critical: 'critical' };

function ManualMarkDialog({ onClose, onSaved }) {
  const { users } = useRefData();
  const toast = useToast();
  const [form, setForm] = useState({ user_id: '', points: 1, reason: '' });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.user_id || form.reason.trim().length < 3) return toast.error('Pick a person and give a reason');
    setSaving(true);
    try {
      await api.createBlackMark({
        user_id: Number(form.user_id),
        points: Number(form.points),
        reason: form.reason.trim(),
      });
      toast.success('Black mark recorded');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Raise a black mark"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>Record</button>
        </>
      }
    >
      <div className="stack">
        <Field label="Team member">
          <select className="select" value={form.user_id} onChange={(e) => setForm((c) => ({ ...c, user_id: e.target.value }))}>
            <option value="">Select…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Points" hint="How heavily this counts at the monthly review">
          <input
            type="number"
            min="0"
            step="0.5"
            className="input"
            value={form.points}
            onChange={(e) => setForm((c) => ({ ...c, points: e.target.value }))}
          />
        </Field>
        <Field label="Reason">
          <textarea
            className="textarea"
            rows={3}
            value={form.reason}
            onChange={(e) => setForm((c) => ({ ...c, reason: e.target.value }))}
            placeholder="What happened?"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Why a deadline moved: "Sun 11 Oct weekly day off, Mon 12 Oct holiday (Diwali)". */
const shiftWords = (list) => (list || []).map((s) => `${shortDate(s.date)} ${SHIFT_LABEL[s.code] || s.code}${s.name ? ` (${s.name})` : ''}`).join(', ');

/**
 * Where a mark came from: the task and rule, the evidence kept when it was
 * recorded, and everything done to it since — waives, restores and holiday
 * corrections — with who and why.
 */
function MarkSourceDialog({ markId, onClose, onOpenTask }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  useEffect(() => { api.blackMarkHistory(markId).then(setData).catch(toast.error); }, [markId, toast]);
  const ev = data?.evidence;
  return (
    <Modal title="Where this mark came from" onClose={onClose} size="lg" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="hol-summary">
            <div className="row wrap" style={{ gap: 6 }}>
              {data.mark.status === 'waived' ? <Badge>Waived</Badge> : <Badge tone="critical">Active</Badge>}
              <strong>{data.mark.full_name}</strong>
              <span className="tnum">{Number(data.mark.points)} pt</span>
            </div>
            <div>{data.mark.reason}</div>
            <div className="small muted">Recorded {formatDate(data.mark.occurred_at, { withTime: true })} · {data.mark.source === 'manual' ? `raised by ${data.mark.created_by_name || 'someone'}` : 'by the automatic scan'}</div>
          </div>
          <dl className="bm-evidence small">
            {data.mark.task_ref && (
              <>
                <dt>Source event</dt>
                <dd>
                  <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto' }} onClick={() => onOpenTask(data.mark.task_id)}>
                    <span className="task-ref">{data.mark.task_ref}</span>
                  </button> {data.mark.task_title}
                </dd>
              </>
            )}
            <dt>Rule</dt>
            <dd>
              {ev?.rule ? `${ev.rule.name} — ${ev.rule.points} pt, ${ev.rule.grace_hours}h grace, as it stood when recorded` : data.mark.rule_name || (data.mark.source === 'manual' ? 'Raised manually' : '—')}
              {ev?.rule && data.mark.rule_points_now !== null && Number(data.mark.rule_points_now) !== Number(ev.rule.points) && (
                <span className="muted"> (now {Number(data.mark.rule_points_now)} pt)</span>
              )}
            </dd>
            {ev?.due && (
              <>
                <dt>Deadline</dt>
                <dd>{formatDate(ev.due, { withTime: true })}</dd>
                <dt>In force when recorded</dt>
                <dd>
                  {formatDate(ev.effective_due, { withTime: true })}
                  {ev.shifted_past?.length ? <span className="muted"> — moved past {shiftWords(ev.shifted_past)}</span> : <span className="muted"> — a working time for them</span>}
                </dd>
                <dt>Judged against</dt>
                <dd>Attendance policy version {ev.attendance_policy_id ?? '—'}: {ev.calendar}{ev.counting ? `; cycles count ${ev.counting}` : ''}</dd>
              </>
            )}
            {!ev && <><dt>Evidence</dt><dd className="muted">Recorded before evidence was kept with each mark.</dd></>}
            {ev?.recorded_by_correction && <><dt>Recorded by</dt><dd>Holiday correction #{ev.recorded_by_correction} (request #{ev.holiday_request_id}), reviewed by a person</dd></>}
          </dl>

          <section className="stack-sm">
            <h3>Corrections and decisions</h3>
            {data.corrections.length === 0 && data.audit.length === 0 && <div className="small muted">None.</div>}
            {data.corrections.map((c) => (
              <div key={`c${c.id}`} className="hol-row">
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Badge tone={CORRECTION_STATUS[c.status].tone}>{CORRECTION_STATUS[c.status].label}</Badge>
                    <strong>{CORRECTION_LABEL[c.kind]}</strong>
                    <span className="small muted">holiday request #{c.request_id}{c.holiday_name ? ` — ${c.holiday_name}` : ''}</span>
                  </div>
                  <div className="small">{c.summary}</div>
                  {c.decided_by_name && <div className="small muted">{CORRECTION_STATUS[c.status].label} by {c.decided_by_name} {formatDate(c.decided_at)}{c.decision_note ? ` — ${c.decision_note}` : ''}</div>}
                  {c.reversed_at && <div className="small muted">Reversed by {c.reversed_by_name} {formatDate(c.reversed_at)} — {c.reverse_reason}</div>}
                </div>
                <Link className="btn btn-sm btn-ghost" to="/settings?tab=attendance&section=holidays" onClick={onClose}>Open holidays</Link>
              </div>
            ))}
            {data.audit.length > 0 && (
              <ul className="small hol-audit">
                {data.audit.map((a) => (
                  <li key={`a${a.id}`}>
                    {formatDate(a.created_at, { withTime: true })} — {a.actor_name || 'TaskFlow'} {a.action.toLowerCase()} it{a.reason ? `: “${a.reason}”` : ''}
                    {a.action === 'RESTORED' && a.before?.waived_reason ? ` (it had been waived: “${a.before.waived_reason}”)` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

/** Appeals: your own, or (for someone who may waive marks) everyone's waiting for a decision. */
function Appeals({ onOpenSource }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = () => api.get('/blackmarks/appeals').then(setData).catch((err) => toast.error(err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  const decide = async (appeal, decision) => {
    const reason = window.prompt(decision === 'WAIVE' ? 'Why is the mark waived? The person will see this.' : 'Why does the mark stand? The person will see this.');
    if (!reason || reason.trim().length < 5) return;
    try { await api.post(`/blackmarks/appeals/${appeal.id}/decide`, { decision, reason: reason.trim() }); toast.success(decision === 'WAIVE' ? 'Mark waived' : 'Mark upheld'); load(); } catch (err) { toast.error(err); }
  };
  const withdraw = async (appeal) => {
    try { await api.post(`/blackmarks/appeals/${appeal.id}/withdraw`, {}); load(); } catch (err) { toast.error(err); }
  };
  if (!data) return <Spinner />;
  return (
    <section className="card">
      <div className="card-head"><h2>Appeals</h2><span className="small muted">{data.can_decide ? 'Decide with a reason; nobody decides their own' : 'Your appeals and their decisions'}</span></div>
      {data.appeals.length === 0 ? <EmptyState title="No appeals">To appeal one of your marks, use Appeal on it under All marks.</EmptyState> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Member</th><th>Mark</th><th>Appeal</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.appeals.map((a) => (
                <tr key={a.id}>
                  <td>{a.full_name}</td>
                  <td className="small"><span className="task-ref">{a.task_ref || '—'}</span> {a.mark_reason} · {a.points} pt</td>
                  <td className="small">{a.reason}{a.evidence_url ? <> · <a href={a.evidence_url} target="_blank" rel="noreferrer">evidence</a></> : null}</td>
                  <td className="small">
                    <Badge tone={a.status === 'OPEN' ? 'warning' : a.status === 'WAIVED' ? 'good' : 'neutral'}>{a.status.toLowerCase()}</Badge>
                    {a.decided_by_name && <div className="muted">{a.decided_by_name}: {a.decision_reason}</div>}
                  </td>
                  <td className="nowrap">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenSource(a.mark_id)}>Source</button>
                    {a.status === 'OPEN' && data.can_decide && (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => decide(a, 'WAIVE')}>Waive the mark</button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(a, 'UPHOLD')}>Uphold</button>
                      </>
                    )}
                    {a.status === 'OPEN' && !data.can_decide && <button type="button" className="btn btn-sm btn-ghost" onClick={() => withdraw(a)}>Withdraw</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function BlackMarks() {
  const { can, user } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();

  const [tab, setTab] = useState('review');
  const [month, setMonth] = useState(monthKey());
  const [departmentId, setDepartmentId] = useState('');
  const [review, setReview] = useState(null);
  const [marks, setMarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [source, setSource] = useState(null);
  const [recheck, setRecheck] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.review({ month, department_id: departmentId || undefined }),
      api.blackMarks({ month, department_id: departmentId || undefined }),
    ])
      .then(([reviewData, marksData]) => {
        setReview(reviewData);
        setMarks(marksData.marks);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [month, departmentId]);
  useEffect(() => {
    if (tab === 'recheck' && recheck === null) api.blackMarkRecheck().then((d) => setRecheck(d.marks)).catch(toast.error);
  }, [tab, recheck, toast]);

  const runScan = async () => {
    setScanning(true);
    try {
      const result = await api.runScan();
      toast.success(
        result.created.length
          ? `${result.created.length} new black mark(s) recorded`
          : 'Scan complete — nothing new to record',
      );
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setScanning(false);
    }
  };

  const waive = async (mark) => {
    const reason = window.prompt(`Why are you waiving this black mark for ${mark.full_name}?`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.waiveBlackMark(mark.id, reason.trim());
      toast.success('Black mark waived');
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading && !review) return <Spinner label="Building the review" />;

  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - index);
    return monthKey(date);
  });

  const flagged = review?.flagged || [];
  const limit = review?.thresholds?.missedDeadlineLimit ?? 3;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Black marks</h1>
          <div className="small muted">
            Missed deadlines are recorded automatically. More than {limit} in the period flags a member for review.
          </div>
        </div>
        <div className="row wrap">
          {can('blackmark.rules') && (
            <button type="button" className="btn btn-sm" onClick={runScan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Run scan now'}
            </button>
          )}
          {can('blackmark.create') && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setManual(true)}>
              <Icon name="plus" size={14} /> Raise manually
            </button>
          )}
        </div>
      </div>

      <div className="filters">
        <select className="select" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
        <select className="select" aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      {flagged.length > 0 && (
        <section className="card" style={{ borderLeft: '3px solid var(--critical)' }}>
          <div className="card-head">
            <div className="row">
              <Icon name="alert" style={{ color: 'var(--critical-text)' }} />
              <h2>Needs action at this month's review</h2>
            </div>
            <Badge tone="critical">{flagged.length}</Badge>
          </div>
          <div className="card-pad stack-sm">
            {flagged.map((member) => (
              <div key={member.user_id} className="row-between wrap" style={{ gap: 8 }}>
                <div className="row">
                  <Avatar name={member.full_name} size={26} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{member.full_name}</div>
                    <div className="small muted">{member.department || 'No department'}</div>
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {member.over_limit && (
                    <Badge tone="critical">
                      {member.missed_deadlines} missed deadlines — over the limit of {limit}
                    </Badge>
                  )}
                  <Badge tone={SEVERITY_TONE[member.severity]}>{member.total_points} points</Badge>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="tabs">
        {[
          ['review', 'Monthly review'],
          ['marks', `All marks (${marks.length})`],
          ['appeals', 'Appeals'],
          ...(can('blackmark.waive') ? [['recheck', 'Marks to recheck']] : []),
        ].map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'review' && review && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="card table-wrap">
            <div className="card-head">
              <h2>{monthLabel(month)}</h2>
              <span className="small muted">
                rolling window: {review.period.months} month{review.period.months === 1 ? '' : 's'}
              </span>
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>Member</th>
                  <th className="num" title="Different tasks with a deadline mark">Tasks missed</th>
                  <th className="num" title="Each mark recorded (one task can have more, e.g. an escalation)">Mark events</th>
                  <th className="num" title="Weighted points">Points</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                {review.members.filter((m) => m.mark_count > 0 || m.over_limit).length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState title="A clean month">No black marks recorded in this period.</EmptyState>
                    </td>
                  </tr>
                )}
                {review.members
                  .filter((m) => m.mark_count > 0 || m.over_limit)
                  .map((member) => (
                    <tr key={member.user_id}>
                      <td>
                        <div className="row">
                          <Avatar name={member.full_name} size={26} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{member.full_name}</div>
                            <div className="small muted">{member.department || 'No department'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num tnum">
                        {member.over_limit ? (
                          <strong style={{ color: 'var(--critical-text)' }}>{member.tasks_missed ?? member.missed_deadlines}</strong>
                        ) : (
                          member.tasks_missed ?? member.missed_deadlines
                        )}
                      </td>
                      <td className="num tnum">
                        {member.mark_count}
                        {member.waived_count > 0 && <span className="small muted"> (+{member.waived_count} waived)</span>}
                      </td>
                      <td className="num tnum" style={{ fontWeight: 650 }}>{member.total_points}</td>
                      <td>
                        <Badge tone={SEVERITY_TONE[member.severity]}>
                          <Icon
                            name={member.severity === 'ok' ? 'check' : 'alert'}
                            size={11}
                          />
                          {member.severity === 'ok' ? 'In good standing' : member.severity === 'warning' ? 'Watch' : 'Action needed'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head"><h2>Points by member</h2></div>
            <div className="card-pad">
              <BarList
                items={review.members
                  .filter((m) => m.total_points > 0)
                  .map((m) => ({ id: m.user_id, label: m.full_name, value: m.total_points }))}
                emptyText="Nobody has picked up a black mark this period"
              />
              <hr className="divider" style={{ margin: '14px 0' }} />
              <div className="small muted stack-sm">
                <div>Warning at {review.thresholds.warningPoints} points · action needed at {review.thresholds.criticalPoints} points.</div>
                <div>{review.consequences || 'Flags for review only.'}</div>
                <div>Adjust these, and the rules that generate marks, under Settings → Black mark rules.</div>
              </div>
            </div>
          </section>
        </div>
      )}

      {tab === 'marks' && (
        <div className="card table-wrap">
          {marks.length === 0 ? (
            <EmptyState title="No black marks in this period" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Reason</th>
                  <th>Rule</th>
                  <th className="num">Points</th>
                  <th>When</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {marks.map((mark) => (
                  <tr key={mark.id}>
                    <td>
                      <div className="row">
                        <Avatar name={mark.full_name} color={mark.avatar_color} size={24} />
                        <span>{mark.full_name}</span>
                      </div>
                    </td>
                    <td>
                      <div className="truncate" style={{ maxWidth: 300 }}>{mark.reason}</div>
                      {mark.task_ref && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: 0, height: 'auto' }}
                          onClick={() => setOpenTask(mark.task_id)}
                        >
                          <span className="task-ref">{mark.task_ref}</span>
                        </button>
                      )}
                    </td>
                    <td className="small">{TRIGGER_LABEL[mark.trigger_type] || (mark.source === 'manual' ? 'Manual' : '—')}</td>
                    <td className="num tnum">{mark.points}</td>
                    <td className="small muted">{formatDate(mark.occurred_at)}</td>
                    <td>
                      {mark.status === 'waived' ? (
                        <Badge tone="neutral" title={mark.waived_reason}>Waived</Badge>
                      ) : (
                        <Badge tone="critical">Active</Badge>
                      )}
                    </td>
                    <td className="nowrap">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource(mark.id)}>Source</button>
                      {mark.user_id === user?.id && mark.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            const reason = window.prompt('Why should this mark not stand? Say what happened (at least a sentence).');
                            if (!reason || reason.trim().length < 10) return;
                            const evidence = window.prompt('A link to evidence, if you have one (optional)') || null;
                            try {
                              await api.post(`/blackmarks/${mark.id}/appeal`, { reason: reason.trim(), evidence_url: evidence });
                              toast.success('Appeal sent: someone who reviews marks will decide');
                            } catch (err) { toast.error(err); }
                          }}
                        >
                          Appeal
                        </button>
                      )}
                      {can('blackmark.waive') && (
                        mark.status === 'active' ? (
                          <button type="button" className="btn btn-sm" onClick={() => waive(mark)}>Waive</button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={async () => {
                              try {
                                await api.restoreBlackMark(mark.id);
                                load();
                              } catch (err) {
                                toast.error(err);
                              }
                            }}
                          >
                            Restore
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'appeals' && <Appeals onOpenSource={setSource} />}

      {tab === 'recheck' && (
        <section className="card">
          <div className="card-head"><h2>Marks that would not be given today</h2></div>
          <div className="card-pad small muted" style={{ paddingTop: 0 }}>
            Active marks the rules and calendar in force would not give now: leave or a holiday approved since, two marks for one miss under
            the old overlapping rules, someone else owning the task at its deadline, an approved deferral or an accepted block.
            Nothing changes here and nothing is waived automatically: open the source, then waive it if that is right.
          </div>
          {recheck === null ? <Spinner /> : recheck.length === 0 ? (
            <EmptyState title="Nothing to recheck">Every active mark still stands against the calendar.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Member</th><th>Task</th><th>Why</th><th>Deadline</th><th>In force now</th><th /></tr></thead>
                <tbody>
                  {recheck.map((m) => (
                    <tr key={m.mark_id}>
                      <td>{m.full_name}</td>
                      <td><span className="task-ref">{m.task_ref}</span> <span className="small">{m.rule_name}</span></td>
                      <td className="small">{(m.reason_words || []).map((w) => <div key={w}>{w}</div>)}</td>
                      <td className="small nowrap">{formatDate(m.due, { withTime: true })}</td>
                      <td className="small">{formatDate(m.effective_due, { withTime: true })}{m.because?.length > 0 && <div className="muted">moved past {shiftWords(m.because)}</div>}</td>
                      <td className="nowrap">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource(m.mark_id)}>Source</button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => waive({ id: m.mark_id, full_name: m.full_name }).then(() => setRecheck(null))}
                        >
                          Waive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {source && <MarkSourceDialog markId={source} onClose={() => setSource(null)} onOpenTask={(id) => { setSource(null); setOpenTask(id); }} />}
      {manual && <ManualMarkDialog onClose={() => setManual(false)} onSaved={load} />}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
