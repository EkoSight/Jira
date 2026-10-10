import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { AuthedImage, Avatar, Badge, ConfirmButton, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import LogActivityDialog from '../components/LogActivityDialog.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import CrmPeople from '../components/CrmPeople.jsx';
import CrmOpportunities, { CommitmentsPanel } from '../components/CrmOpportunities.jsx';
import CrmMeetings from '../components/CrmMeetings.jsx';
import CrmDelivery from '../components/CrmDelivery.jsx';
import CrmResources from '../components/CrmResources.jsx';
import AccountDossier from '../components/AccountDossier.jsx';
import CrmBlockers from '../components/CrmBlockers.jsx';
import { ConvertDialog } from '../components/LeadMoveDialogs.jsx';
import DealMoveDialog from '../components/DealMoveDialog.jsx';
import { NextActionLine } from '../components/DealParts.jsx';
import {
  ACCOUNT_TYPE_META, CLOCKS, DIRECTION_META, QUICK_ACTIVITIES, SOURCE_LABEL, activityMeta, agoWords,
  clockTone, formatMoney,
} from '../lib/crm.js';
import { relativeTime, dueLabel } from '../lib/format.js';

/**
 * Which way an entry went. Older entries recorded before directions were kept
 * show nothing rather than a guess.
 */
function directionOf(activity) {
  if (activity.direction) return activity.direction;
  if (activity.is_external === false) return 'INTERNAL';
  return null;
}

function Timeline({ activities }) {
  if (!activities.length) return <div className="small muted">Nothing logged yet.</div>;
  return (
    <div className="stack">
      {activities.map((activity) => {
        const meta = activityMeta(activity.type);
        const direction = DIRECTION_META[directionOf(activity)];
        return (
          <div key={activity.id} className={`timeline-row${directionOf(activity) === 'INTERNAL' ? ' is-internal' : ''}`}>
            <span className="timeline-icon"><Icon name={meta.icon} size={13} /></span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{activity.subject || meta.label}</span>
                <Badge tone="neutral">{meta.label}</Badge>
                {direction && <Badge tone={direction.tone} title={direction.title}>{direction.label}</Badge>}
                {activity.opportunity_name && <span className="small muted">· {activity.opportunity_name}</span>}
              </div>
              {activity.body && <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{activity.body}</div>}
              {activity.meta?.evidence_url && (
                <div className="small" style={{ marginTop: 2 }}>
                  <a className="btn-link" href={activity.meta.evidence_url} target="_blank" rel="noopener noreferrer">evidence</a>
                </div>
              )}
              {activity.next_step && <div className="small muted" style={{ marginTop: 2 }}>Next: {activity.next_step}</div>}
              {activity.task_ref && (
                <div className="small" style={{ marginTop: 2 }}>
                  <span className="task-ref">{activity.task_ref}</span> {activity.task_title}
                </div>
              )}
              <div className="small muted" style={{ marginTop: 2 }}>
                {activity.actor_name || 'Someone'} · {relativeTime(activity.occurred_at)}
                {activity.source && SOURCE_LABEL[activity.source] ? ` · ${SOURCE_LABEL[activity.source]}` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** How a finished deal task closed: achieved with evidence, achieved without, or not achieved. */
function OutcomeBadge({ task }) {
  if (task.stage !== 'done') return null;
  if (task.outcome_status === 'NOT_ACHIEVED') return <Badge tone="warning">closed, not achieved</Badge>;
  if (task.outcome_status === 'ACHIEVED' && task.outcome_evidence_url) {
    return <Badge tone="good" title="Finished, with a link to the evidence">evidence</Badge>;
  }
  if (task.outcome_status === 'ACHIEVED') {
    return <Badge tone="neutral" title="Finished, but no link to the evidence was given">no evidence link</Badge>;
  }
  return null;
}

export default function AccountDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const focusDeal = searchParams.get('deal') ? Number(searchParams.get('deal')) : null;
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(null);
  const [addingTask, setAddingTask] = useState(false);
  // arriving from a deal card opens that deal
  const [tab, setTab] = useState(() => (focusDeal ? 'opportunities' : 'overview'));
  const [openTask, setOpenTask] = useState(null);
  const [converting, setConverting] = useState(null);
  const [moving, setMoving] = useState(null);
  const [raiseSignal, setRaiseSignal] = useState(0);

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

  useEffect(() => {
    if (focusDeal) setTab('opportunities');
  }, [focusDeal]);

  if (loading && !data) return <Spinner label="Loading the account" />;
  if (!data) return <EmptyState title="Account not found" />;

  const {
    account, activities, tasks, contacts = [], opportunities = [], locations = [],
    engagements = [], can_edit: canEdit,
  } = data;
  const typeMeta = ACCOUNT_TYPE_META[account.type];
  const money = formatMoney(account.value, account.currency);
  const isLead = account.type === 'LEAD';
  const liveDeals = opportunities.filter((o) => o.status === 'ACTIVE');
  const openCommitments = (data.commitments || []).filter((c) => c.status === 'OPEN');
  // the deal the organization's headline follows, if it is still live
  const mainDeal = liveDeals.find((o) => o.id === account.primary_opportunity_id) || liveDeals[0] || null;

  // moving the organization's stage moves its main deal, through the same
  // dialog — evidence and next action included — as moving the deal itself
  const moveStage = (stageId) => {
    if (!mainDeal) return toast.error('There is no live deal here to move — add one on the Opportunities tab');
    setMoving({ deal: mainDeal, stageId: Number(stageId) });
    return undefined;
  };

  const convert = (type) => setConverting(type);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row small muted">
        <Link to="/pipeline" className="btn-link">B2B Pipeline</Link>
        <span>/</span>
        <span className="truncate">{account.name}</span>
      </div>

      <section className="card card-pad stack">
        <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <AuthedImage src={account.logo_src} alt="" className="account-logo" />
              <h1 style={{ fontSize: 22 }}>{account.name}</h1>
              <Badge tone={typeMeta.tone}>{typeMeta.label}</Badge>
              {account.stage_name && <Badge dot={account.stage_color}>{account.stage_name}</Badge>}
              {account.segment_name && <Badge dot={account.segment_color}>{account.segment_name}</Badge>}
            </div>
            <div className="small muted row wrap" style={{ gap: 6, marginTop: 4 }}>
              {money && <span>{money}</span>}
              {account.department_name && <><span>·</span><span>{account.department_name}</span></>}
              <span>·</span>
              {account.state
                ? <span>{account.state}</span>
                : <span className="muted" title="Set it with Edit — it drives the state-wise view">no state recorded</span>}
              {account.source && <><span>·</span><span>from {account.source}</span></>}
              <span>·</span>
              <span>{liveDeals.length} live deal{liveDeals.length === 1 ? '' : 's'}</span>
            </div>
            <div className="clock-inline small">
              {CLOCKS.map((clock) => (
                <span key={clock.key} title={clock.hint}>
                  {clock.label}{' '}
                  <strong className={`clock-text clock-${clock.key === 'days_since_internal' ? 'neutral' : clockTone(account[clock.key])}`}>
                    {agoWords(account[clock.key])}
                  </strong>
                </span>
              ))}
            </div>
          </div>
          <div className="row wrap">
            {canEdit && mainDeal && (
              <select className="select" style={{ width: 'auto' }} value=""
                title={liveDeals.length > 1 ? `Moves ${mainDeal.name} — open Opportunities to move another deal` : undefined}
                onChange={(e) => e.target.value && moveStage(e.target.value)}>
                <option value="">{liveDeals.length > 1 ? 'Move main deal…' : 'Move stage…'}</option>
                {stages.filter((s) => s.id !== mainDeal.stage_id).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {canEdit && isLead && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => convert('CUSTOMER')}>
                Won → Customer
              </button>
            )}
            {canEdit && can('crm.activity.log') && (
              <button type="button" className="btn btn-sm" onClick={() => setRaiseSignal((n) => n + 1)}>
                <Icon name="alert" size={13} /> Raise a blocker
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
          <div className="grow" style={{ minWidth: 200 }}>
            <div className="stat-label">
              Next action{mainDeal && liveDeals.length > 1 ? ` · ${mainDeal.name}` : ''}
            </div>
            <div style={{ marginTop: 4 }}>
              {mainDeal ? <NextActionLine opportunity={mainDeal} /> : (
                <div className="small muted">No live deal — nothing is owed next.</div>
              )}
              {liveDeals.length > 1 && (
                <button type="button" className="btn-link small" onClick={() => setTab('opportunities')}>
                  {liveDeals.length - 1} more live deal{liveDeals.length === 2 ? '' : 's'}, each with its own next action
                </button>
              )}
            </div>
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
        {account.hq_address && (
          <div className="small muted row" style={{ gap: 6 }}>
            <Icon name="target" size={13} />
            <span>Office: {account.hq_address}{account.state ? `, ${account.state}` : ''}</span>
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

      <CrmBlockers account={account} opportunities={opportunities} compact
        raiseSignal={raiseSignal} onChanged={load} />

      {/* each deal shows its own on the Opportunities tab */}
      {openCommitments.length > 0 && tab !== 'opportunities' && (
        <section className="card card-pad">
          <CommitmentsPanel commitments={openCommitments} canEdit={canEdit && can('crm.activity.log')}
            onChanged={load} showDeal />
        </section>
      )}

      <div className="tabs tabs-scroll" role="tablist">
        {[
          ['overview', 'Overview'],
          ['dossier', 'Who they are'],
          ['people', `People${contacts.length ? ` (${contacts.length})` : ''}`],
          ['opportunities', `Opportunities${opportunities.length ? ` (${opportunities.length})` : ''}`],
          ['meetings', 'Meetings'],
          ['delivery', `Delivery${engagements.length ? ` (${engagements.length})` : ''}`],
          ['library', 'Links'],
          ['activity', 'Activity'],
          ['tasks', `Tasks${tasks.length ? ` (${tasks.length})` : ''}`],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'people' && (
        <CrmPeople
          accountId={account.id}
          contacts={contacts}
          opportunities={opportunities}
          canEdit={canEdit}
          onChanged={load}
        />
      )}

      {tab === 'opportunities' && (
        <CrmOpportunities
          accountId={account.id}
          opportunities={opportunities}
          stages={stages}
          canEdit={canEdit}
          relationshipOwnerId={account.owner_user_id}
          focusId={focusDeal}
          segmentTemplate={account.segment_scope_template || []}
          segmentName={account.segment_name}
          onChanged={load}
        />
      )}

      {tab === 'dossier' && (
        <AccountDossier
          account={account}
          locations={locations}
          canEdit={canEdit}
          onChanged={load}
        />
      )}

      {tab === 'meetings' && (
        <CrmMeetings
          accountId={account.id}
          opportunities={opportunities}
          contacts={contacts}
          canEdit={canEdit && can('crm.activity.log')}
          onChanged={load}
        />
      )}

      {tab === 'delivery' && (
        <CrmDelivery
          accountId={account.id}
          opportunities={opportunities}
          onChanged={load}
        />
      )}

      {tab === 'library' && (
        <CrmResources
          accountId={account.id}
          opportunities={opportunities}
          contacts={contacts}
          canEdit={canEdit && can('crm.create')}
          onChanged={load}
        />
      )}

      {tab === 'activity' && (
        <section className="card card-pad stack">
          <h2>Activity</h2>
          <Timeline activities={activities} />
        </section>
      )}

      {tab === 'overview' && (
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card card-pad stack">
          <h2>Recent activity</h2>
          <Timeline activities={activities.slice(0, 6)} />
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
                    <OutcomeBadge task={task} />
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
      )}

      {tab === 'tasks' && (
        <section className="card card-pad stack">
          <div className="row-between">
            <h2>Tasks</h2>
            {can('task.create') && (
              <button type="button" className="btn btn-sm" onClick={() => setAddingTask(true)}>
                <Icon name="plus" size={13} /> Add task
              </button>
            )}
          </div>
          <div className="small muted">
            The same task records as everywhere else — editing one here changes it in My Tasks too.
          </div>
          {tasks.length === 0 ? (
            <div className="small muted">No tasks yet. Work on this relationship shows up here.</div>
          ) : (
            <div className="stack-sm">
              {tasks.map((task) => {
                const due = dueLabel(task.due_date, { done: task.stage === 'done' });
                return (
                  <button key={task.id} type="button" className="link-row" onClick={() => setOpenTask(task.id)}>
                    <span className="task-ref">{task.ref}</span>
                    <span className="grow truncate">{task.title}</span>
                    {task.assignee_name && <Avatar name={task.assignee_name} color={task.assignee_color} size={20} />}
                    <OutcomeBadge task={task} />
                    <Badge tone={task.stage === 'done' ? 'good' : due.tone}>
                      {task.stage === 'done' ? 'Done' : due.text}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {editing && (
        <AccountDialog account={account} stages={stages} onClose={() => setEditing(false)} onSaved={load} />
      )}
      {logging && (
        <LogActivityDialog account={account} opportunities={opportunities} type={logging}
          onClose={() => setLogging(null)} onSaved={load} />
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
      {converting && (
        <ConvertDialog account={account} type={converting}
          onClose={() => setConverting(null)} onDone={load} />
      )}
      {moving && (
        <DealMoveDialog opportunity={moving.deal} stages={stages} initialStageId={moving.stageId}
          onClose={() => setMoving(null)} onMoved={load} />
      )}
    </div>
  );
}
