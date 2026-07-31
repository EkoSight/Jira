import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { BarList } from '../components/charts.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { formatDate, monthKey, monthLabel } from '../lib/format.js';

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

export default function BlackMarks() {
  const { can } = useAuth();
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
        <select className="select" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
        <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
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
                  <th className="num">Missed</th>
                  <th className="num">Marks</th>
                  <th className="num">Points</th>
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
                          <strong style={{ color: 'var(--critical-text)' }}>{member.missed_deadlines}</strong>
                        ) : (
                          member.missed_deadlines
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
                    <td>
                      {can('blackmark.waive') && (
                        mark.status === 'active' ? (
                          <button type="button" className="btn btn-sm" onClick={() => waive(mark)}>Waive</button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={async () => {
                              await api.restoreBlackMark(mark.id);
                              load();
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

      {manual && <ManualMarkDialog onClose={() => setManual(false)} onSaved={load} />}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
