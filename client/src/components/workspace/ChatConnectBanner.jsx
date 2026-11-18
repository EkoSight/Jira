/**
 * On the home page, for someone Google Chat cannot reach yet while the
 * organisation uses it: "Connect Google Chat to get reminders there", with the
 * steps. It can be put away for a week; My reminders always shows the state.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../state/AppState.jsx';

const KEY = (id) => `tf.chatBanner.hiddenUntil.${id}`;
const hiddenUntil = (id) => { try { return Number(localStorage.getItem(KEY(id))) || 0; } catch { return 0; } };

export default function ChatConnectBanner() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(() => hiddenUntil(user.id) > Date.now());
  useEffect(() => {
    if (hidden) return undefined;
    let alive = true;
    api.get('/reminders/channels').then((d) => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [user.id, hidden]);
  if (hidden || !data || !data.chat.enabled || data.chat.connected) return null;
  const hide = () => {
    try { localStorage.setItem(KEY(user.id), String(Date.now() + 7 * 86_400_000)); } catch { /* private window: hidden for now only */ }
    setHidden(true);
  };
  const byEmail = data.email.ready && !data.email.bounced && ['BOTH', 'CHAT_ELSE_EMAIL', 'EMAIL'].includes(data.task_reminders);
  return (
    <div className="mkt-callout small chat-banner" role="status">
      <div className="stack-xs">
        <strong>Connect Google Chat to get your reminders there</strong>
        <span>In Google Chat, choose <strong>New chat</strong>, search for <strong>TaskFlow</strong> under Apps, and send it a message. It takes a minute, once.</span>
        <span className="muted">Until then your reminders come to the TaskFlow bell{byEmail ? ' and by email' : ''}. <Link to="/settings?tab=account#how-you-hear">How you hear</Link></span>
      </div>
      <button type="button" className="btn btn-sm btn-ghost" onClick={hide}>Not now</button>
    </div>
  );
}
