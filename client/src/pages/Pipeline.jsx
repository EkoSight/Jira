import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import CrmNudges from '../components/CrmNudges.jsx';
import CrmDashboard from '../components/CrmDashboard.jsx';
import { ListView, MapView, TreeView } from '../components/CrmViews.jsx';
import { SettleDialog } from '../components/LeadMoveDialogs.jsx';
import { INDIAN_STATES, formatMoney, freshnessLabel } from '../lib/crm.js';

/** Typing the expected revenue straight onto a card that has none. */
function QuickValue({ account, onSaved }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" className="value-missing"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="No expected revenue on this lead's open deals, so it adds nothing to the pipeline total">
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
      await api.updateAccount(account.id, { value: Number(value) });
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

function AccountCard({ account, onOpen, onDragStart, onDragEnd, stages, onMove, onChanged, canEdit }) {
  const fresh = freshnessLabel(account.days_since_activity);
  // what its open deals are worth by the forecast's rules — every open deal,
  // not only the headline one, and never a non-commercial pilot
  const money = formatMoney(account.eligible_value, account.currency);
  return (
    <div>
      <div
        className={`task-card account-card${account.days_since_stage_change >= 7 ? ' is-stalled' : ''}${account.open_blockers ? ' is-blocked' : ''}`}
        role="button"
        tabIndex={0}
        draggable
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="task-card-title">{account.name}</div>
        <div className="task-card-meta">
          {money && (
            <Badge tone="brand" title={account.open_deals > 1 ? `${account.open_deals} open deals` : 'Expected from the open deal'}>
              {money}
            </Badge>
          )}
          {!money && account.deals_without_value > 0 && canEdit && (
            <QuickValue account={account} onSaved={onChanged} />
          )}
          {!money && account.deals_without_value > 0 && !canEdit && (
            <Badge tone="neutral">no value yet</Badge>
          )}
          {!money && !account.deals_without_value && account.non_commercial_deals > 0 && (
            <Badge tone="neutral" title="Unpaid pilots, CSR projects and partnerships add nothing to the pipeline value">
              not commercial
            </Badge>
          )}
          {account.open_blockers > 0 && (
            <Badge tone="critical" title="Something is stopping this lead — open it to see and discuss">
              <Icon name="alert" size={10} /> {account.open_blockers === 1 ? 'blocker' : `${account.open_blockers} blockers`}
            </Badge>
          )}
          {account.open_task_count > 0 && (
            <Badge tone="neutral" title="Open tasks"><Icon name="list" size={10} /> {account.open_task_count}</Badge>
          )}
          <Badge tone={fresh.tone}>{fresh.text}</Badge>
        </div>
        {account.state && <div className="small muted truncate">{account.state}</div>}
        {account.next_step && <div className="small muted truncate">Next: {account.next_step}</div>}
        <div className="row-between">
          {account.owner_name ? (
            <span className="row" style={{ gap: 6 }}>
              <Avatar name={account.owner_name} color={account.owner_color} size={20} />
              <span className="small muted truncate">{account.owner_name}</span>
            </span>
          ) : <span className="small muted">Unowned</span>}
          {account.follower_name && (
            <Avatar name={account.follower_name} color={account.follower_color} size={18} title={`Following: ${account.follower_name}`} />
          )}
        </div>
      </div>
      <select
        className="select card-move"
        value=""
        onChange={(e) => e.target.value && onMove(Number(e.target.value))}
        aria-label={`Move ${account.name} to another stage`}
      >
        <option value="">Move to…</option>
        {stages.filter((s) => s.id !== account.stage_id).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}

export default function Pipeline() {
  const { user, can } = useAuth();
  const { departments, users } = useRefData();
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
  const [mine, setMine] = useState(false);
  const [segments, setSegments] = useState([]);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [onlyNoValue, setOnlyNoValue] = useState(false);
  const [settling, setSettling] = useState(null);
  // board, list, map, tree and dashboard are five ways of reading one dataset
  const [view, setView] = useState('board');

  const filters = useMemo(
    () => ({
      owner_id: ownerFilter || undefined,
      department_id: departmentFilter || undefined,
      mine: mine ? 'true' : undefined,
      state: stateFilter || undefined,
    }),
    [ownerFilter, departmentFilter, mine, stateFilter],
  );

  const load = useCallback(() => {
    setLoading(true);
    api.pipeline(filters).then(setBoard).catch((err) => toast.error(err)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(load, [load]);

  useEffect(() => {
    api.crmSegments().then((r) => setSegments(r.segments)).catch(() => setSegments([]));
  }, []);

  const move = async (account, stageId) => {
    if (account.stage_id === stageId) return;
    // won and lost ask their question first: why it was lost, what was agreed
    const target = board.stages.find((s) => s.id === stageId);
    if (target && target.kind !== 'open') {
      setSettling({ account, stage: target });
      return;
    }
    const previous = board;
    // optimistic: pull the card out of its column into the new one
    setBoard((current) => ({
      ...current,
      stages: current.stages.map((s) => ({
        ...s,
        accounts:
          s.id === stageId
            ? [{ ...account, stage_id: stageId }, ...s.accounts.filter((a) => a.id !== account.id)]
            : s.accounts.filter((a) => a.id !== account.id),
      })),
    }));
    try {
      await api.moveAccountStage(account.id, stageId);
      load();
    } catch (err) {
      setBoard(previous);
      toast.error(err);
    }
  };

  if (loading && !board) return <Spinner label="Loading the pipeline" />;
  if (!board) return <EmptyState title="Could not load the pipeline" />;

  const openStages = board.stages.filter((s) => s.kind === 'open');
  const closedStages = board.stages.filter((s) => s.kind !== 'open');
  const totalValue = board.eligible_value ?? 0;
  // the "no value yet" filter narrows the board to the cards that need a number
  const visible = (accounts) => (onlyNoValue
    ? accounts.filter((a) => a.eligible_value === null && a.deals_without_value > 0)
    : accounts);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>B2B Pipeline</h1>
          <div className="small muted row wrap" style={{ gap: 6 }}>
            <span>
              {board.total} open lead{board.total === 1 ? '' : 's'}
              {formatMoney(totalValue) && ` · ${formatMoney(totalValue)} expected from open deals`}
            </span>
            {board.leads_without_value > 0 && (
              <button type="button"
                className={`kind-chip${onlyNoValue ? ' is-active' : ''}`}
                title="Leads whose open deals have no expected revenue. They add nothing to the total until they do."
                onClick={() => { setOnlyNoValue((v) => !v); setView('board'); }}>
                {board.leads_without_value} with no expected value{onlyNoValue ? ' — showing only these' : ''}
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

      <div className="filters">
        <button
          type="button"
          className={`btn btn-sm${mine ? ' btn-primary' : ''}`}
          onClick={() => setMine((v) => !v)}
        >
          Mine
        </button>
        <select className="select" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="">Anyone leading</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name}</option>
          ))}
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

      <div className="tabs tabs-scroll" role="tablist">
        {[
          ['board', 'Board'],
          ['list', 'List'],
          ['map', 'States & map'],
          ['tree', 'Who leads what'],
          ['dashboard', 'Dashboard'],
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

      {view !== 'board' && view !== 'dashboard' && (
        <CrmNudges departmentId={departmentFilter} />
      )}

      {view === 'board' && (
      <div className="board-scroll">
        {openStages.map((stage) => (
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
              if (dragging) move(dragging, stage.id);
            }}
          >
            <header className="board-col-head">
              <span className="badge-dot" style={{ background: stage.color }} />
              <span className="board-col-title">{stage.name}</span>
              <span className="board-col-count tnum">{stage.accounts.length}</span>
              {stage.eligible_value > 0 && <span className="small muted" style={{ marginLeft: 'auto' }}>{formatMoney(stage.eligible_value)}</span>}
            </header>
            <div className="board-col-body">
              {visible(stage.accounts).length === 0 && <div className="small muted center" style={{ padding: 14 }}>Empty</div>}
              {visible(stage.accounts).map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  stages={board.stages}
                  canEdit={can('crm.activity.log')}
                  onChanged={load}
                  onOpen={() => navigate(`/accounts/${account.id}`)}
                  onMove={(stageId) => move(account, stageId)}
                  onDragStart={() => setDragging(account)}
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

      {view === 'board' && closedStages.some((s) => s.accounts.length > 0) && (
        <div className="row wrap" style={{ gap: 8 }}>
          {closedStages.map((stage) => (
            <Badge key={stage.id} dot={stage.color}>
              {stage.name}: {stage.accounts.length}
            </Badge>
          ))}
          <span className="small muted">won and lost deals stay on the account, off the active board</span>
        </div>
      )}

      {settling && (
        <SettleDialog account={settling.account} stage={settling.stage}
          onClose={() => setSettling(null)} onDone={load} />
      )}

      {creating && (
        <AccountDialog
          stages={openStages}
          onClose={() => setCreating(false)}
          onSaved={(account) => navigate(`/accounts/${account.id}`)}
        />
      )}
    </div>
  );
}
