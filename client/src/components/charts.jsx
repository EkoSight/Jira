import { useId, useState } from 'react';

/**
 * Charts here follow one rule set:
 *   - one measure across categories  -> single hue bars (never a rainbow)
 *   - two series over time           -> categorical slots 1 and 2, legend + direct labels
 *   - state (overdue / load / risk)  -> the reserved status colours, always with a label
 * Colours come from CSS custom properties so light and dark are each deliberate.
 */

const cssVar = (name, fallback) => `var(${name}, ${fallback})`;

export const SERIES_1 = cssVar('--series-1', '#2a78d6');
export const SERIES_2 = cssVar('--series-2', '#eb6834');
export const STATUS_COLOR = {
  good: cssVar('--good', '#0ca30c'),
  warning: cssVar('--warning', '#fab219'),
  serious: cssVar('--serious', '#ec835a'),
  critical: cssVar('--critical', '#d03b3b'),
  neutral: cssVar('--axis', '#c3c2b7'),
  brand: cssVar('--brand', '#2a78d6'),
};

/** Horizontal bars — one measure across categories, so one hue throughout. */
export function BarList({ items, valueKey = 'value', labelKey = 'label', max, onSelect, emptyText = 'Nothing to show' }) {
  const rows = items.filter((item) => item[valueKey] > 0);
  if (!rows.length) return <div className="empty small">{emptyText}</div>;

  const ceiling = max || Math.max(...rows.map((r) => r[valueKey]));

  return (
    <div>
      {rows.map((item) => {
        const value = item[valueKey];
        const pct = ceiling > 0 ? Math.max(2, (value / ceiling) * 100) : 0;
        const Row = onSelect ? 'button' : 'div';
        return (
          <Row
            key={item.id ?? item[labelKey]}
            className="bar-row"
            style={onSelect ? { border: 0, background: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', padding: '5px 0' } : undefined}
            onClick={onSelect ? () => onSelect(item) : undefined}
            title={`${item[labelKey]}: ${value}`}
          >
            <span className="truncate dim">{item[labelKey]}</span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${pct}%`, background: item.color || SERIES_1 }}
              />
            </span>
            <span className="tnum" style={{ fontWeight: 600, minWidth: 26, textAlign: 'right' }}>
              {value}
            </span>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * Created vs completed over time. Two series, one y-axis, legend always present,
 * with a crosshair tooltip on hover / touch.
 */
export function TrendChart({ data, height = 170 }) {
  const gradientId = useId();
  const [hover, setHover] = useState(null);

  if (!data?.length) return <div className="empty small">No activity yet</div>;

  const width = 640;
  const pad = { top: 12, right: 12, bottom: 22, left: 26 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const maxValue = Math.max(1, ...data.map((d) => Math.max(d.created, d.completed)));
  const x = (index) => pad.left + (data.length === 1 ? innerW / 2 : (index / (data.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (value / maxValue) * innerH;

  const line = (key) => data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = `${line('created')} L${x(data.length - 1)},${pad.top + innerH} L${x(0)},${pad.top + innerH} Z`;

  const ticks = [0, Math.round(maxValue / 2), maxValue].filter((v, i, arr) => arr.indexOf(v) === i);

  const handlePointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((px - pad.left) / innerW) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, index)));
  };

  const point = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <div className="chart-legend">
          <span className="key">
            <span className="swatch" style={{ background: SERIES_1 }} /> Created
          </span>
          <span className="key">
            <span className="swatch" style={{ background: SERIES_2 }} /> Completed
          </span>
        </div>
        {point && (
          <div className="small tnum dim">
            {new Date(point.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ·{' '}
            {point.created} created · {point.completed} completed
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height, display: 'block', touchAction: 'pan-y' }}
        onMouseMove={handlePointer}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => handlePointer(e.touches[0])}
        role="img"
        aria-label="Tasks created and completed per day"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_1} stopOpacity="0.16" />
            <stop offset="100%" stopColor={SERIES_1} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--grid)"
              strokeWidth="1"
            />
            <text x={pad.left - 6} y={y(tick) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--ink-muted)">
              {tick}
            </text>
          </g>
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line('created')} fill="none" stroke={SERIES_1} strokeWidth="2" strokeLinejoin="round" />
        <path d={line('completed')} fill="none" stroke={SERIES_2} strokeWidth="2" strokeLinejoin="round" />

        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + innerH}
              stroke="var(--axis)"
              strokeWidth="1"
            />
            <circle cx={x(hover)} cy={y(data[hover].created)} r="4" fill={SERIES_1} stroke="var(--surface)" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(data[hover].completed)} r="4" fill={SERIES_2} stroke="var(--surface)" strokeWidth="2" />
          </>
        )}

        {data.map((d, i) =>
          i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2) ? (
            <text key={d.day} x={x(i)} y={height - 6} textAnchor="middle" fontSize="9.5" fill="var(--ink-muted)">
              {new Date(d.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/** Capacity meter. Colour is a state signal, so it always sits next to a label. */
export function LoadMeter({ percent, status }) {
  const value = Math.min(100, Math.max(0, percent ?? 0));
  const color =
    status === 'overloaded' ? STATUS_COLOR.critical
    : status === 'busy' ? STATUS_COLOR.warning
    : status === 'stalled' ? STATUS_COLOR.serious
    : status === 'idle' ? STATUS_COLOR.neutral
    : STATUS_COLOR.good;

  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="load-track grow">
        <span className="load-fill" style={{ width: `${value}%`, background: color }} />
      </span>
      <span className="tnum small dim" style={{ minWidth: 34, textAlign: 'right' }}>
        {percent == null ? '—' : `${percent}%`}
      </span>
    </div>
  );
}

/** Single-value ring used for completion rate. */
export function Ring({ value, total, label, color = SERIES_1, size = 92 }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const radius = size / 2 - 7;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="row" style={{ gap: 12 }}>
      <svg width={size} height={size} role="img" aria-label={`${label}: ${pct}%`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth="7" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="19"
          fontWeight="650"
          fill="var(--ink)"
        >
          {pct}%
        </text>
      </svg>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div className="small muted tnum">
          {value} of {total}
        </div>
      </div>
    </div>
  );
}

/**
 * A percentage as a ring, with the number inside it.
 *
 * Distinct from Ring above, which reads a value out of a total and labels
 * itself alongside. This one is the whole indicator: it is the progress figure
 * on a goal card, so the number lives in the middle and nothing sits beside it.
 */
export function ProgressRing({ percent, color = SERIES_1, size = 58, stroke = 5, muted = false, showValue = true }) {
  const value = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, percent));
  const radius = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * radius;
  const filled = ((value ?? 0) / 100) * circumference;

  return (
    <svg
      width={size}
      height={size}
      role="img"
      aria-label={value === null ? 'No progress recorded' : `${value}% complete`}
      style={{ display: 'block', flex: 'none' }}
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke="var(--surface-3)" strokeWidth={stroke} />
      {value !== null && value > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      {showValue && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.27}
          fontWeight="680"
          fill={muted ? 'var(--ink-muted)' : 'var(--ink)'}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {value === null ? '—' : `${value}%`}
        </text>
      )}
    </svg>
  );
}

/** A small line of movement over time — no axes, just the shape. */
export function Sparkline({ data = [], width = 96, height = 30, color = STATUS_COLOR.good }) {
  const gradientId = useId();
  const values = data.map((d) => Number(d.value) || 0);
  if (values.length < 2) return <span style={{ width, height, display: 'block' }} />;

  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const y = (v) => height - 3 - (v / max) * (height - 6);
  const points = values.map((v, i) => `${i * step},${y(v)}`);
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} role="img" aria-label="Recent movement" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={(values.length - 1) * step} cy={y(values[values.length - 1])} r="2.6" fill={color} />
    </svg>
  );
}
