import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from './ui.jsx';
import { formatMoney, freshnessLabel } from '../lib/crm.js';
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
  { key: 'value', label: 'Value', get: (a) => Number(a.value) || 0, numeric: true },
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
                <td className="tnum">{formatMoney(account.value, account.currency) || <span className="muted">—</span>}</td>
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

export function MapView({ departmentId, segmentId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    setData(null);
    api.crmMap({ department_id: departmentId || undefined, segment_id: segmentId || undefined })
      .then(setData).catch((err) => toast.error(err));
  }, [departmentId, segmentId]);

  if (!data) return <Spinner label="Loading the map" />;

  const project = (lat, lon) => ({
    x: ((lon - BOX.minLon) / (BOX.maxLon - BOX.minLon)) * 100,
    y: ((BOX.maxLat - lat) / (BOX.maxLat - BOX.minLat)) * 100,
  });

  const pins = data.mapped.flatMap((org) =>
    org.pins.map((pin) => ({ ...project(Number(pin.latitude), Number(pin.longitude)), org, pin })));
  const offBox = pins.filter((p) => p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100);

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 14 }}>
        <div className="mini-stat">
          <span className="stat-label">On the map</span>
          <strong className="tnum">{data.organizations_mapped}</strong>
          <span className="small muted">{data.pins_total} place{data.pins_total === 1 ? '' : 's'}</span>
        </div>
        <div className="mini-stat">
          <span className="stat-label">Not on the map</span>
          <strong className="tnum">{data.organizations_unmapped}</strong>
          <span className="small muted">no coordinates entered</span>
        </div>
      </div>

      {pins.length === 0 ? (
        <EmptyState title="Nothing to plot yet">
          Coordinates are entered by hand on each organization's "Who they are" tab. Nothing is
          looked up automatically, so no pin here is a guess.
        </EmptyState>
      ) : (
        <div className="map-frame">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="map-svg"
            role="img" aria-label="Where the organizations are">
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
            {pins.filter((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100).map((p) => (
              <circle
                key={`${p.org.id}-${p.pin.id}`}
                cx={p.x} cy={p.y}
                r={p.pin.precision === 'EXACT' ? 1.3 : 2.1}
                className={`map-pin${p.pin.precision === 'EXACT' ? ' is-exact' : ''}`}
                style={{ fill: p.org.segment_color || 'var(--brand)' }}
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </svg>
          <div className="map-caption small muted">
            A rough outline of India, drawn here rather than fetched — no address is sent anywhere,
            and this is for orientation, not a boundary. A larger dot means the location is only
            approximate.
          </div>
          {hover && (
            <div className="map-tip">
              <strong>{hover.org.name}</strong>
              <div className="small muted">
                {[hover.pin.label, hover.pin.city, hover.pin.state].filter(Boolean).join(' · ')}
                {` · ${String(hover.pin.precision || '').toLowerCase()}`}
              </div>
            </div>
          )}
        </div>
      )}

      {offBox.length > 0 && (
        <div className="callout is-quiet">
          <Icon name="alert" size={15} />
          <span className="small">
            {offBox.length} place{offBox.length === 1 ? ' is' : 's are'} outside the plotted
            area ({offBox.map((p) => p.org.name).join(', ')}) — listed here rather than pushed
            to the edge of the map.
          </span>
        </div>
      )}

      {data.unmapped.length > 0 && (
        <section className="card card-pad stack-sm">
          <div className="stat-label">Not on the map ({data.unmapped.length})</div>
          <div className="small muted">
            These have no coordinates. They are listed in full — never silently left out.
          </div>
          <ul className="plain-list">
            {data.unmapped.map((org) => (
              <li key={org.id} className="row" style={{ gap: 8 }}>
                <Link to={`/accounts/${org.id}`} className="btn-link grow truncate">{org.name}</Link>
                {org.segment_name && <Badge dot={org.segment_color}>{org.segment_name}</Badge>}
                <span className="small muted">
                  {(org.operating_regions || []).join(', ') || org.hq_address || 'no location recorded'}
                </span>
                {org.owner_name && <Avatar name={org.owner_name} color={org.owner_color} size={20} />}
              </li>
            ))}
          </ul>
        </section>
      )}
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
