import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import LogActivityDialog from '../components/LogActivityDialog.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { ACCOUNT_TYPE_META, QUICK_ACTIVITIES, activityMeta, formatMoney, freshnessLabel } from '../lib/crm.js';
import { formatDate, relativeTime, dueLabel, STAGE_LABEL } from '../lib/format.js';

function Timeline({ activities }) {
  if (!activities.length) return <div className="small muted">Nothing logged yet.</div>;
  return (
    <div className="stack">
      {activities.map((activity) => {
        const meta = activityMeta(activity.type);
        return (
          <div key={activity.id} className="timeline-row">
            <span className="timeline-icon"><Icon name={meta.icon} size={13} /></span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{activity.subject || meta.label}</span>
                <Badge tone="neutral">{meta.label}</Badge>
              </div>
              {activity.body && <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{activity.body}</div>}
              {activity.next_step && <div className="small muted" style={{ marginTop: 2 }}>Next: {activity.next_step}</div>}
              {activity.task_ref && (
                <div className="small" style={{ marginTop: 2 }}>
                  <span className="task-ref">{activity.task_ref}</span> {activity.task_title}
                </div>
              )}
              <div className="small muted" style={{ marginTop: 2 }}>
                {activity.actor_name || 'Someone'} · {relativeTime(activity.occurred_at)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AccountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(null);
  const [addingTask, setAddingTask] = useState(false);
  const [openTask, setOpenTask] = useState(null);

  const load = () => {
    api.account(id).then(setData).catch((err) => {
      toast.error(err);
      if (err.status === 404) navigate('/pipeline');
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    load();
    api.accountStages().then((d) => setStages(d.stages)).catch(() => {});
  }, [id]);

  if (loading && !data) return <Spinner label="Loading the account" />;
  if (!data) return <EmptyState title="Account not found" />;

  const { account, activities, tasks, can_edit: canEdit } = data;
  const typeMeta = ACCOUNT_TYPE_META[account.type];
  const fresh = freshnessLabel(account.days_since_activity);
  const money = formatMoney(account.value, account.currency);
  const isLead = account.type === 'LEAD';

  const moveStage = async (stageId) => {
    try {
      await api.moveAccountStage(account.id, Number(stageId));
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  const convert = async (type) => {
    try {
      await api.convertAccount(account.id, type);
      toast.success(type === 'CUSTOMER' ? 'Now a customer' : 'Now a partner');
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row small muted">
        <Link to="/pipeline" className="btn-link">Pipeline</Link>
        <span>/</span>
        <span className="truncate">{account.name}</span>
      </div>

      <section className="card card-pad stack">
        <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <h1 style={{ fontSize: 22 }}>{account.name}</h1>
              <Badge tone={typeMeta.tone}>{typeMeta.label}</Badge>
              {account.stage_name && <Badge dot={account.stage_color}>{account.stage_name}</Badge>}
            </div>
            <div className="small muted row wrap" style={{ gap: 6, marginTop: 4 }}>
              {money && <span>{money}</span>}
              {account.department_name && <><span>·</span><span>{account.department_name}</span></>}
              {account.source && <><span>·</span><span>from {account.source}</span></>}
              <span>·</span>
              <span>last worked <Badge tone={fresh.tone}>{fresh.text}</Badge></span>
            </div>
          </div>
          <div className="row wrap">
            {canEdit && isLead && (
              <select className="select" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && moveStage(e.target.value)}>
                <option value="">Move stage…</option>
                {stages.filter((s) => s.id !== account.stage_id).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {canEdit && isLead && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => convert('CUSTOMER')}>
                Won → Customer
              </button>
            )}
            {canEdit && account.type === 'CUSTOMER' && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => convert('PARTNER')}>
                Make partner
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                <Icon name="edit" size={13} /> Edit
              </button>
            )}
            {canEdit && (
              <ConfirmButton
                label="Archive"
                confirmLabel="Really archive?"
                className="btn btn-danger btn-sm"
                onConfirm={async () => {
                  await api.archiveAccount(account.id);
                  navigate('/pipeline');
                }}
              />
            )}
          </div>
        </div>

        <div className="goal-hero">
          <div>
            <div className="stat-label">Leading it</div>
            <div className="row" style={{ marginTop: 6 }}>
              {account.owner_name ? (
                <>
                  <Avatar name={account.owner_name} color={account.owner_color} size={26} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{account.owner_name}</span>
                </>
              ) : <span className="muted small">Nobody yet</span>}
            </div>
          </div>
          <div>
            <div className="stat-label">Following it</div>
            <div className="row" style={{ marginTop: 6 }}>
              {account.follower_name ? (
                <>
                  <Avatar name={account.follower_name} color={account.follower_color} size={26} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{account.follower_name}</span>
                </>
              ) : <span className="muted small">Nobody</span>}
            </div>
          </div>
          <div className="grow" style={{ minWidth: 180 }}>
            <div className="stat-label">Next step</div>
            {account.next_step ? (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{account.next_step}</div>
                {account.next_step_due && (
                  <Badge tone={account.next_step_overdue ? 'critical' : 'neutral'}>
                    {account.next_step_overdue ? 'overdue' : 'due'} {formatDate(account.next_step_due)}
                  </Badge>
                )}
              </div>
            ) : (
              <div className="small muted" style={{ marginTop: 4 }}>None set — every open lead should have one.</div>
            )}
          </div>
        </div>

        {(account.contact_name || account.contact_email || account.contact_phone) && (
          <div className="small muted row wrap" style={{ gap: 10 }}>
            {account.contact_name && <span><strong>{account.contact_name}</strong></span>}
            {account.contact_email && <a href={`mailto:${account.contact_email}`} className="btn-link">{account.contact_email}</a>}
            {account.contact_phone && <span>{account.contact_phone}</span>}
            {account.website && <a href={account.website} target="_blank" rel="noreferrer" className="btn-link">{account.website}</a>}
          </div>
        )}
        {account.description && <p style={{ fontSize: 13.5 }}>{account.description}</p>}
      </section>

      {can('crm.activity.log') && canEdit && (
        <section className="card card-pad stack-sm">
          <div className="small" style={{ fontWeight: 650 }}>Log a touch</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {QUICK_ACTIVITIES.map((type) => {
              const meta = activityMeta(type);
              return (
                <button key={type} type="button" className="btn btn-sm" onClick={() => setLogging(type)}>
                  <Icon name={meta.icon} size={13} /> {meta.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card card-pad stack">
          <h2>Activity</h2>
          <Timeline activities={activities} />
        </section>

        <section className="card card-pad stack">
          <div className="row-between">
            <h2>Tasks</h2>
            {can('task.create') && (
              <button type="button" className="btn btn-sm" onClick={() => setAddingTask(true)}>
                <Icon name="plus" size={13} /> Add task
              </button>
            )}
          </div>
          {tasks.length === 0 ? (
            <div className="small muted">No tasks yet. Work on this deal shows up here.</div>
          ) : (
            <div className="stack-sm">
              {tasks.map((task) => {
                const due = dueLabel(task.due_date, { done: task.stage === 'done' });
                return (
                  <button key={task.id} type="button" className="link-row" onClick={() => setOpenTask(task.id)}>
                    <span className="task-ref">{task.ref}</span>
                    <span className="grow truncate">{task.title}</span>
                    {task.assignee_name && <Avatar name={task.assignee_name} color={task.assignee_color} size={20} />}
                    <Badge tone={task.stage === 'done' ? 'good' : due.tone}>
                      {task.stage === 'done' ? 'Done' : due.text}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {editing && (
        <AccountDialog account={account} stages={stages} onClose={() => setEditing(false)} onSaved={load} />
      )}
      {logging && (
        <LogActivityDialog account={account} type={logging} onClose={() => setLogging(null)} onSaved={load} />
      )}
      {addingTask && (
        <TaskDialog
          defaults={{
            account_id: account.id,
            department_id: account.department_id || undefined,
            assignee_id: account.owner_user_id || undefined,
          }}
          onClose={() => setAddingTask(false)}
          onSaved={load}
        />
      )}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
