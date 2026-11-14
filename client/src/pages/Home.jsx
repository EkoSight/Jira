/**
 * The home at "/": My workspace for people in the rollout (or who chose it),
 * today's overview for everyone else. The overview itself is always at
 * /overview, and My workspace at /workspace.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../state/AppState.jsx';
import { Spinner } from '../components/ui.jsx';
import Dashboard from './Dashboard.jsx';
import MyWorkspace from './MyWorkspace.jsx';

export default function Home() {
  const { user } = useAuth();
  const [ws, setWs] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get('/workspace').then((d) => { if (alive) setWs(d); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [user.id]);
  // if My workspace cannot be loaded, the overview is still there
  if (failed) return <Dashboard />;
  if (!ws) return <Spinner label="Opening your home" />;
  if (ws.home.workspace) return <MyWorkspace initial={ws} onHomeChange={(isHome) => { if (!isHome) setWs({ ...ws, home: { ...ws.home, workspace: false } }); }} />;
  return <Dashboard offerWorkspace />;
}
