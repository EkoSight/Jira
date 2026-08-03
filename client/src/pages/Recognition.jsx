import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { BarList } from '../components/charts.jsx';
import { initials, monthKey, monthLabel, relativeTime } from '../lib/format.js';

/**
 * The award card is drawn as an SVG so it can be downloaded and shared in a
 * group chat — the "graffiti" a winner actually gets to keep.
 */
function AwardCard({ award, cardRef }) {
  const stats = award.stats || {};
  return (
    <svg
      ref={cardRef}
      viewBox="0 0 600 340"
      style={{ width: '100%', maxWidth: 600, borderRadius: 14, display: 'block' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="award-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#1c5cab" />
        </linearGradient>
      </defs>

      <rect width="600" height="340" rx="16" fill="url(#award-bg)" />
      <circle cx="530" cy="60" r="90" fill="#ffffff" opacity="0.05" />
      <circle cx="70" cy="300" r="70" fill="#ffffff" opacity="0.05" />

      <text x="40" y="52" fill="#86b6ef" fontSize="13" fontWeight="700" letterSpacing="2.5"
        fontFamily="system-ui, sans-serif">
        {award.title.toUpperCase()}
      </text>
      <text x="40" y="76" fill="#c3c2b7" fontSize="13" fontFamily="system-ui, sans-serif">
        {monthLabel(String(award.period_month).slice(0, 7))} · EkoSight
      </text>

      <circle cx="78" cy="150" r="34" fill={award.avatar_color || '#2a78d6'} />
      <text x="78" y="158" fill="#ffffff" fontSize="24" fontWeight="700" textAnchor="middle"
        fontFamily="system-ui, sans-serif">
        {initials(award.full_name)}
      </text>

      <text x="128" y="145" fill="#ffffff" fontSize="30" fontWeight="700" fontFamily="system-ui, sans-serif">
        {award.full_name}
      </text>
      <text x="128" y="170" fill="#c3c2b7" fontSize="14" fontFamily="system-ui, sans-serif">
        {[award.job_title, award.department].filter(Boolean).join(' · ')}
      </text>

      {award.citation && (
        <text x="40" y="215" fill="#ffffff" fontSize="14" fontFamily="system-ui, sans-serif" opacity="0.9">
          {award.citation.slice(0, 74)}
        </text>
      )}

      {[
        [stats.done_count ?? 0, 'tasks done'],
        [stats.on_time_rate != null ? `${stats.on_time_rate}%` : '—', 'on time'],
        [stats.critical_done ?? 0, 'critical'],
        [stats.kudos_count ?? 0, 'kudos'],
      ].map(([value, label], index) => (
        <g key={label} transform={`translate(${40 + index * 138}, 250)`}>
          <rect width="122" height="58" rx="10" fill="#ffffff" opacity="0.1" />
          <text x="16" y="28" fill="#ffffff" fontSize="20" fontWeight="700" fontFamily="system-ui, sans-serif">
            {value}
          </text>
          <text x="16" y="45" fill="#c3c2b7" fontSize="11" fontFamily="system-ui, sans-serif">
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function AwardDialog({ month, members, onClose, onSaved }) {
  const toast = useToast();
  const suggested = members[0];
  const [userId, setUserId] = useState(suggested?.user_id || '');
  const [title, setTitle] = useState('Performer of the Month');
  const [citation, setCitation] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!userId) return toast.error('Choose someone first');
    setSaving(true);
    try {
      await api.giveAward({
        user_id: Number(userId),
        month,
        title: title.trim() || undefined,
        citation: citation.trim() || undefined,
      });
      toast.success('Awarded — they have been notified');
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
      title={`Award for ${monthLabel(month)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Give the award'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Who" hint={suggested ? `The scoreboard suggests ${suggested.full_name}` : undefined}>
          <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name} — score {m.score}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Award">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Citation" hint="One line about what they did — this appears on the shareable card">
          <textarea
            className="textarea"
            rows={3}
            value={citation}
            onChange={(e) => setCitation(e.target.value)}
            placeholder="Closed every critical support escalation inside the day."
          />
        </Field>
      </div>
    </Modal>
  );
}

function KudosDialog({ onClose, onSaved }) {
  const { user } = useAuth();
  const { users } = useRefData();
  const toast = useToast();
  const [toUser, setToUser] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const send = async () => {
    if (!toUser || message.trim().length < 3) return toast.error('Pick someone and say why');
    setSaving(true);
    try {
      await api.giveKudos({ to_user: Number(toUser), message: message.trim() });
      toast.success('Kudos sent');
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
      title="Give kudos"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={saving}>
            Send
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Who deserves it?">
          <select className="select" value={toUser} onChange={(e) => setToUser(e.target.value)}>
            <option value="">Choose…</option>
            {users.filter((u) => u.id !== user.id).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What did they do?">
          <textarea
            className="textarea"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Stayed late to get the dealer quotation out before the deadline."
          />
        </Field>
      </div>
    </Modal>
  );
}

export default function Recognition() {
  const { can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();
  const cardRef = useRef(null);

  const [month, setMonth] = useState(monthKey());
  const [departmentId, setDepartmentId] = useState('');
  const [board, setBoard] = useState(null);
  const [kudos, setKudos] = useState([]);
  const [wall, setWall] = useState([]);
  const [loading, setLoading] = useState(true);
  const [awarding, setAwarding] = useState(false);
  const [givingKudos, setGivingKudos] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.leaderboard({ month, department_id: departmentId || undefined }),
      api.kudos(),
      api.awards(),
    ])
      .then(([boardData, kudosData, awardsData]) => {
        setBoard(boardData);
        setKudos(kudosData.kudos);
        setWall(awardsData.awards);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [month, departmentId]);

  /** Rasterises the SVG card to a PNG the winner can share anywhere. */
  const downloadCard = (award) => {
    const svg = cardRef.current;
    if (!svg) return;
    const source = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 680;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${award.full_name.replace(/\s+/g, '-').toLowerCase()}-${String(award.period_month).slice(0, 7)}.png`;
        link.click();
        URL.revokeObjectURL(link.href);
      }, 'image/png');
    };
    image.onerror = () => toast.error('Could not build the image');
    image.src = svgUrl;
  };

  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - index);
    return monthKey(date);
  });

  if (loading && !board) return <Spinner label="Working out the scores" />;
  if (!board) return <EmptyState title="Could not load the leaderboard" />;

  const winner = board.awards?.[0];
  const top = board.members.slice(0, 10);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between wrap">
        <div>
          <h1>Recognition</h1>
          <div className="small muted">
            Who delivered this month — completed work, on time, weighed against black marks.
          </div>
        </div>
        <div className="row wrap">
          <button type="button" className="btn btn-sm" onClick={() => setGivingKudos(true)}>
            <Icon name="trophy" size={14} /> Give kudos
          </button>
          {can('recognition.manage') && board.members.length > 0 && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAwarding(true)}>
              Award the month
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

      {winner && (
        <section className="card card-pad stack">
          <div className="row-between wrap">
            <h2>🏆 {winner.title} — {monthLabel(month)}</h2>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => downloadCard(winner)}>
                Download card
              </button>
              {can('recognition.manage') && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    await api.removeAward(winner.id);
                    load();
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <AwardCard award={winner} cardRef={cardRef} />
          {winner.awarded_by_name && (
            <div className="small muted">Awarded by {winner.awarded_by_name}</div>
          )}
        </section>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card table-wrap">
          <div className="card-head">
            <h2>Scoreboard — {monthLabel(month)}</h2>
            <span className="small muted">{board.members.length} people</span>
          </div>
          {top.length === 0 ? (
            <EmptyState title="Nothing completed yet this month" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Member</th>
                  <th className="num">Done</th>
                  <th className="num">On time</th>
                  <th className="num">Marks</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {top.map((member, index) => (
                  <tr key={member.user_id}>
                    <td className="tnum" style={{ fontWeight: 700, color: index === 0 ? 'var(--warning-text)' : 'inherit' }}>
                      {index + 1}
                    </td>
                    <td>
                      <div className="row">
                        <Avatar name={member.full_name} color={member.avatar_color} size={26} />
                        <div>
                          <div style={{ fontWeight: 600 }}>{member.full_name}</div>
                          <div className="small muted">{member.department || 'No department'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num tnum">{member.done_count}</td>
                    <td className="num tnum">
                      {member.on_time_rate == null ? '—' : `${member.on_time_rate}%`}
                    </td>
                    <td className="num tnum">
                      {member.mark_count > 0 ? (
                        <span style={{ color: 'var(--critical-text)' }}>{member.mark_count}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="num tnum" style={{ fontWeight: 650 }}>{member.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="card-pad small muted">
            Score = 1 per completed task (+1 critical, +0.5 high, +0.5 on time, −0.5 late),
            −1 per black mark point, plus up to 2 for kudos.
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Score</h2></div>
            <div className="card-pad">
              <BarList
                items={top.filter((m) => m.score > 0).map((m) => ({ id: m.user_id, label: m.full_name, value: m.score }))}
                emptyText="No positive scores yet this month"
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2>Kudos wall</h2></div>
            <div className="card-pad stack-sm" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {kudos.length === 0 && <div className="empty small">Be the first to thank someone</div>}
              {kudos.map((entry) => (
                <div key={entry.id} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <Avatar name={entry.to_name} color={entry.to_color} size={24} />
                  <div className="grow">
                    <div className="small">
                      <strong>{entry.to_name}</strong>{' '}
                      <span className="muted">from {entry.from_name}</span>
                    </div>
                    <div className="small dim">{entry.message}</div>
                  </div>
                  <span className="small muted">{relativeTime(entry.created_at)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {wall.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Hall of fame</h2></div>
          <div className="card-pad row wrap" style={{ gap: 10 }}>
            {wall.map((award) => (
              <div key={award.id} className="badge" style={{ height: 30, paddingLeft: 4 }}>
                <Avatar name={award.full_name} color={award.avatar_color} size={22} />
                <strong>{award.full_name}</strong>
                <span className="muted">{monthLabel(String(award.period_month).slice(0, 7))}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {awarding && (
        <AwardDialog month={month} members={board.members} onClose={() => setAwarding(false)} onSaved={load} />
      )}
      {givingKudos && <KudosDialog onClose={() => setGivingKudos(false)} onSaved={load} />}
    </div>
  );
}
