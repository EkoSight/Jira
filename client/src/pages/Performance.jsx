import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { monthKey, monthLabel } from '../lib/format.js';

const STANDING = {
  strong: { label: 'Strong', tone: 'good' },
  good: { label: 'On track', tone: 'good' },
  watch: { label: 'Watch', tone: 'warning' },
  needs_action: { label: 'Needs action', tone: 'critical' },
};

const SEVERITY_TONE = { high: 'critical', medium: 'warning', low: 'neutral' };

function ShareDialog({ review, month, onClose }) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const share = async () => {
    setSaving(true);
    try {
      await api.sharePerformance(review.user.id, { message: message.trim() || undefined, month });
      toast.success(`Review shared with ${review.user.full_name}`);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Share this review with ${review.user.full_name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={share} disabled={saving}>
            {saving ? 'Sending…' : 'Send it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small dim">
          They will get a notification with the summary and the first suggestion. Add anything you want to say
          yourself — it lands in the same message.
        </div>
        <div className="card card-pad small">{review.summary}</div>
        <Field label="Your note (optional)">
          <textarea
            className="textarea"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What you would say in the one-to-one."
          />
        </Field>
      </div>
    </Modal>
  );
}

function ReviewBody({ review, month, canShare }) {
  const [sharing, setSharing] = useState(false);
  const standing = STANDING[review.standing] || STANDING.good;
  const m = review.metrics;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <section className="card card-pad">
        <div className="row-between wrap" style={{ gap: 10 }}>
          <div className="row">
            <Avatar name={review.user.full_name} color={review.user.avatar_color} size={40} />
            <div>
              <h2>{review.user.full_name}</h2>
              <div className="small muted">
                {[review.user.job_title, review.user.department].filter(Boolean).join(' · ') || 'No department'}
              </div>
            </div>
          </div>
          <div className="row">
            <Badge tone={standing.tone}>{standing.label}</Badge>
            {canShare && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setSharing(true)}>
                Share with them
              </button>
            )}
          </div>
        </div>
        <p style={{ marginBottom: 0, marginTop: 12 }}>{review.summary}</p>
      </section>

      <div className="stat-grid">
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">Completed</span>
          <span className="stat-value tnum">{m.completed}</span>
          <span className="stat-note">{m.previous.completed} last month</span>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">On time</span>
          <span className="stat-value tnum">{m.onTimeRate == null ? '—' : `${m.onTimeRate}%`}</span>
          <span className="stat-note">
            {m.previous.onTimeRate == null ? 'no history' : `${m.previous.onTimeRate}% last month`}
          </span>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">Overdue now</span>
          <span className="stat-value tnum">{m.overdueNow}</span>
          <span className="stat-note">of {m.openNow} open</span>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">Black marks</span>
          <span className="stat-value tnum">{m.markCount}</span>
          <span className="stat-note">{m.markPoints} points</span>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">Avg days late</span>
          <span className="stat-value tnum">{m.late ? m.avgDaysLate.toFixed(1) : '—'}</span>
          <span className="stat-note">{m.late} finished late</span>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <span className="stat-label">Kudos</span>
          <span className="stat-value tnum">{m.kudos}</span>
          <span className="stat-note">from colleagues</span>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h2>What is going wrong</h2>
            {review.concerns.length > 0 && <Badge tone="warning">{review.concerns.length}</Badge>}
          </div>
          <div className="card-pad stack-sm">
            {review.concerns.length === 0 && (
              <div className="small muted">Nothing is flagged for this period.</div>
            )}
            {review.concerns.map((concern) => (
              <div key={concern.title} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Icon
                  name="alert"
                  size={14}
                  style={{ marginTop: 2, color: `var(--${concern.severity === 'high' ? 'critical' : 'warning'})` }}
                />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <strong>{concern.title}</strong>
                    {concern.severity && (
                      <Badge tone={SEVERITY_TONE[concern.severity]}>{concern.severity}</Badge>
                    )}
                  </div>
                  <div className="small dim">{concern.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>What would help</h2>
            {review.suggestions.length > 0 && <Badge tone="brand">{review.suggestions.length}</Badge>}
          </div>
          <div className="card-pad stack-sm">
            {review.suggestions.length === 0 && (
              <div className="small muted">No suggestions — keep doing what you are doing.</div>
            )}
            {review.suggestions.map((suggestion) => (
              <div key={suggestion.title} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Icon name="bulb" size={14} style={{ marginTop: 2, color: 'var(--brand)' }} />
                <div className="grow">
                  <strong>{suggestion.title}</strong>
                  <div className="small dim">{suggestion.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {review.strengths.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Going well</h2></div>
          <div className="card-pad stack-sm">
            {review.strengths.map((strength) => (
              <div key={strength.title} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Icon name="check" size={14} style={{ marginTop: 2, color: 'var(--good)' }} />
                <div className="grow">
                  <strong>{strength.title}</strong>
                  <div className="small dim">{strength.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {sharing && <ShareDialog review={review} month={month} onClose={() => setSharing(false)} />}
    </div>
  );
}

export default function Performance() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();

  const targetId = Number(userId) || user.id;
  const canSeeTeam = can('report.view');

  const [month, setMonth] = useState(monthKey());
  const [departmentId, setDepartmentId] = useState('');
  const [review, setReview] = useState(null);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const wantsTeam = canSeeTeam && !userId;
    const request = wantsTeam
      ? api.teamPerformance({ month, department_id: departmentId || undefined })
      : api.performance(targetId, { month });

    request
      .then((data) => {
        if (wantsTeam) {
          setTeam(data.reviews);
          setReview(null);
        } else {
          setReview(data.review);
          setTeam(null);
        }
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, month, departmentId]);

  if (loading && !review && !team) return <Spinner label="Reviewing the numbers" />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>{userId ? 'Performance review' : canSeeTeam ? 'Performance reviews' : 'My performance'}</h1>
          <div className="small muted">
            Built from what actually happened — deadlines met, work left open, black marks — with a suggestion for
            each concern.
          </div>
        </div>
        <div className="filters">
          <select className="select" value={month} onChange={(e) => setMonth(e.target.value)}>
            {Array.from({ length: 12 }, (_, index) => {
              const date = new Date();
              date.setDate(1);
              date.setMonth(date.getMonth() - index);
              return monthKey(date);
            }).map((m) => (
              <option key={m} value={m}>{monthLabel(m)}</option>
            ))}
          </select>
          {canSeeTeam && !userId && (
            <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          {userId && (
            <button type="button" className="btn btn-sm" onClick={() => navigate('/performance')}>
              Back to everyone
            </button>
          )}
        </div>
      </div>

      {review && <ReviewBody review={review} month={month} canShare={canSeeTeam && review.user.id !== user.id} />}

      {team && (
        team.length === 0 ? (
          <EmptyState title="Nobody to review yet" />
        ) : (
          <div className="stack-sm">
            {team.map((entry) => {
              const standing = STANDING[entry.standing] || STANDING.good;
              return (
                <button
                  key={entry.user.id}
                  type="button"
                  className="card card-pad"
                  style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
                  onClick={() => navigate(`/performance/${entry.user.id}`)}
                >
                  <div className="row-between wrap" style={{ gap: 10 }}>
                    <div className="row">
                      <Avatar name={entry.user.full_name} color={entry.user.avatar_color} size={30} />
                      <div>
                        <div style={{ fontWeight: 600 }}>{entry.user.full_name}</div>
                        <div className="small muted">{entry.user.department || 'No department'}</div>
                      </div>
                    </div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <Badge tone={standing.tone}>{standing.label}</Badge>
                      <span className="small muted tnum">
                        {entry.metrics.completed} done ·{' '}
                        {entry.metrics.onTimeRate == null ? '—' : `${entry.metrics.onTimeRate}% on time`} ·{' '}
                        {entry.metrics.overdueNow} overdue
                      </span>
                      {entry.concerns.length > 0 && (
                        <Badge tone="warning">{entry.concerns.length} concern{entry.concerns.length === 1 ? '' : 's'}</Badge>
                      )}
                    </div>
                  </div>
                  {entry.concerns[0] && (
                    <div className="small dim" style={{ marginTop: 8 }}>
                      Top concern: {entry.concerns[0].title}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
