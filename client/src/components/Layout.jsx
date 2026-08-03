import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useOnlineStatus, useRefData, useTheme } from '../state/AppState.jsx';
import { Avatar, Icon, Modal } from './ui.jsx';
import TaskDialog from './TaskDialog.jsx';
import {
  announce,
  primeNotificationBaseline,
  requestNotificationPermission,
  setSoundEnabled,
  soundEnabled,
  playChime,
  notificationPermission,
} from '../lib/alerts.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/my-tasks', label: 'My tasks', icon: 'list' },
  { to: '/notes', label: 'My notes', icon: 'note', permission: 'note.use' },
  { to: '/team', label: 'Team', icon: 'team', permission: 'user.view' },
  { to: '/recognition', label: 'Recognition', icon: 'trophy' },
  { to: '/black-marks', label: 'Black marks', icon: 'flag', permission: 'blackmark.view' },
  { to: '/feature-requests', label: 'Ideas & requests', icon: 'bulb', permission: 'feature.request' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

const MOBILE_NAV = [
  NAV[0],
  NAV[1],
  NAV[2],
  NAV[3],
  NAV[5],
];

export default function Layout({ children }) {
  const { user, signOut, can } = useAuth();
  const { refresh } = useRefData();
  const online = useOnlineStatus();
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [creating, setCreating] = useState(false);
  const [notifications, setNotifications] = useState({ notifications: [], unread: 0 });
  const [showNotifications, setShowNotifications] = useState(false);

  const visible = NAV.filter((item) => !item.permission || can(item.permission));
  const mobileVisible = MOBILE_NAV.filter((item) => !item.permission || can(item.permission));

  const [soundOn, setSoundOn] = useState(soundEnabled());
  const [openTaskId, setOpenTaskId] = useState(null);
  const primed = useRef(false);

  const loadNotifications = useCallback(
    () =>
      api
        .notifications()
        .then((data) => {
          setNotifications(data);
          // first poll of the session only establishes the baseline, so a week of
          // history does not all chime at once
          if (!primed.current) {
            primeNotificationBaseline(data.notifications);
            primed.current = true;
            return;
          }
          announce(data.notifications, {
            onOpen: (notification) => notification.task_id && setOpenTaskId(notification.task_id),
          });
        })
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    loadNotifications();
    // 30s keeps an assignment feeling immediate without hammering the server
    const timer = setInterval(loadNotifications, 30000);
    const onFocus = () => loadNotifications();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadNotifications]);

  const pageTitle = visible.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)))?.label
    || 'TaskFlow';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">TF</span>
          TaskFlow
        </div>

        <nav className="sidebar-nav">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}

          {can('task.create') && (
            <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={() => setCreating(true)}>
              <Icon name="plus" /> New task
            </button>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="row">
            <Avatar name={user.full_name} color={user.avatar_color} size={30} />
            <div className="grow truncate">
              <div className="small" style={{ fontWeight: 600 }}>{user.full_name}</div>
              <div className="small muted" style={{ textTransform: 'capitalize' }}>{user.role}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-icon" onClick={signOut} title="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="brand-mark" style={{ display: 'none' }} />
          <div className="topbar-title grow truncate">{pageTitle}</div>

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              const next = !soundOn;
              setSoundEnabled(next);
              setSoundOn(next);
              if (next) {
                playChime();
                requestNotificationPermission();
              }
            }}
            title={soundOn ? 'Alert sound is on — click to mute' : 'Alert sound is off — click to enable'}
          >
            <Icon name={soundOn ? 'sound' : 'mute'} />
          </button>

          <button type="button" className="btn btn-ghost btn-icon" onClick={toggleTheme} title="Switch theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              setShowNotifications(true);
              if (notifications.unread) api.markNotificationsRead().then(loadNotifications);
            }}
            title="Notifications"
            style={{ position: 'relative' }}
          >
            <Icon name="bell" />
            {notifications.unread > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 5,
                  right: 5,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 999,
                  background: 'var(--critical)',
                  color: '#fff',
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: 'grid',
                  placeItems: 'center',
                  padding: '0 3px',
                }}
              >
                {notifications.unread}
              </span>
            )}
          </button>

          {can('task.create') && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              <span className="new-task-label">New</span>
            </button>
          )}
        </header>

        {!online && <div className="offline-banner">Offline — showing the last data loaded. Changes cannot be saved.</div>}

        <main className="page">
          <div className="page-narrow">{children}</div>
        </main>
      </div>

      <nav className="mobile-nav">
        {mobileVisible.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-item grow ${isActive ? 'active' : ''}`}
          >
            <Icon name={item.icon} size={20} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {creating && (
        <TaskDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            refresh();
            navigate(location.pathname, { replace: true, state: { refreshedAt: Date.now() } });
          }}
        />
      )}

      {showNotifications && (
        <Modal title="Notifications" onClose={() => setShowNotifications(false)}>
          {notificationPermission() === 'default' && (
            <div className="card card-pad row-between" style={{ marginBottom: 12, gap: 10 }}>
              <div className="small">
                Allow desktop alerts so new assignments reach you even when TaskFlow is in another tab.
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => requestNotificationPermission()}
              >
                Allow
              </button>
            </div>
          )}
          {notifications.notifications.length === 0 ? (
            <div className="empty small">Nothing yet — assignments and deadline warnings land here.</div>
          ) : (
            notifications.notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                className="activity-line"
                style={{
                  borderBottom: '1px solid var(--border)',
                  padding: '9px 0',
                  background: 'none',
                  border: 0,
                  borderBottomWidth: 1,
                  borderBottomStyle: 'solid',
                  borderBottomColor: 'var(--border)',
                  width: '100%',
                  textAlign: 'left',
                  cursor: n.task_id ? 'pointer' : 'default',
                }}
                onClick={() => {
                  if (!n.task_id) return;
                  setShowNotifications(false);
                  setOpenTaskId(n.task_id);
                }}
              >
                <Icon
                  name={
                    n.type === 'blackmark' ? 'flag'
                    : n.type === 'due_soon' ? 'clock'
                    : n.type === 'kudos' || n.type === 'recognition' ? 'trophy'
                    : n.type === 'tagged' ? 'team'
                    : n.type === 'feature_request' || n.type === 'feature_update' ? 'bulb'
                    : 'bell'
                  }
                />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{n.title}</div>
                  {n.body && <div className="small muted">{n.body}</div>}
                  {n.task_ref && <span className="task-ref">{n.task_ref}</span>}
                </div>
                <span className="small muted">{new Date(n.created_at).toLocaleDateString()}</span>
              </button>
            ))
          )}
        </Modal>
      )}

      {openTaskId && (
        <TaskDialog taskId={openTaskId} onClose={() => setOpenTaskId(null)} onSaved={loadNotifications} />
      )}
    </div>
  );
}
