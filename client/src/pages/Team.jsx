import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { LoadMeter } from '../components/charts.jsx';
import { WORKLOAD_STATUS, loadSummary, relativeTime } from '../lib/format.js';

const ROLE_NOTE = {
  admin: 'Full control, including permissions and rules',
  manager: 'Runs a team: assigns work, adds people, waives black marks',
  member: 'Works on cards and creates their own',
  viewer: 'Read only',
};

const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

function MemberDialog({ member, onClose, onSaved }) {
  const { can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();

  const isNew = !member;
  const [catalogue, setCatalogue] = useState({ permissions: {}, roles: [] });
  const [saving, setSaving] = useState(false);
  const [tempPassword, setTempPassword] = useState(null);
  const [form, setForm] = useState({
    full_name: member?.full_name || '',
    email: member?.email || '',
    role: member?.role || 'member',
    department_id: member?.department_id || '',
    job_title: member?.job_title || '',
    phone: member?.phone || '',
    avatar_color: member?.avatar_color || AVATAR_COLORS[0],
    weekly_capacity_hours: member?.weekly_capacity_hours ?? 40,
    max_concurrent_tasks: member?.max_concurrent_tasks ?? 8,
    extra_permissions: member?.extra_permissions || [],
    revoked_permissions: member?.revoked_permissions || [],
    external_user_id: member?.external_user_id || '',
  });

  useEffect(() => {
    api.permissionCatalogue().then(setCatalogue).catch(() => {});
  }, []);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        role: form.role,
        department_id: form.department_id ? Number(form.department_id) : null,
        job_title: form.job_title || null,
        phone: form.phone || null,
        avatar_color: form.avatar_color,
        weekly_capacity_hours: Number(form.weekly_capacity_hours),
        max_concurrent_tasks: Number(form.max_concurrent_tasks),
        external_user_id: form.external_user_id || null,
      };
      if (can('user.permissions')) {
        payload.extra_permissions = form.extra_permissions;
        payload.revoked_permissions = form.revoked_permissions;
      }

      if (isNew) {
        const result = await api.createUser(payload);
        if (result.temporary_password) setTempPassword(result.temporary_password);
        else onClose();
        toast.success(`${result.user.full_name} added`);
      } else {
        await api.updateUser(member.id, payload);
        toast.success('Saved');
        onClose();
      }
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const togglePermission = (key, granted, inherited) => {
    setForm((current) => {
      const extra = new Set(current.extra_permissions);
      const revoked = new Set(current.revoked_permissions);
      extra.delete(key);
      revoked.delete(key);
      if (granted && !inherited) extra.add(key);
      if (!granted && inherited) revoked.add(key);
      return { ...current, extra_permissions: [...extra], revoked_permissions: [...revoked] };
    });
  };

  if (tempPassword) {
    return (
      <Modal
        title="Member added"
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div className="stack">
          <p>Share this one-time password with {form.full_name}. They will be asked to change it at first sign in.</p>
          <div
            className="card card-pad tnum center"
            style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.06em', userSelect: 'all' }}
          >
            {tempPassword}
          </div>
          <div className="small muted">It cannot be shown again — you can always issue a new one from the member row.</div>
        </div>
      </Modal>
    );
  }

  const inheritedFor = (key) => {
    const roleDefaults = catalogue.rolePermissions?.[form.role];
    if (roleDefaults) return roleDefaults.includes(key);
    // fall back to what the server already computed for this member
    return Boolean(member?.permissions?.includes(key)) && !form.extra_permissions.includes(key);
  };

  return (
    <Modal
      title={isNew ? 'Add a team member' : `Edit ${member.full_name}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !form.full_name || !form.email}>
            {saving ? 'Saving…' : isNew ? 'Add member' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Full name">
            <input className="input" value={form.full_name} onChange={set('full_name')} autoFocus />
          </Field>
          <Field label="Work email" hint={isNew ? 'They sign in with this' : undefined}>
            <input type="email" className="input" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Department">
            <select className="select" value={form.department_id} onChange={set('department_id')}>
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Job title">
            <input className="input" value={form.job_title} onChange={set('job_title')} placeholder="Agronomist" />
          </Field>
          <Field label="Role" hint={ROLE_NOTE[form.role]}>
            <select className="select" value={form.role} onChange={set('role')} disabled={!can('user.permissions')}>
              {(catalogue.roles || ['admin', 'manager', 'member', 'viewer']).map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </Field>
          <Field label="Phone">
            <input className="input" value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Weekly capacity (hours)" hint="Drives the bandwidth meter">
            <input
              type="number"
              min="0"
              max="168"
              className="input"
              value={form.weekly_capacity_hours}
              onChange={set('weekly_capacity_hours')}
            />
          </Field>
          <Field label="Comfortable concurrent tasks" hint="Used when estimates are missing">
            <input
              type="number"
              min="1"
              max="100"
              className="input"
              value={form.max_concurrent_tasks}
              onChange={set('max_concurrent_tasks')}
            />
          </Field>
        </div>

        <Field label="Avatar colour">
          <div className="row wrap" style={{ gap: 6 }}>
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setForm((c) => ({ ...c, avatar_color: color }))}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: color,
                  border: form.avatar_color === color ? '3px solid var(--ink)' : '1px solid var(--border)',
                  cursor: 'pointer',
                }}
                aria-label={`Use ${color}`}
              />
            ))}
          </div>
        </Field>

        <Field
          label="Existing application user id"
          hint="Optional — links this member to their account in the main EkoSight app when the two are integrated"
        >
          <input className="input" value={form.external_user_id} onChange={set('external_user_id')} />
        </Field>

        {can('user.permissions') && (
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <h3>Permissions</h3>
              <span className="small muted">Highlighted ones come with the {form.role} role</span>
            </div>
            <div className="perm-grid">
              {Object.entries(catalogue.permissions || {}).map(([key, description]) => {
                const inherited = inheritedFor(key);
                const granted = inherited
                  ? !form.revoked_permissions.includes(key)
                  : form.extra_permissions.includes(key);
                return (
                  <label key={key} className={`perm-item ${inherited ? 'inherited' : ''}`}>
                    <input
                      type="checkbox"
                      checked={granted}
                      onChange={(e) => togglePermission(key, e.target.checked, inherited)}
                    />
                    <span>
                      <strong>{description}</strong>
                      <br />
                      <span className="small muted">{key}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Team() {
  const { can, user } = useAuth();
  const { refresh } = useRefData();
  const toast = useToast();
  const navigate = useNavigate();

  const [members, setMembers] = useState([]);
  const [workload, setWorkload] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(undefined);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.users({ active: showInactive ? 'all' : undefined }),
      // bandwidth, open, overdue and last active are transparent to everyone
      api.workloadReport(),
    ])
      .then(([usersData, workloadData]) => {
        setMembers(usersData.users);
        setWorkload(workloadData.workload || []);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [showInactive]);

  const workloadFor = (id) => workload.find((w) => w.id === id);

  const resetPassword = async (member) => {
    try {
      const { temporary_password: password } = await api.resetPassword(member.id);
      toast.success(`New password for ${member.full_name}: ${password}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const deactivate = async (member) => {
    try {
      await api.deactivateUser(member.id);
      toast.success(`${member.full_name} deactivated`);
      load();
      refresh();
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading && members.length === 0) return <Spinner label="Loading the team" />;

  const filtered = members.filter(
    (m) =>
      !search ||
      m.full_name.toLowerCase().includes(search.toLowerCase()) ||
      m.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Team</h1>
          <div className="small muted">{members.length} people · capacity, workload and access in one place</div>
        </div>
        {can('user.create') && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>
            <Icon name="plus" /> Add member
          </button>
        )}
      </div>

      <div className="filters">
        <input className="input" placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small dim" style={{ gap: 6 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show deactivated
        </label>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No one matches that search" />
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Bandwidth</th>
                <th className="num">Open</th>
                <th className="num">Overdue</th>
                <th>Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((member) => {
                const load = workloadFor(member.id);
                const state = load ? WORKLOAD_STATUS[load.status] : null;
                return (
                  <tr key={member.id}>
                    <td>
                      <div className="row">
                        <Avatar name={member.full_name} color={member.avatar_color} size={30} />
                        <div>
                          <div style={{ fontWeight: 600 }}>
                            {member.full_name}
                            {!member.is_active && <Badge tone="critical" >Deactivated</Badge>}
                          </div>
                          <div className="small muted">
                            {member.job_title || 'No title'} · {member.department_name || 'No department'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={member.role === 'admin' ? 'brand' : 'neutral'}>{member.role}</Badge>
                      <div className="small muted tnum">{member.permissions.length} permissions</div>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      {load ? (
                        <>
                          <LoadMeter percent={load.load_percent} status={load.status} />
                          <div className="row" style={{ gap: 6, marginTop: 2 }}>
                            <Badge tone={state.tone}>{state.label}</Badge>
                            <span className="small muted">{loadSummary(load)}</span>
                          </div>
                        </>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="num tnum">{load?.open_tasks ?? '—'}</td>
                    <td className="num tnum">
                      {load?.overdue_tasks > 0 ? (
                        <strong style={{ color: 'var(--critical-text)' }}>{load.overdue_tasks}</strong>
                      ) : (
                        load?.overdue_tasks ?? '—'
                      )}
                    </td>
                    <td className="small muted">{member.last_activity_at ? relativeTime(member.last_activity_at) : 'Never'}</td>
                    <td>
                      <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => navigate(`/board?assignee_id=${member.id}`)}
                          title="See their cards"
                        >
                          <Icon name="board" size={14} />
                        </button>
                        {can('user.edit') && (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setEditing(member)}>
                              Edit
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => resetPassword(member)}>
                              Reset password
                            </button>
                          </>
                        )}
                        {can('user.delete') && member.is_active && member.id !== user.id && (
                          <ConfirmButton
                            label="Deactivate"
                            confirmLabel="Tap again"
                            onConfirm={() => deactivate(member)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <MemberDialog
          member={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            load();
            refresh();
          }}
        />
      )}
    </div>
  );
}
