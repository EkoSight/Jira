import { useEffect } from 'react';
import { initials } from '../lib/format.js';

export function Avatar({ name, color = '#3b82f6', size = 26, title }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: color, fontSize: Math.max(9, size * 0.4) }}
      title={title || name}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function Badge({ tone = 'neutral', dot, children, title }) {
  const toneClass = tone === 'neutral' ? '' : `badge-${tone}`;
  return (
    <span className={`badge ${toneClass}`} title={title}>
      {dot && <span className="badge-dot" style={{ background: dot }} />}
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="center" style={{ padding: 40, gap: 10 }}>
      <span className="spinner" />
      <span className="muted small">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, size }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <div className="grow truncate">{typeof title === 'string' ? <h2>{title}</h2> : title}</div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <div className="field-hint">{hint}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

const PATHS = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v14h-4z',
  list: 'M4 6h16M4 12h16M4 18h10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-7 2-7 5v1h14v-1c0-3-3-5-7-5z',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 19c0-3 3-5 7-5s7 2 7 5v1H2v-1zm15-4c3 0 5 1.6 5 4v1h-4v-1c0-1.5-.6-2.9-1.6-4H17z',
  flag: 'M5 3v18M5 4h12l-2 4 2 4H5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.4-2.5.1-.5-.1-.5 2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L16 4H8l-.4 2.6c-.6.2-1.2.6-1.7 1l-2.3-1-2 3.4 2 1.5-.1.5.1.5-2 1.5 2 3.4 2.3-1c.5.4 1.1.8 1.7 1L8 20h8l.4-2.6c.6-.2 1.2-.6 1.7-1l2.3 1 2-3.4-2-1.5z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-5.2-5.2',
  bell: 'M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm0 19a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3 2',
  alert: 'M12 3 2 20h20L12 3zm0 6v5m0 3v.5',
  check: 'M4 12l5 5L20 6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  logout: 'M10 4H5v16h5M16 8l4 4-4 4M20 12H9',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5z',
  chevron: 'M9 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 14h10l1-14',
  edit: 'M4 20h4L20 8l-4-4L4 16v4z',
};

export function Icon({ name, size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      <path d={PATHS[name] || PATHS.list} />
    </svg>
  );
}

export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, className = 'btn btn-danger btn-sm' }) {
  return (
    <button
      type="button"
      className={className}
      onClick={(event) => {
        const el = event.currentTarget;
        if (el.dataset.armed === 'true') {
          onConfirm();
          return;
        }
        el.dataset.armed = 'true';
        el.textContent = confirmLabel;
        setTimeout(() => {
          if (el.isConnected) {
            el.dataset.armed = 'false';
            el.textContent = label;
          }
        }, 3500);
      }}
    >
      {label}
    </button>
  );
}
