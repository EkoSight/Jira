import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RefDataProvider, ToastProvider, useAuth, useRefData } from './state/AppState.jsx';
import { Spinner } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Login, { ForcePasswordChange } from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Board from './pages/Board.jsx';
import MyTasks from './pages/MyTasks.jsx';
import Team from './pages/Team.jsx';
import BlackMarks from './pages/BlackMarks.jsx';
import Settings from './pages/Settings.jsx';

function Protected({ permission, children }) {
  const { can } = useAuth();
  if (permission && !can(permission)) return <Navigate to="/" replace />;
  return children;
}

function Shell() {
  const { ready } = useRefData();
  if (!ready) return <Spinner label="Loading your workspace" />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/board" element={<Board />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route
          path="/team"
          element={
            <Protected permission="user.view">
              <Team />
            </Protected>
          }
        />
        <Route
          path="/black-marks"
          element={
            <Protected permission="blackmark.view">
              <BlackMarks />
            </Protected>
          }
        />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Signing you in" />;
  if (!user) return <Login />;
  if (user.must_change_password) return <ForcePasswordChange />;
  return (
    <RefDataProvider>
      <Shell />
    </RefDataProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}
