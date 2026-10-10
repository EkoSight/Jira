import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, CompanyLogo, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import CrmNudges from '../components/CrmNudges.jsx';
import CrmDashboard from '../components/CrmDashboard.jsx';
import DealMoveDialog from '../components/DealMoveDialog.jsx';
import { Clocks, NextActionLine } from '../components/DealParts.jsx';
import { ListView, MapView, TreeView } from '../components/CrmViews.jsx';
import { Correspondence, TeamReviews, WeekRecord, WeeklyReview } from '../components/CrmWeekly.jsx';
import {
  ACCOUNT_TYPE_META, INDIAN_STATES, OPPORTUNITY_STATUS_META, VALUE_BASIS_LABEL, formatMoney, waitingWords,
} from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/** Typing the expected value straight onto a deal that has none. */
function QuickValue({ deal, onSaved }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" className="value-missing"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="No value on this deal, so it adds nothing to the pipeline total">
        <Icon name="plus" size={10} /> Add expected value
      </button>
    );
  }

  const save = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (value === '' || Number(value) < 0) return;
    setSaving(true);
    try {
      await api.updateOpportunity(deal.id, { estimated_value: Number(value) });
      toast.success('Expected value saved on the deal');
      onSaved();
    } catch (err) {
      toast.error(err);
      setSaving(false);
    }
  };

  return (
    <form className="quick-value" onSubmit={save} onClick={(e) => e.stopPropagation()}>
      <span className="small muted">₹</span>
      <input className="input" type="number" min="0" autoFocus value={value}
        onChange={(e) => setValue(e.target.value)} placeholder="500000"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={saving || value === ''}>Save</button>
    </form>
  );
}

const RULE_SHORT = {
  proposal: 'a dated proposal',
  order: 'an accepted order',
  meeting_completed: 'a meeting that happened',
  contact: 'a named contact',
  value: 'a value',
  close_date: 'a close date',
  must_haves_met: 'must-haves met',
};

/** What a column checks, in a line under its name. */
const ruleNote = (stage) => [
  ...(stage.entry_rules || []).map((rule) => `In: ${RULE_SHORT[rule] || rule}`),
  ...(stage.exit_rules || []).map((rule) => `Out: ${RULE_SHORT[rule] || rule}`),
].join(' · ');

// the next-action flags have their own line on the card
const OWN_LINE = new Set(['no_next_action', 'no_next_action_owner', 'no_next_action_due', 'next_action_overdue']);

/** One live deal: what it is, who it is with, what happens next, and how fresh it is. */
function DealCard({ deal, stages, onOpen, onDragStart, onDragEnd, onMove, onChanged, canEdit, quietAfter }) {
  const money = formatMoney(deal.eligible_value, deal.currency);
  const otherFlags = deal.flags.filter((f) => !OWN_LINE.has(f.kind));
  const kind = ACCOUNT_TYPE_META[deal.account_kind];
  const stale = deal.next_action_gaps.length > 0;

  return (
    <div>
      <div
        className={`task-card deal-card${stale ? ' is-stale' : ''}${deal.open_blockers ? ' is-blocked' : ''}`}
        role="button"
        tabIndex={0}
        draggable
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="deal-org">
          <CompanyLogo src={deal.account_logo_src} name={deal.account_name} size={20} />
          <span className="truncate">{deal.account_name}</span>
          {kind && deal.account_kind !== 'LEAD' && <Badge tone={kind.tone}>{kind.label}</Badge>}
        </div>
        <div className="task-card-title">{deal.name}</div>
        <div className="task-card-meta">
          {money && (
            <Badge tone="brand" title={`Uses the ${VALUE_BASIS_LABEL[deal.eligible_basis] || 'recorded value'}`}>{money}</Badge>
          )}
          {!money && deal.eligible_basis === 'none' && canEdit && <QuickValue deal={deal} onSaved={onChanged} />}
          {!money && deal.eligible_basis !== 'none' && (
            <Badge tone="neutral">{VALUE_BASIS_LABEL[deal.eligible_basis]}</Badge>
          )}
          {deal.open_blockers > 0 && (
            <Badge tone="critical" title="Something is stopping this deal — open it to see and discuss">
              <Icon name="alert" size={10} /> {deal.open_blockers === 1 ? 'blocker' : `${deal.open_blockers} blockers`}
            </Badge>
          )}
          {deal.pending_handovers > 0 && (
            <Badge tone="warning" title="Handed to someone who has not yet confirmed they have it">handover unconfirmed</Badge>
          )}
          {deal.is_waiting && (
            <Badge tone={deal.revisit_due ? 'warning' : 'neutral'} title={deal.waiting_reason || undefined}>
              <Icon name="clock" size={10} /> {deal.revisit_due
                ? 'check back now'
                : `waiting on ${waitingWords(deal.waiting_on)} · ${formatDate(deal.waiting_until)}`}
            </Badge>
          )}
          {deal.overdue_commitments > 0 && (
            <Badge tone="warning" title="Something they said they would do is past its date">
              {deal.overdue_commitments === 1 ? 'commitment missed?' : `${deal.overdue_commitments} commitments late`}
            </Badge>
          )}
          <Clocks opportunity={deal} compact quietAfter={deal.stage_quiet_after_days || quietAfter} />
        </div>
        <NextActionLine opportunity={deal} compact />
        {otherFlags.length > 0 && (
          <div className="kr-flags">
            {otherFlags.slice(0, 2).map((flag) => (
              <span key={flag.kind} className="kr-flag kr-flag-warning">{flag.label}</span>
            ))}
            {otherFlags.length > 2 && <span className="kr-flag kr-flag-info">+{otherFlags.length - 2}</span>}
          </div>
        )}
        <div className="row-between">
          {deal.owner_name ? (
            <span className="row" style={{ gap: 6 }} title="Accountable for this deal">
              <Avatar name={deal.owner_name} color={deal.owner_color} size={20} />
              <span className="small muted truncate">{deal.owner_name}</span>
            </span>
          ) : <span className="kr-flag kr-flag-warning">Nobody owns it</span>}
          {deal.awaiting_customer && !deal.is_waiting && (
            <span className="small muted" title="We have followed up since they last responded">chased, no reply yet</span>
          )}
        </div>
      </div>
      {canEdit && (
        <select
          className="select card-move"
          value=""
          onChange={(e) => e.target.value && onMove(Number(e.target.value))}
          aria-label={`Move ${deal.name} to another stage`}
        >
          <option value="">Move to…</option>
          {stages.filter((s) => s.id !== deal.stage_id).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Things handed to me that I have not yet said I have. */
function HandoversWaiting({ onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [handovers, setHandovers] = useState([]);

  const load = useCallback(() => {
    api.myHandovers().then((r) => setHandovers(r.handovers)).catch(() => setHandovers([]));
  }, []);
  useEffect(load, [load]);

  if (!handovers.length) return null;

  const confirm = async (handover) => {
    try {
      await api.acknowledgeHandover(handover.id);
      toast.success(`Confirmed — ${handover.opportunity_name} is with you`);
      load();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const role = { OWNER: 'the deal', NEXT_ACTION: 'the next move', ESCALATION: 'escalations' };
  return (
    <section className="card card-pad stack-sm handover-strip">
      <div className="small" style={{ fontWeight: 650 }}>
        Handed to you — confirm you have {handovers.length === 1 ? 'it' : 'them'}
      </div>
      {handovers.map((h) => (
        <div key={h.id} className="handover-row">
          <button type="button" className="btn-link grow truncate"
            onClick={() => navigate(`/accounts/${h.account_id}?deal=${h.opportunity_id}`)}>
            {h.opportunity_name} <span className="muted">· {h.account_name}</span>
          </button>
          <span className="small muted">
            {role[h.role]}{h.from_name ? ` from ${h.from_name}` : ''}{h.owed ? ` · owed: ${h.owed}` : ''}
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => confirm(h)}>I have it</button>
        </div>
      ))}
    </section>
  );
}

export default function Pipeline() {
  const { user, can } = useAuth();
  const { departments, users, settings } = useRefData();
  const toast = useToast();
  const navigate = useNavigate();

  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [ownerFilter, setOwnerFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [mine, setMine] = useState(false);
  const [owedByMe, setOwedByMe] = useState(false);
  const [segments, setSegments] = useState([]);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [onlyNoValue, setOnlyNoValue] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const [moving, setMoving] = useState(null);
  // board, list, map, tree and dashboard are five ways of reading one dataset;
  // the week, the reviews and the correspondence inbox are the weekly rhythm
  const [view, setView] = useState('board');
  const [reviewScope, setReviewScope] = useState('mine');
  const [pending, setPending] = useState(0);
  const weekly = view === 'week' || view === 'review' || view === 'inbox';
  const canSeeTeam = can('crm.manage.any') || can('report.view');

  useEffect(() => {
    api.crmSuggestions().then((r) => setPending(r.suggestions.length)).catch(() => setPending(0));
  }, []);

  const filters = useMemo(
    () => ({
      owner_id: ownerFilter || undefined,
      department_id: departmentFilter || undefined,
      mine: mine ? 'true' : undefined,
      next_owner_id: owedByMe ? user?.id : undefined,
      state: stateFilter || undefined,
      account_type: typeFilter || undefined,
    }),
    [ownerFilter, departmentFilter, mine, owedByMe, user?.id, stateFilter, typeFilter],
  );

  const load = useCallback(() => {
    setLoading(true);
    api.dealBoard(filters).then(setBoard).catch((err) => toast.error(err)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(load, [load]);

  useEffect(() => {
    api.crmSegments().then((r) => setSegments(r.segments)).catch(() => setSegments([]));
  }, []);

  const startMove = (deal, stageId) => {
    if (deal.stage_id === stageId) return;
    // every move goes through the dialog: it asks for the evidence the stage
    // needs and confirms what happens next, which is the moment the old next
    // step stops being true
    setMoving({ deal, stageId });
  };

  if (loading && !board) return <Spinner label="Loading the pipeline" />;
  if (!board) return <EmptyState title="Could not load the pipeline" />;

  const quietAfter = settings?.crm?.cadence?.engagementDays || 7;
  const visible = (deals) => deals.filter((d) => (!onlyNoValue || d.eligible_basis === 'none')
    && (!onlyAttention || d.flags.length > 0));
  const canMove = can('crm.activity.log');

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>B2B Pipeline</h1>
          <div className="small muted row wrap" style={{ gap: 6 }}>
            <span>
              {board.total} live deal{board.total === 1 ? '' : 's'} across {board.organizations} organization
              {board.organizations === 1 ? '' : 's'}
              {board.eligible_value > 0
                ? ` · ${formatMoney(board.eligible_value)} expected from live deals`
                : ' · no expected values recorded yet'}
            </span>
            {board.needs_attention > 0 && (
              <button type="button"
                className={`kind-chip${onlyAttention ? ' is-active' : ''}`}
                title="Deals missing a next action, an owner, or something their stage expects"
                onClick={() => { setOnlyAttention((v) => !v); setView('board'); }}>
                {board.needs_attention} need attention{onlyAttention ? ' — showing only these' : ''}
              </button>
            )}
            {board.deals_without_value > 0 && (
              <button type="button"
                className={`kind-chip${onlyNoValue ? ' is-active' : ''}`}
                title="Deals with no value recorded. They add nothing to the total until they do."
                onClick={() => { setOnlyNoValue((v) => !v); setView('board'); }}>
                {board.deals_without_value} with no value{onlyNoValue ? ' — showing only these' : ''}
              </button>
            )}
          </div>
        </div>
        {can('crm.create') && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New lead
          </button>
        )}
      </div>

      <HandoversWaiting onChanged={load} />

      {!weekly && (
      <div className="filters">
        <button type="button" className={`btn btn-sm${mine ? ' btn-primary' : ''}`}
          title="Deals you own, owe the next move on, are the escalation point for, or help with"
          onClick={() => setMine((v) => !v)}>
          Mine
        </button>
        <button type="button" className={`btn btn-sm${owedByMe ? ' btn-primary' : ''}`}
          title="Deals where the next move is yours"
          onClick={() => setOwedByMe((v) => !v)}>
          Owed by me
        </button>
        <select className="select" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
          aria-label="Filter by deal owner">
          <option value="">Any deal owner</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name}</option>
          ))}
        </select>
        <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by kind of organization">
          <option value="">All organizations</option>
          <option value="LEAD">Leads only</option>
          <option value="CUSTOMER">Customers only</option>
          <option value="PARTNER">Partners only</option>
        </select>
        <select className="select" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        {(view === 'board' || view === 'list') && (
          <select className="select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}
            aria-label="Filter by state">
            <option value="">Every state</option>
            <option value="none">No state recorded</option>
            {INDIAN_STATES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        {(view === 'map' || view === 'dashboard') && segments.length > 0 && (
          <select className="select" value={segmentFilter}
            onChange={(e) => setSegmentFilter(e.target.value)}>
            <option value="">Every kind of partner</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        {view === 'list' && (
          <input className="input" style={{ maxWidth: 220 }} placeholder="Search the list"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        )}
      </div>
      )}

      <div className="tabs tabs-scroll" role="tablist">
        {[
          ['board', 'Board'],
          ['list', 'List'],
          ['map', 'States & map'],
          ['tree', 'Who leads what'],
          ['dashboard', 'Dashboard'],
          ['week', 'This week'],
          ['review', 'Weekly review'],
          ['inbox', pending ? `Correspondence (${pending})` : 'Correspondence'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={`tab${view === key ? ' active' : ''}`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* on the board the nudges lead; elsewhere the view you chose does, and
          they follow it */}
      {view === 'board' && <CrmNudges departmentId={departmentFilter} compact />}

      {view === 'list' && <ListView board={board} search={search} />}
      {view === 'map' && (
        <MapView departmentId={departmentFilter} segmentId={segmentFilter} ownerId={ownerFilter} />
      )}
      {view === 'tree' && <TreeView departmentId={departmentFilter} />}
      {view === 'dashboard' && (
        <CrmDashboard departmentId={departmentFilter} ownerId={ownerFilter}
          segmentId={segmentFilter} />
      )}

      {view === 'week' && <WeekRecord />}
      {view === 'review' && (
        <div className="stack" style={{ gap: 12 }}>
          {canSeeTeam && (
            <div className="row" style={{ gap: 6 }} role="group" aria-label="Whose reviews">
              <button type="button" className={`kind-chip${reviewScope === 'mine' ? ' is-active' : ''}`}
                onClick={() => setReviewScope('mine')}>My review</button>
              <button type="button" className={`kind-chip${reviewScope === 'team' ? ' is-active' : ''}`}
                onClick={() => setReviewScope('team')}>Everyone’s</button>
            </div>
          )}
          {canSeeTeam && reviewScope === 'team' ? <TeamReviews departmentId={departmentFilter} /> : <WeeklyReview />}
        </div>
      )}
      {view === 'inbox' && <Correspondence onCount={setPending} />}

      {view !== 'board' && view !== 'dashboard' && !weekly && (
        <CrmNudges departmentId={departmentFilter} />
      )}

      {view === 'board' && board.misplaced.length > 0 && (
        <div className="ask-banner ask-warning">
          <Icon name="alert" size={15} />
          <div className="grow small">
            <strong>{board.misplaced.length} live deal{board.misplaced.length === 1 ? ' sits' : 's sit'} in a closed stage or none</strong>
            {' — '}
            {board.misplaced.map((d, index) => (
              <span key={d.id}>
                {index > 0 && ', '}
                <button type="button" className="btn-link"
                  onClick={() => navigate(`/accounts/${d.account_id}?deal=${d.id}`)}>{d.name}</button>
              </span>
            ))}
            . Open each and move it to the stage it is really in.
          </div>
        </div>
      )}

      {view === 'board' && (
      <div className="board-scroll">
        {board.stages.map((stage) => (
          <section
            key={stage.id}
            className={`board-col ${dropTarget === stage.id ? 'drop-target' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget(stage.id);
            }}
            onDragLeave={() => setDropTarget((c) => (c === stage.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              if (dragging && canMove) startMove(dragging, stage.id);
            }}
          >
            <header className="board-col-head">
              <span className="badge-dot" style={{ background: stage.color }} />
              <span className="board-col-title">{stage.name}</span>
              <span className="board-col-count tnum">{stage.deals.length}</span>
              {stage.eligible_value > 0 && <span className="small muted" style={{ marginLeft: 'auto' }}>{formatMoney(stage.eligible_value)}</span>}
            </header>
            {ruleNote(stage) && (
              <div className="stage-rule-note small muted" title="Checked whenever a deal moves forward">
                {ruleNote(stage)}
              </div>
            )}
            <div className="board-col-body">
              {visible(stage.deals).length === 0 && <div className="small muted center" style={{ padding: 14 }}>Empty</div>}
              {visible(stage.deals).map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  stages={board.all_stages}
                  canEdit={canMove}
                  quietAfter={quietAfter}
                  onChanged={load}
                  onOpen={() => navigate(`/accounts/${deal.account_id}?deal=${deal.id}`)}
                  onMove={(stageId) => startMove(deal, stageId)}
                  onDragStart={() => setDragging(deal)}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      )}

      {view === 'board' && (board.paused.length > 0 || board.closed.some((s) => s.count > 0)) && (
        <div className="stack-sm">
          <div className="row wrap" style={{ gap: 8 }}>
            {board.closed.map((stage) => (
              <Badge key={stage.id} dot={stage.color}>
                {stage.name}: {stage.count}
              </Badge>
            ))}
            {board.paused.length > 0 && (
              <button type="button" className={`kind-chip${showPaused ? ' is-active' : ''}`}
                onClick={() => setShowPaused((v) => !v)}>
                {board.paused.length} paused or nurtured
              </button>
            )}
            <span className="small muted">won, lost and paused deals stay on their organization, off the live board</span>
          </div>
          {showPaused && (
            <div className="stack-sm">
              {board.paused.map((deal) => {
                const status = OPPORTUNITY_STATUS_META[deal.status] || OPPORTUNITY_STATUS_META.ACTIVE;
                return (
                  <button key={deal.id} type="button" className="link-row"
                    onClick={() => navigate(`/accounts/${deal.account_id}?deal=${deal.id}`)}>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="grow truncate">{deal.name} <span className="muted">· {deal.account_name}</span></span>
                    <span className="small muted">
                      {deal.revisit_on ? `revisit ${formatDate(deal.revisit_on)}` : 'no revisit date'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {moving && (
        <DealMoveDialog
          opportunity={moving.deal}
          stages={board.all_stages}
          initialStageId={moving.stageId}
          onClose={() => setMoving(null)}
          onMoved={load}
        />
      )}

      {creating && (
        <AccountDialog
          stages={board.all_stages.filter((s) => s.kind === 'open')}
          onClose={() => setCreating(false)}
          onSaved={(account) => navigate(`/accounts/${account.id}`)}
        />
      )}
    </div>
  );
}
