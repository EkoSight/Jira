import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import { uploadRecording } from '../components/sales/PhoneCall.jsx';
import { exactTime } from '../lib/crmWork.js';
import { phoneLabel } from '../lib/sales.js';
import { lengthWords, suggestCall } from '../lib/phoneCalls.js';
import { dropShared, readShared } from '../lib/sharedFiles.js';
import { phoneBridge } from '../lib/phoneBridge.js';

/**
 * In the Android app the shared file stays on the phone, and the app sends it
 * to the call chosen here; in the installed web app the browser holds it.
 */
async function readFromApp(bridge) {
  const s = await bridge.sharedRecording();
  if (!s?.waiting) return null;
  return { file: { name: s.name, size: s.size }, lastModified: s.lastModified || null, inApp: true };
}

const sizeWords = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * "Which call is this?": a recording shared to TaskFlow from the phone's own
 * recordings. It lists your calls of the last 24 hours, newest first, and
 * suggests the one whose time fits best. Nothing is attached until you
 * confirm; the server then checks the file itself (its type, its length
 * against the time since the call started, and the lead's recording choice).
 */
export default function ShareRecording() {
  const [params] = useSearchParams();
  const sharedId = params.get('shared');
  const bridge = params.get('native') === '1' ? phoneBridge() : null;
  const navigate = useNavigate();
  const toast = useToast();
  const [shared, setShared] = useState(undefined);
  const [calls, setCalls] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (bridge ? readFromApp(bridge) : readShared(sharedId)).then((s) => { if (!cancelled) setShared(s); }).catch(() => { if (!cancelled) setShared(null); });
    api.sales.get('/calls/recent', { hours: 24 }).then((r) => { if (!cancelled) setCalls(r.calls); }).catch(() => { if (!cancelled) setCalls([]); });
    return () => { cancelled = true; };
  }, [sharedId, bridge]);

  // a local preview, so the person can check it is the right call before sending it
  useEffect(() => {
    if (!shared?.file || shared.inApp) return undefined;
    const url = URL.createObjectURL(shared.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [shared]);

  const suggested = useMemo(() => (calls && shared ? suggestCall(calls, shared.lastModified ? new Date(shared.lastModified).toISOString() : null) : null), [calls, shared]);
  useEffect(() => { if (suggested && chosen === null) setChosen(suggested); }, [suggested, chosen]);

  if (shared === undefined || calls === null) return <Spinner label="Opening the shared recording" />;
  if (!shared) {
    return (
      <EmptyState title="Nothing to attach" action={<Link className="btn btn-sm" to="/sales">Back to sales</Link>}>
        The shared recording is no longer here: it may have been attached already. Share it again from your phone’s recordings, or use “Attach recording” on the call.
      </EmptyState>
    );
  }

  const call = calls.find((c) => c.id === chosen);
  const cancel = async () => {
    await (shared.inApp ? Promise.resolve(bridge.dropShared()) : dropShared(sharedId)).catch(() => {});
    navigate('/sales');
  };
  const attach = async () => {
    if (!call || busy) return;
    setBusy(true);
    try {
      const r = shared.inApp ? await bridge.attachShared({ callId: call.id }) : await uploadRecording(call.id, shared.file, 'SHARED');
      if (!shared.inApp) await dropShared(sharedId).catch(() => {});
      toast.success(r.duplicate ? `That recording was already on call #${call.id}` : `Attached to call #${call.id}: ${lengthWords(r.recording?.length_sec)}`);
      navigate(call.lead_id ? `/sales/leads/${call.lead_id}` : call.account_id ? `/accounts/${call.account_id}` : '/sales');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack page-narrow share-recording">
      <div className="stack-xs">
        <h1>Which call is this?</h1>
        <p className="small muted">Choose the call this recording belongs to. Nothing is attached until you press Attach.</p>
      </div>
      <section className="card card-pad stack-sm" aria-label="The shared recording">
        <div className="row wrap" style={{ gap: 8 }}>
          <Icon name="sound" size={16} />
          <strong className="truncate grow">{shared.file.name}</strong>
          <span className="small muted tnum">{sizeWords(shared.file.size)}{shared.lastModified ? ` · saved ${exactTime(new Date(shared.lastModified).toISOString())}` : ''}</span>
        </div>
        {preview && <audio controls src={preview} preload="metadata" className="call-audio" aria-label="Listen before attaching" />}
      </section>
      <section className="card" aria-labelledby="share-calls-title">
        <div className="card-head">
          <h3 id="share-calls-title">Your calls in the last 24 hours</h3>
          <span className="small muted">{calls.length} call{calls.length === 1 ? '' : 's'}</span>
        </div>
        {calls.length === 0 ? (
          <div className="card-pad small muted">No calls in the last 24 hours. A recording can only go on a call made from TaskFlow or picked up from the phone.</div>
        ) : (
          <div role="radiogroup" aria-labelledby="share-calls-title">
          <ul className="plain-list share-call-list">
            {calls.map((c) => {
              const taken = c.has_recording;
              const blocked = c.no_recording || c.do_not_record;
              return (
                <li key={c.id}>
                  <label className={`share-call${chosen === c.id ? ' is-chosen' : ''}${taken || blocked ? ' is-disabled' : ''}`}>
                    <input type="radio" name="share-call" value={c.id} checked={chosen === c.id} disabled={taken || blocked} onChange={() => setChosen(c.id)} />
                    <span className="stack-xs grow" style={{ minWidth: 0 }}>
                      <span className="row wrap" style={{ gap: 6 }}>
                        <strong className="truncate">{c.about || c.contact_name || phoneLabel(c.to_number || c.from_number)}</strong>
                        {c.id === suggested && <Badge tone="brand">Best fit</Badge>}
                        {taken && <Badge>Has a recording</Badge>}
                        {blocked && <Badge tone="warning">Not to be recorded</Badge>}
                      </span>
                      <span className="small muted tnum">
                        #{c.id} · {exactTime(c.started_at || c.dialled_at)} · {c.direction === 'INBOUND' ? 'they called' : 'you called'}
                        {c.talk_sec !== null && c.talk_sec !== undefined ? ` · ${lengthWords(c.talk_sec, c.duration_source)}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          </div>
        )}
      </section>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={!call || busy} onClick={attach}>{busy ? 'Attaching…' : call ? `Attach to call #${call.id}` : 'Choose a call'}</button>
        <button type="button" className="btn" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}
