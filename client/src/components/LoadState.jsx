import { Icon, Spinner } from './ui.jsx';

/**
 * What a screen shows while its data is not ready: loading, or an error that
 * says what happened and offers a retry. Never an empty table or a zero.
 */
export function LoadState({ load, label = 'Loading', what = 'this' }) {
  if (load.status === 'loading') return <Spinner label={label} />;
  if (load.status === 'error') {
    return (
      <div className="callout" role="alert" style={{ borderLeftColor: 'var(--serious)', background: 'var(--serious-wash)' }}>
        <Icon name="alert" />
        <div className="grow stack-sm">
          <div className="small"><strong>Could not load {what}.</strong> {load.error?.message || 'Something went wrong.'}</div>
          <div className="small muted">Nothing on this screen is from an earlier attempt. Figures are not shown until they load.</div>
          <div><button type="button" className="btn btn-sm" onClick={load.retry}>Try again</button></div>
        </div>
      </div>
    );
  }
  return null;
}

/** A line saying the figures are a copy kept on this device, not current. */
export function OfflineNote({ load }) {
  if (!load.offline) return null;
  return (
    <div className="callout small" role="status" style={{ borderLeftColor: 'var(--warning)', background: 'var(--warning-wash)' }}>
      <Icon name="alert" />
      <span>You are offline. This is the last copy saved on this device — not current figures. Reconnect before relying on it.</span>
    </div>
  );
}
