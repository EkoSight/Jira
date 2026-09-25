import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import CrmNudges from '../components/CrmNudges.jsx';
import CrmDashboard from '../components/CrmDashboard.jsx';
import { ListView, MapView, TreeView } from '../components/CrmViews.jsx';
import { crmSignalMeta, formatMoney, freshnessLabel } from '../lib/crm.js';

function AccountCard({ account, onOpen, onDragStart, onDragEnd, stages, onMove }) {
  const fresh = freshnessLabel(account.days_since_activity);
  const money = formatMoney(account.value, account.currency);
  return (
    <div>
      <div
        className={`task-card account-card${account.days_since_stage_change >= 7 ? ' is-stalled' : ''}`}
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
          {money && <Badge tone="brand">{money}</Badge>}
          {account.open_task_count > 0 && (
            <Badge tone="neutral" title="Open tasks"><Icon name="list" size={10} /> {account.open_task_count}</Badge>
          )}
          <Badge tone={fresh.tone}>{fresh.text}</Badge>
        </div>
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
  // board, list, map, tree and dashboard are five ways of reading one dataset
  const [view, setView] = useState('board');

  const filters = useMemo(
    () => ({
      owner_id: ownerFilter || undefined,
      department_id: departmentFilter || undefined,
      mine: mine ? 'true' : undefined,
    }),
    [ownerFilter, departmentFilter, mine],
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
  const totalValue = openStages.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>B2B Pipeline</h1>
          <div className="small muted">
            {board.total} open lead{board.total === 1 ? '' : 's'}
            {formatMoney(totalValue) && ` · ${formatMoney(totalValue)} in play`}
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
          ['map', 'Map'],
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
      {view === 'map' && <MapView departmentId={departmentFilter} segmentId={segmentFilter} />}
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
              {formatMoney(stage.value) && <span className="small muted" style={{ marginLeft: 'auto' }}>{formatMoney(stage.value)}</span>}
            </header>
            <div className="board-col-body">
              {stage.accounts.length === 0 && <div className="small muted center" style={{ padding: 14 }}>Empty</div>}
              {stage.accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  stages={board.stages}
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
