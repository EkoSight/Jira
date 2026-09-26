import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from './ui.jsx';
import { FOLLOW_UP_META, POTENTIAL_META, formatMoney, freshnessLabel } from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/**
 * Three more ways of looking at the same set of organizations.
 *
 * Board, list, map and tree read the same authorized records through the same
 * filters — they are four views of one dataset, not four datasets. Switching view
 * never changes what you are allowed to see.
 */

// ---------------------------------------------------------------- list

const COLUMNS = [
  { key: 'name', label: 'Organization', get: (a) => a.name },
  { key: 'stage_name', label: 'Stage', get: (a) => a.stage_name || '' },
  { key: 'state', label: 'State', get: (a) => a.state || '' },
  { key: 'eligible_value', label: 'Expected', get: (a) => a.eligible_value ?? -1, numeric: true },
  { key: 'owner_name', label: 'Leading it', get: (a) => a.owner_name || '' },
  { key: 'days_since_activity', label: 'Last worked', get: (a) => a.days_since_activity ?? 9999, numeric: true },
  { key: 'next_step_due', label: 'Next action', get: (a) => a.next_step_due || '' },
];

export function ListView({ board, search }) {
  const [sort, setSort] = useState({ key: 'days_since_activity', dir: 'desc' });

  const rows = useMemo(() => {
    const all = board.stages.flatMap((stage) =>
      stage.accounts.map((a) => ({ ...a, stage_name: a.stage_name || stage.name })));
    const term = search.trim().toLowerCase();
    const filtered = term
      ? all.filter((a) => a.name.toLowerCase().includes(term)
        || (a.owner_name || '').toLowerCase().includes(term)
        || (a.next_step || '').toLowerCase().includes(term))
      : all;
    const column = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[0];
    return [...filtered].sort((a, b) => {
      const left = column.get(a);
      const right = column.get(b);
      const cmp = column.numeric
        ? left - right
        : String(left).localeCompare(String(right));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [board, search, sort]);

  const toggle = (key) => setSort((current) =>
    current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });

  if (rows.length === 0) {
    return <EmptyState title={search ? 'Nothing matches' : 'No organizations'} />;
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key}>
                <button type="button" className="th-sort" onClick={() => toggle(column.key)}>
                  {column.label}
                  {sort.key === column.key && (
                    <Icon name="chevron" size={11}
                      style={{ transform: sort.dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((account) => {
            const fresh = freshnessLabel(account.days_since_activity);
            return (
              <tr key={account.id}>
                <td>
                  <Link to={`/accounts/${account.id}`} className="btn-link">{account.name}</Link>
                  {account.segment_name && (
                    <div className="small muted">{account.segment_name}</div>
                  )}
                </td>
                <td><Badge dot={account.stage_color}>{account.stage_name}</Badge></td>
                <td className="small">{account.state || <span className="muted">not recorded</span>}</td>
                <td className="tnum">
                  {formatMoney(account.eligible_value, account.currency)
                    || <span className="muted small">{account.deals_without_value ? 'no value yet' : '—'}</span>}
                  {account.open_blockers > 0 && (
                    <div><Badge tone="critical">{account.open_blockers === 1 ? 'blocker' : `${account.open_blockers} blockers`}</Badge></div>
                  )}
                </td>
                <td>
                  {account.owner_name ? (
                    <span className="row" style={{ gap: 5 }}>
                      <Avatar name={account.owner_name} color={account.owner_color} size={20} />
                      <span className="small">{account.owner_name}</span>
                    </span>
                  ) : <span className="small muted">Unowned</span>}
                </td>
                <td><Badge tone={fresh.tone}>{fresh.text}</Badge></td>
                <td>
                  {account.next_step ? (
                    <>
                      <div className="small truncate" style={{ maxWidth: 220 }}>{account.next_step}</div>
                      {account.next_step_due && (
                        <Badge tone={account.next_step_overdue ? 'critical' : 'neutral'}>
                          {formatDate(account.next_step_due)}
                        </Badge>
                      )}
                    </>
                  ) : <span className="small muted">none set</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- map

/**
 * Where they are.
 *
 * Plotted from coordinates somebody entered by hand. Nothing is geocoded, so an
 * organization with no coordinates is listed underneath as unmapped rather than
 * being dropped or guessed onto a spot it is not.
 *
 * The plot is a plain equirectangular projection of India's bounding box — enough
 * to see clustering, and honest about being approximate. It is drawn in SVG rather
 * than loading a tile service, so no address leaves this network.
 */
const BOX = { minLat: 6, maxLat: 37.5, minLon: 68, maxLon: 97.5 };

/**
 * A coarse outline of mainland India, in [lon, lat].
 *
 * Roughly forty points — enough to tell Gujarat from Odisha at a glance and no
 * more. It is here so a pin has something to sit against; it is not a survey
 * boundary and the caption says so.
 */
const OUTLINE = [
  [74.0, 34.5], [76.5, 35.3], [78.5, 34.5], [79.0, 32.5], [80.2, 30.5], [81.5, 30.4],
  [83.0, 29.2], [85.0, 28.0], [88.0, 27.5], [88.9, 27.3], [89.2, 26.8], [92.0, 26.9],
  [94.5, 27.6], [96.5, 27.3], [97.4, 28.2], [97.3, 26.5], [95.2, 26.6], [94.6, 25.2],
  [93.4, 24.0], [92.6, 22.2], [91.5, 22.8], [89.1, 21.9], [87.0, 21.5], [85.0, 19.5],
  [82.3, 17.0], [80.3, 15.9], [80.0, 13.5], [79.9, 11.5], [77.5, 8.1], [76.5, 9.0],
  [75.0, 12.0], [73.5, 15.5], [72.8, 19.0], [72.6, 21.5], [69.0, 22.2], [68.5, 23.8],
  [70.5, 24.0], [71.0, 27.0], [73.0, 29.5], [74.5, 31.0], [75.5, 32.5],
];

const ACTIVITY_ORDER = { inactive: 0, active: 1, paused: 2, closed: 3 };
const POTENTIAL_ORDER = { high: 0, medium: 1, low: 2, unknown: 3 };

const spokenLabel = (days) => {
  if (days === null || days === undefined) return 'never spoken to';
  if (days === 0) return 'spoken to today';
  if (days === 1) return 'spoken to yesterday';
  return `spoken to ${days} days ago`;
};

/** A row of toggles: which kinds of lead to show. */
function ChipSet({ meta, counts, selected, onToggle, label }) {
  return (
    <div className="row wrap" style={{ gap: 6 }} role="group" aria-label={label}>
      {Object.entries(meta).map(([key, m]) => (
        <button key={key} type="button" aria-pressed={selected.has(key)}
          className={`kind-chip${selected.has(key) ? ' is-active' : ''}`}
          onClick={() => onToggle(key)}>
          {m.dotColor && <span className="chip-dot" style={{ background: m.dotColor }} />}
          {m.label} ({counts[key] ?? 0})
        </button>
      ))}
    </div>
  );
}

/**
 * Where the leads are, state by state, and who to follow up with.
 *
 * Grouped by the state recorded on each lead — not by map pins — so a lead that
 * nobody has put coordinates on is still in its state's list, and a lead with no
 * state at all is a group of its own rather than a gap. The map shows only the
 * pins somebody entered; nothing is geocoded and nothing is guessed.
 *
 * "Needs follow-up" and "lower potential" are rules, not opinions, and the rules
 * are one click away on the same screen.
 */
export function MapView({ departmentId, segmentId, ownerId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [hover, setHover] = useState(null);
  const [state, setState] = useState('');
  const [activity, setActivity] = useState(() => new Set(['inactive', 'active', 'paused']));
  const [potential, setPotential] = useState(() => new Set(['high', 'medium', 'low', 'unknown']));
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    setData(null);
    api.crmStates({
      department_id: departmentId || undefined,
      segment_id: segmentId || undefined,
      owner_id: ownerId || undefined,
    }).then(setData).catch((err) => toast.error(err));
  }, [departmentId, segmentId, ownerId]);

  const inState = useMemo(() => {
    if (!data) return [];
    if (state === '') return data.leads;
    if (state === 'none') return data.leads.filter((l) => !l.state);
    return data.leads.filter((l) => (l.state || '').toLowerCase() === state.toLowerCase());
  }, [data, state]);

  const shown = useMemo(() => inState
    .filter((l) => activity.has(l.activity) && potential.has(l.potential))
    .sort((a, b) => ACTIVITY_ORDER[a.activity] - ACTIVITY_ORDER[b.activity]
      || POTENTIAL_ORDER[a.potential] - POTENTIAL_ORDER[b.potential]
      || (b.days_since_spoken ?? 9999) - (a.days_since_spoken ?? 9999)
      || a.name.localeCompare(b.name)), [inState, activity, potential]);

  if (!data) return <Spinner label="Sorting leads by state" />;

  const count = (key, field) => inState.filter((l) => l[field] === key).length;
  const activityCounts = Object.fromEntries(Object.keys(FOLLOW_UP_META).map((k) => [k, count(k, 'activity')]));
  const potentialCounts = Object.fromEntries(Object.keys(POTENTIAL_META).map((k) => [k, count(k, 'potential')]));
  const toggle = (setter) => (key) => setter((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const project = (lat, lon) => ({
    x: ((lon - BOX.minLon) / (BOX.maxLon - BOX.minLon)) * 100,
    y: ((BOX.maxLat - lat) / (BOX.maxLat - BOX.minLat)) * 100,
  });
  const pins = shown.flatMap((lead) => (lead.pins || []).map((pin) => ({
    ...project(Number(pin.latitude), Number(pin.longitude)), lead, pin,
  }))).filter((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100);
  const placedLeads = new Set(pins.map((p) => p.lead.id)).size;
  const followUps = shown.filter((l) => l.activity === 'inactive').length;

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <label className="stack-sm" style={{ gap: 4 }}>
          <span className="stat-label">State</span>
          <select className="select" style={{ minWidth: 220 }} value={state}
            onChange={(e) => setState(e.target.value)}>
            <option value="">Every state ({data.leads.length})</option>
            {data.states.filter((g) => g.state).map((g) => (
              <option key={g.state} value={g.state}>{g.state} ({g.total})</option>
            ))}
            {data.states.some((g) => !g.state) && (
              <option value="none">
                No state recorded ({data.states.find((g) => !g.state).total})
              </option>
            )}
          </select>
        </label>
        <button type="button" className="btn-link small" onClick={() => setShowRules((v) => !v)}>
          {showRules ? 'Hide' : 'What do these mean?'}
        </button>
      </div>

      <ChipSet label="How they are being worked" meta={Object.fromEntries(Object.entries(FOLLOW_UP_META)
        .map(([k, m]) => [k, { ...m, dotColor: m.color }]))}
        counts={activityCounts} selected={activity} onToggle={toggle(setActivity)} />
      <ChipSet label="What they are worth" meta={POTENTIAL_META}
        counts={potentialCounts} selected={potential} onToggle={toggle(setPotential)} />

      {showRules && (
        <div className="callout is-quiet small stack-sm">
          {Object.entries(data.definitions.activity).map(([key, text]) => (
            <div key={key}><strong>{FOLLOW_UP_META[key]?.label}:</strong> {text}</div>
          ))}
          {Object.entries(data.definitions.potential).map(([key, text]) => (
            <div key={key}><strong>{POTENTIAL_META[key]?.label}:</strong> {text}</div>
          ))}
          <div className="muted">Worth means: {data.definitions.potential_basis}</div>
        </div>
      )}

      <div className="state-layout">
        <div className="map-frame">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="map-svg"
            role="img" aria-label="Leads with coordinates, coloured by how they are being worked">
            {[20, 40, 60, 80].map((v) => (
              <g key={v}>
                <line x1={v} y1="0" x2={v} y2="100" className="map-grid" />
                <line x1="0" y1={v} x2="100" y2={v} className="map-grid" />
              </g>
            ))}
            <polygon
              className="map-outline"
              points={OUTLINE.map(([lon, lat]) => {
                const { x, y } = project(lat, lon);
                return `${x.toFixed(2)},${y.toFixed(2)}`;
              }).join(' ')}
            />
            {pins.map((p) => (
              <circle
                key={`${p.lead.id}-${p.pin.id}`}
                cx={p.x} cy={p.y}
                r={p.pin.precision === 'EXACT' ? 1.4 : 2.1}
                className="map-pin is-exact"
                style={{ fill: FOLLOW_UP_META[p.lead.activity]?.color || 'var(--brand)' }}
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </svg>
          <div className="map-caption small muted">
            {placedLeads} of {shown.length} lead{shown.length === 1 ? '' : 's'} in view have
            coordinates. The rest are in the list below — nobody is left out for lacking a pin, and
            no location is guessed.
          </div>
          {hover && (
            <div className="map-tip">
              <strong>{hover.lead.name}</strong>
              <div className="small muted">
                {FOLLOW_UP_META[hover.lead.activity]?.label} · {POTENTIAL_META[hover.lead.potential]?.label}
              </div>
              <div className="small muted">
                {[hover.pin.label, hover.pin.city, hover.pin.state].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>

        <div className="card card-pad stack-sm" style={{ alignSelf: 'start' }}>
          <div className="stat-label">State by state</div>
          <div className="table-scroll">
            <table className="data-table state-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th title="Open deal, spoken to recently">Active</th>
                  <th title="Open deal, nobody has spoken to them lately">Follow up</th>
                  <th>Lower</th>
                  <th>Expected</th>
                </tr>
              </thead>
              <tbody>
                {data.states.map((g) => {
                  const key = g.state || 'none';
                  const selected = state.toLowerCase() === key.toLowerCase();
                  return (
                    <tr key={key} className={selected ? 'is-selected' : ''}>
                      <td>
                        <button type="button" className="btn-link"
                          onClick={() => setState(selected ? '' : (g.state || 'none'))}>
                          {g.state || 'No state recorded'}
                        </button>
                        <span className="muted small"> · {g.total}</span>
                      </td>
                      <td className="tnum">{g.activity.active}</td>
                      <td className="tnum">
                        {g.activity.inactive > 0
                          ? <Badge tone="warning">{g.activity.inactive}</Badge> : '0'}
                      </td>
                      <td className="tnum">{g.potential.low}</td>
                      <td className="tnum">{g.eligible_value > 0 ? formatMoney(g.eligible_value) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <div>
            <h3>
              {state === '' ? 'Every state' : state === 'none' ? 'Leads with no state recorded' : state}
              {' — '}{shown.length} lead{shown.length === 1 ? '' : 's'}
            </h3>
            <div className="small muted">
              {followUps > 0
                ? `${followUps} need${followUps === 1 ? 's' : ''} following up, listed first; then by what they are worth.`
                : 'Nobody here has gone quiet.'}
            </div>
          </div>
        </div>
        {shown.length === 0 ? (
          <EmptyState title="No leads match">Widen the chips above, or pick another state.</EmptyState>
        ) : (
          <ul className="follow-list">
            {shown.map((lead) => (
              <li key={lead.id} className={`follow-row follow-${lead.activity}`}>
                <span className="follow-dot" style={{ background: FOLLOW_UP_META[lead.activity]?.color }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Link to={`/accounts/${lead.id}`} className="nudge-title">{lead.name}</Link>
                    <Badge tone={FOLLOW_UP_META[lead.activity]?.tone}>{FOLLOW_UP_META[lead.activity]?.label}</Badge>
                    <Badge tone={POTENTIAL_META[lead.potential]?.tone}>{POTENTIAL_META[lead.potential]?.label}</Badge>
                    {lead.open_blockers > 0 && <Badge tone="critical">blocked</Badge>}
                  </div>
                  <div className="small muted row wrap" style={{ gap: 6 }}>
                    <span>{lead.state || 'no state'}</span>
                    {lead.stage_name && <><span>·</span><span>{lead.stage_name}</span></>}
                    <span>·</span><span>{spokenLabel(lead.days_since_spoken)}</span>
                    {lead.eligible_value !== null && lead.eligible_value !== undefined && (
                      <><span>·</span><span>{formatMoney(lead.eligible_value)} expected</span></>
                    )}
                    {lead.segment_name && <><span>·</span><span>{lead.segment_name}</span></>}
                  </div>
                  {lead.next_step && (
                    <div className="small">
                      Next: {lead.next_step}
                      {lead.next_step_due && <span className="muted"> · {formatDate(lead.next_step_due)}</span>}
                    </div>
                  )}
                </div>
                {lead.owner_name && (
                  <Avatar name={lead.owner_name} color={lead.owner_color} size={22} title={`${lead.owner_name} leads it`} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- manager tree

/**
 * Managers, and the organizations each of them leads.
 *
 * Grouped by one primary ownership — the relationship owner — so an organization
 * sits under exactly one person and the portfolio totals add up. Whoever is also
 * following it is shown on the row without being counted twice.
 */
export function TreeView({ departmentId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(new Set());

  useEffect(() => {
    setData(null);
    api.crmTree({ department_id: departmentId || undefined })
      .then((result) => {
        setData(result);
        setOpen(new Set(result.managers.slice(0, 2).map((m) => m.user.id)));
      })
      .catch((err) => toast.error(err));
  }, [departmentId]);

  if (!data) return <Spinner label="Loading who leads what" />;
  if (data.managers.length === 0 && data.unassigned.length === 0) {
    return <EmptyState title="Nothing to show" />;
  }

  const toggle = (id) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const Org = ({ org }) => (
    <li className={`tree-org${org.needs_attention ? ' needs-attention' : ''}`}>
      <Link to={`/accounts/${org.id}`} className="btn-link grow truncate">{org.name}</Link>
      {org.segment_name && <Badge dot={org.segment_color}>{org.segment_name}</Badge>}
      <span className="small muted tnum">
        {org.open_count} open
        {org.eligible_value > 0 && ` · ${formatMoney(org.eligible_value)}`}
      </span>
      {org.follower_name && (
        <Avatar name={org.follower_name} size={18}
          title={`${org.follower_name} follows it — not counted in anyone's totals`} />
      )}
    </li>
  );

  return (
    <div className="stack">
      <div className="small muted">
        Grouped by whoever leads the relationship, so every organization appears under exactly one
        person and the totals do not double-count. People who follow an organization are shown on
        its row.
      </div>

      {data.managers.map((manager) => {
        const expanded = open.has(manager.user.id);
        return (
          <section key={manager.user.id} className="card card-pad stack-sm">
            <button type="button" className="tree-head" onClick={() => toggle(manager.user.id)}>
              <Avatar name={manager.user.full_name} color={manager.user.avatar_color} size={28} />
              <span className="grow" style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 14 }}>{manager.user.full_name}</strong>
                {manager.user.job_title && <span className="small muted"> · {manager.user.job_title}</span>}
                <div className="small muted">
                  {manager.totals.organizations} organization{manager.totals.organizations === 1 ? '' : 's'}
                  {' · '}{manager.totals.open_opportunities} open deal{manager.totals.open_opportunities === 1 ? '' : 's'}
                  {manager.totals.eligible_value > 0 && ` · ${formatMoney(manager.totals.eligible_value)} eligible`}
                  {manager.totals.weighted_value > 0 && ` · ${formatMoney(manager.totals.weighted_value)} weighted`}
                </div>
              </span>
              {manager.totals.needs_attention > 0 && (
                <Badge tone="warning">
                  {manager.totals.needs_attention} need{manager.totals.needs_attention === 1 ? 's' : ''} attention
                </Badge>
              )}
              <Icon name="chevron" size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
            </button>
            {expanded && (
              <ul className="tree-list">
                {manager.organizations.map((org) => <Org key={org.id} org={org} />)}
              </ul>
            )}
          </section>
        );
      })}

      {data.unassigned.length > 0 && (
        <section className="card card-pad stack-sm">
          <div className="row" style={{ gap: 8 }}>
            <Icon name="alert" size={15} />
            <strong>Nobody leads these ({data.unassigned.length})</strong>
          </div>
          <div className="small muted">
            An organization with no owner is an organization nobody is accountable for.
          </div>
          <ul className="tree-list">
            {data.unassigned.map((org) => <Org key={org.id} org={org} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
