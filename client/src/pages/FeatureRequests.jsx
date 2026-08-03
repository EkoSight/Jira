import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { relativeTime } from '../lib/format.js';

const STATUS = {
  new: { label: 'New', tone: 'brand' },
  reviewing: { label: 'Being reviewed', tone: 'warning' },
  planned: { label: 'Planned', tone: 'good' },
  in_progress: { label: 'Being built', tone: 'good' },
  done: { label: 'Shipped', tone: 'good' },
  declined: { label: 'Not planned', tone: 'neutral' },
};

const URGENCY = {
  nice_to_have: 'Nice to have',
  useful: 'Useful',
  important: 'Important',
  blocking: 'Blocking my work',
};

const CATEGORY = {
  feature: 'New feature',
  improvement: 'Improvement',
  bug: 'Something is broken',
  other: 'Other',
};

function RequestForm({ onClose, onSaved }) {
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    detail: '',
    category: 'feature',
    urgency: 'useful',
    contact: user.email,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (form.title.trim().length < 5) return toast.error('Give it a slightly longer title');
    setSaving(true);
    try {
      await api.createFeatureRequest({
        title: form.title.trim(),
        detail: form.detail.trim() || null,
        category: form.category,
        urgency: form.urgency,
        contact: form.contact.trim() || null,
      });
      toast.success('Sent to the admin team — thank you');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Modal
      title="Request a feature"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Sending…' : 'Send to admin'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What would you like?">
          <input
            className="input"
            value={form.title}
            onChange={set('title')}
            placeholder="Send deadline reminders on WhatsApp"
            autoFocus
          />
        </Field>
        <Field label="Tell us more" hint="What are you trying to do, and what gets in the way today?">
          <textarea className="textarea" rows={5} value={form.detail} onChange={set('detail')} />
        </Field>
        <div className="grid-2">
          <Field label="Type">
            <select className="select" value={form.category} onChange={set('category')}>
              {Object.entries(CATEGORY).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="How much does it matter?">
            <select className="select" value={form.urgency} onChange={set('urgency')}>
              {Object.entries(URGENCY).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="How should we reach you?" hint="Email or phone — so we can ask follow-up questions">
          <input className="input" value={form.contact} onChange={set('contact')} />
        </Field>
      </div>
    </Modal>
  );
}

export default function FeatureRequests() {
  const { user, can } = useAuth();
  const toast = useToast();

  const [requests, setRequests] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState('');

  const load = () => {
    setLoading(true);
    api
      .featureRequests({ status: filter || undefined })
      .then((data) => {
        setRequests(data.requests);
        setCanManage(data.can_manage);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [filter]);

  const vote = async (request) => {
    try {
      const { request: updated } = await api.voteFeatureRequest(request.id);
      setRequests((current) => current.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      toast.error(err);
    }
  };

  const setStatus = async (request, status) => {
    try {
      const { request: updated } = await api.updateFeatureRequest(request.id, { status });
      setRequests((current) => current.map((r) => (r.id === updated.id ? updated : r)));
      toast.success('Updated');
    } catch (err) {
      toast.error(err);
    }
  };

  const respond = async (request) => {
    const note = window.prompt('Reply to the person who asked for this:', request.admin_note || '');
    if (note === null) return;
    try {
      const { request: updated } = await api.updateFeatureRequest(request.id, { admin_note: note });
      setRequests((current) => current.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading && requests.length === 0) return <Spinner label="Loading requests" />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Ideas & requests</h1>
          <div className="small muted">
            Ask for anything that would make your day easier. Vote for the ones you also want.
          </div>
        </div>
        {can('feature.request') && (
          <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
            <Icon name="bulb" /> Request a feature
          </button>
        )}
      </div>

      <div className="filters">
        <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All requests</option>
          {Object.entries(STATUS).map(([value, { label }]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {requests.length === 0 ? (
        <EmptyState title="No requests yet" action={
          can('feature.request') && (
            <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
              Be the first
            </button>
          )
        }>
          Tell the admin team what would help you work faster.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          {requests.map((request) => {
            const status = STATUS[request.status] || STATUS.new;
            return (
              <article key={request.id} className="card card-pad">
                <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <button
                    type="button"
                    className={`vote ${request.has_voted ? 'voted' : ''}`}
                    onClick={() => vote(request)}
                    title={request.has_voted ? 'Remove your vote' : 'I want this too'}
                  >
                    <Icon name="chevron" size={14} style={{ transform: 'rotate(-90deg)' }} />
                    <span className="tnum">{request.votes}</span>
                  </button>

                  <div className="grow">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <strong>{request.title}</strong>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <Badge>{CATEGORY[request.category]}</Badge>
                      {request.urgency === 'blocking' && <Badge tone="critical">Blocking</Badge>}
                      {request.urgency === 'important' && <Badge tone="warning">Important</Badge>}
                    </div>

                    {request.detail && (
                      <p className="small dim" style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{request.detail}</p>
                    )}

                    <div className="row wrap small muted" style={{ gap: 8 }}>
                      <Avatar name={request.created_by_name || '?'} color={request.avatar_color} size={20} />
                      <span>{request.created_by_name || 'Someone'}</span>
                      {request.department_name && <span>· {request.department_name}</span>}
                      <span>· {relativeTime(request.created_at)}</span>
                      {request.contact && <span>· {request.contact}</span>}
                    </div>

                    {request.admin_note && (
                      <div className="card card-pad small" style={{ marginTop: 8, background: 'var(--brand-wash)' }}>
                        <strong>Admin reply:</strong> {request.admin_note}
                      </div>
                    )}
                  </div>

                  <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
                    {canManage && (
                      <>
                        <select
                          className="select"
                          style={{ width: 150 }}
                          value={request.status}
                          onChange={(e) => setStatus(request, e.target.value)}
                        >
                          {Object.entries(STATUS).map(([value, { label }]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                        <button type="button" className="btn btn-sm" onClick={() => respond(request)}>
                          Reply
                        </button>
                      </>
                    )}
                    {(canManage || request.created_by === user.id) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={async () => {
                          await api.deleteFeatureRequest(request.id);
                          load();
                        }}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {composing && <RequestForm onClose={() => setComposing(false)} onSaved={load} />}
    </div>
  );
}
