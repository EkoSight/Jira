import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Modal, Spinner } from '../ui.jsx';
import { FOLLOWUP_KIND } from '../../lib/sales.js';
import { NOT_PROVIDED, exactTime, indiaTime } from '../../lib/crmWork.js';
import { CallStatusBadge, CategoryBadge, DueBadge, FollowUpActions, Stars } from './parts.jsx';
import { CallStatusForm } from './Calling.jsx';
import { CallAction, PendingCalls } from './PhoneCall.jsx';

const PAGE_SIZE = 25;

/** A short place for a row: city, district, state; or "Not provided". */
const shortPlace = (l) => [l.city, l.district && l.district !== l.city ? l.district : null, l.state].filter(Boolean).join(', ') || null;

/** The Leads list address showing exactly the records of one group. */
export function groupLink(group) {
  const p = new URLSearchParams({ tab: 'leads' });
  for (const [k, v] of Object.entries(group.filters || {})) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return `/sales?${p.toString()}`;
}

function QueueRow({ lead, onCall, onFollowUp }) {
  const fu = lead.next_followup;
  const place = shortPlace(lead);
  return (
    <li className="queue-row">
      <div className="grow stack-xs" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <CategoryBadge category={lead.category} />
          <Link to={`/sales/leads/${lead.id}`} className="queue-name truncate">{lead.display_name}</Link>
          <CallStatusBadge lead={lead} /><Stars value={lead.rating} />
        </div>
        <div className="queue-facts small">
          <span className="row" style={{ gap: 4 }}><span className="muted">Owner</span> {lead.owner_name ? <><Avatar userId={lead.owner_user_id} name={lead.owner_name} color={lead.owner_color} size={18} />{lead.owner_name}</> : <span className="warning-text">Nobody</span>}</span>
          <span><span className="muted">Place</span> {place || <span className="muted">{NOT_PROVIDED}</span>}</span>
          <span><span className="muted">Last contact</span> {lead.last_contacted_at ? indiaTime(lead.last_contacted_at) : 'never'}{lead.call_attempts ? ` · ${lead.call_attempts} attempt${lead.call_attempts === 1 ? '' : 's'}` : ''}</span>
          <span>
            <span className="muted">Next</span>{' '}
            {fu ? <>{FOLLOWUP_KIND[fu.kind] || 'Follow-up'}{fu.title ? `: ${fu.title}` : ''} · <span className="tnum">{exactTime(fu.due_date)}</span> <DueBadge dueAt={fu.due_date} /></>
              : lead.retry_at ? <>Try again {indiaTime(lead.retry_at)} <DueBadge dueAt={lead.retry_at} /></> : <span className="warning-text">nothing planned</span>}
          </span>
        </div>
        {lead.latest_note && (
          <blockquote className="call-note small">
            {lead.latest_note_imported && <Badge>Imported</Badge>} {lead.latest_note}
          </blockquote>
        )}
      </div>
      <div className="queue-actions">
        {lead.phone && <CallAction phone={lead.phone} target={{ lead_id: lead.id }} label={lead.display_name} />}
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onCall(lead)}>Say how it went</button>
        {fu && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onFollowUp(lead, fu, 'reschedule')}>Move</button>}
      </div>
    </li>
  );
}

/**
 * My Day as one prioritised queue. Each group is exactly one view of the Leads
 * list: the number on it is the number of leads that list shows, and "Open in
 * Leads" lands on the same records. Every group pages; nothing is cut off.
 */
export function WorkQueue({ meta, userId }) {
  const { user } = useAuth();
  const [bucket, setBucket] = useState(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [calling, setCalling] = useState(null);
  const [unsaved, setUnsaved] = useState(false);
  const closeCall = () => {
    if (unsaved && !window.confirm('Close without saving? What you chose and wrote will be lost.')) return;
    setCalling(null); setUnsaved(false);
  };
  const [acting, setActing] = useState(null);
  const load = useCallback(() => {
    api.sales.get('/work-queue', { user_id: userId && userId !== user.id ? userId : undefined, bucket: bucket || undefined, page, page_size: PAGE_SIZE })
      .then((r) => { setData(r); if (!bucket) setBucket(r.bucket); })
      .catch((err) => setData({ error: err.message }));
  }, [userId, user.id, bucket, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setBucket(null); setPage(1); setData(null); }, [userId]);

  if (!data) return <Spinner label="Working out what is next" />;
  if (data.error) return <EmptyState title="Could not load the queue">{data.error}</EmptyState>;
  const group = data.groups.find((g) => g.key === data.bucket);
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const urgent = data.groups.filter((g) => ['fu_overdue', 'fu_today', 'retry'].includes(g.key)).reduce((n, g) => n + g.count, 0);
  return (
    <>
    {(!userId || userId === user.id) && <PendingCalls />}
    <section className="card" aria-labelledby="queue-title">
      <div className="card-head">
        <h3 id="queue-title">Leads to work</h3>
        <span className="small muted">{urgent ? `${urgent} due now or today` : 'Nothing due now'} · times in {data.timezone === 'Asia/Kolkata' ? 'India time (IST)' : data.timezone}</span>
      </div>
      <div className="card-pad stack">
        <div className="queue-groups" role="tablist" aria-label="What to work on">
          {data.groups.map((g) => (
            <button key={g.key} type="button" role="tab" aria-selected={data.bucket === g.key} className={`queue-group tone-${g.tone}${data.bucket === g.key ? ' is-active' : ''}${g.count ? '' : ' is-empty'}`}
              onClick={() => { setBucket(g.key); setPage(1); }} title={g.note}>
              <span className="queue-group-count tnum">{g.count}</span>
              <span className="queue-group-label">{g.label}</span>
            </button>
          ))}
        </div>
        {group && (
          <div className="row-between wrap small" style={{ gap: 6 }}>
            <span className="muted">{group.note}. {data.total} lead{data.total === 1 ? '' : 's'}.</span>
            <Link className="btn-link" to={groupLink(group)}>{data.total === 1 ? 'Open it in Leads' : `Open these ${data.total} in Leads`}</Link>
          </div>
        )}
        {data.leads.length === 0 ? <div className="empty small">Nothing here right now.</div> : (
          <ol className="queue-list" start={(data.page - 1) * data.page_size + 1}>
            {data.leads.map((l) => <QueueRow key={l.id} lead={l} onCall={setCalling} onFollowUp={(lead, fu, mode) => setActing({ lead, fu, mode })} />)}
          </ol>
        )}
        {pages > 1 && (
          <div className="row-between small">
            <span className="muted">{(data.page - 1) * data.page_size + 1}–{Math.min(data.page * data.page_size, data.total)} of {data.total}</span>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>
      {calling && (
        <Modal title={`How did the call go? ${calling.display_name}`} size="lg" onClose={closeCall}>
          <CallStatusForm lead={calling} meta={meta} onDirty={setUnsaved} onDone={() => { setUnsaved(false); setCalling(null); load(); }} />
        </Modal>
      )}
      {acting && (
        <FollowUpActions task={{ id: acting.fu.id, title: acting.fu.title || FOLLOWUP_KIND[acting.fu.kind], due_date: acting.fu.due_date, followup_kind: acting.fu.kind, about: acting.lead.display_name }}
          initial={acting.mode} users={meta.users} onClose={() => setActing(null)} onDone={load} />
      )}
    </section>
    </>
  );
}
