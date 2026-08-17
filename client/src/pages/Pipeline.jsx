import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import AccountDialog from '../components/AccountDialog.jsx';
import { ACCOUNT_TYPE_META, crmSignalMeta, formatMoney, freshnessLabel } from '../lib/crm.js';

function NudgeStrip({ insights, onRunScan, canScan }) {
  const [scanning, setScanning] = useState(false);
  if (!insights || insights.summary.total_signals === 0) {
    return (
      <section className="card card-pad attention-clear">
        <div className="row" style={{ gap: 10 }}>
          <span className="sig-dot sig-good" aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 650 }}>Every lead is being worked</div>
            <div className="small muted">Nothing has stalled or gone cold. Keep it up.</div>
          </div>
        </div>
      </section>
    );
  }

  const run = async () => {
    setScanning(true);
    try {
      await onRunScan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Needs a nudge</h2>
          <div className="small muted">
            {insights.summary.stalled > 0 && <span className="crit-count">{insights.summary.stalled} stalled</span>}
            {insights.summary.stalled > 0 && insights.summary.cold > 0 && ' · '}
            {insights.summary.cold > 0 && `${insights.summary.cold} going cold`}
            {insights.summary.no_next_step > 0 && ` · ${insights.summary.no_next_step} with no next step`}
          </div>
        </div>
        {canScan && (
          <button type="button" className="btn btn-sm" onClick={run} disabled={scanning}>
            <Icon name="bell" size={13} /> {scanning ? 'Sending…' : 'Remind owners now'}
          </button>
        )}
      </div>
      <div className="stack-sm">
        {insights.attention.slice(0, 6).map((signal) => {
          const meta = crmSignalMeta(signal.kind);
          return (
            <Link key={signal.account_id} to={`/accounts/${signal.account_id}`} className="sig-row">
              <span className={`sig-dot sig-${signal.severity}`} aria-hidden="true" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }} className="truncate">{signal.title}</span>
                  <Badge tone={signal.severity === 'critical' ? 'critical' : 'warning'}>{meta.label}</Badge>
                </div>
                <div className="small muted">{signal.stage_name} — {signal.detail}</div>
              </div>
              {signal.owner_name && <Avatar name={signal.owner_name} color={signal.owner_color} size={22} />}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

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
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [ownerFilter, setOwnerFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [mine, setMine] = useState(false);

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
    api.crmInsights({ owner_id: ownerFilter || undefined, department_id: departmentFilter || undefined })
      .then(setInsights).catch(() => setInsights(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(load, [load]);

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

  const runScan = async () => {
    try {
      const result = await api.runCrmScan();
      toast.success(
        result.notified?.length
          ? `Reminded ${result.notified.length} ${result.notified.length === 1 ? 'person' : 'people'}`
          : 'Everyone has already been reminded today',
      );
    } catch (err) {
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
          <h1>Pipeline</h1>
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
      </div>

      <NudgeStrip insights={insights} onRunScan={runScan} canScan={can('settings.manage')} />

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

      {closedStages.some((s) => s.accounts.length > 0) && (
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
