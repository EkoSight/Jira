import {
  Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, BASE, tokenStore } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Field, Icon, Modal } from '../ui.jsx';
import { newRequestId } from '../../lib/attendance.js';
import { exactTime } from '../../lib/crmWork.js';
import { phoneLabel } from '../../lib/sales.js';
import {
  CALLBACK_REASON, LENGTH_SOURCE, REFUSAL, callPath, estimateFromAway, lengthWords, sameTarget, telHref,
} from '../../lib/phoneCalls.js';
import { phoneBridge } from '../../lib/phoneBridge.js';

/**
 * A call on a company phone, from the tap on Call to "How did it go?".
 *
 *   start    the call is recorded on the server first (it may be refused: the
 *            number opted out, the day's limit, calling hours), then the phone
 *            dials: through the TaskFlow Android app if this page runs in it,
 *            otherwise through the phone's own dialler (tel:)
 *   bar      while it lasts, a bar shows the call, the sentence to say when
 *            calls are recorded, "They don't want this recorded" and
 *            "Attach recording", and leads to "How did it go?"
 *   length   in the app, the phone reports it; otherwise it is estimated from
 *            the time away from TaskFlow and the person corrects it
 *   offline  a call started with no connection still dials; it is sent to the
 *            server later, with the time it was dialled
 */
// "Log a call" for organizations and deals; parts.jsx itself uses this file, so it is loaded when needed
const LogCallDialog = lazy(() => import('./parts.jsx').then((m) => ({ default: m.LogCallDialog })));

const CallContext = createContext(null);
const SESSION_KEY = 'taskflow.callSession';
const QUEUE_KEY = 'taskflow.callQueue';

const readJson = (store, key, fallback) => {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeJson = (store, key, value) => {
  try { if (value === null) store.removeItem(key); else store.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

/** Sends a file to a call (as the person, with their sign-in). */
export async function uploadRecording(callId, file, source = 'ATTACHED') {
  const form = new FormData();
  form.append('source', source);
  form.append('file', file, file.name || 'recording');
  const token = tokenStore.get();
  const res = await fetch(`${BASE}/sales/calls/${callId}/recording`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `Upload failed (${res.status})`);
    err.status = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

export function CallSessionProvider({ children }) {
  const toast = useToast();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState(() => readJson(sessionStorage, SESSION_KEY, null));
  const [live, setLive] = useState(null);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [texts, setTexts] = useState(null);

  const save = useCallback((next) => {
    setSession(next);
    writeJson(sessionStorage, SESSION_KEY, next);
    if (!next) setLive(null);
  }, []);

  // the sentence to say first, when calls are recorded
  useEffect(() => {
    if (!user || !can('crm.view')) return;
    api.sales.get('/calling/policy').then(setTexts).catch(() => {});
  }, [user, can]);

  // in the Android app, a phone not yet set up for this person opens its setup once
  useEffect(() => {
    const bridge = phoneBridge();
    if (!bridge || !user || !can('crm.activity.log')) return;
    bridge.status().then((st) => {
      if (st?.configured && st.userId === user.id) return;
      let shown = false;
      try { shown = sessionStorage.getItem('taskflow.phoneSetupShown') === '1'; sessionStorage.setItem('taskflow.phoneSetupShown', '1'); } catch { /* private mode */ }
      if (!shown && location.pathname !== '/phone-setup') navigate('/phone-setup');
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // in the Android app, a recording shared from the phone app opens "Which call is this?"
  useEffect(() => {
    const bridge = phoneBridge();
    if (!bridge || !user || !can('crm.activity.log')) return undefined;
    const open = () => { if (location.pathname !== '/sales/share-recording') navigate('/sales/share-recording?native=1'); };
    Promise.resolve(bridge.sharedRecording?.()).then((s) => { if (s?.waiting) open(); }).catch(() => {});
    let handle = null;
    let gone = false;
    Promise.resolve(bridge.addListener?.('sharedRecording', open)).then((h) => { if (gone) h?.remove?.(); else handle = h; }).catch(() => {});
    return () => { gone = true; handle?.remove?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // calls dialled with no connection are sent once it is back
  const flush = useCallback(async () => {
    const queue = readJson(localStorage, QUEUE_KEY, []);
    if (!queue.length) return;
    const left = [];
    for (const q of queue) {
      try {
        const r = await api.sales.post('/calls/start', q.body);
        if (session && !session.callId && session.requestId === q.body.request_id) save({ ...session, callId: r.call.id });
      } catch (err) {
        // refused calls are not retried; only a lost connection keeps it queued
        if (!err.status) left.push(q);
      }
    }
    writeJson(localStorage, QUEUE_KEY, left.length ? left : null);
  }, [session, save]);
  useEffect(() => {
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [flush]);

  // the time away from TaskFlow after dialling, for the estimate
  useEffect(() => {
    if (!session || session.visibleAt) return undefined;
    const onChange = () => {
      const now = new Date().toISOString();
      if (document.visibilityState === 'hidden' && !session.hiddenAt) save({ ...session, hiddenAt: now });
      else if (document.visibilityState === 'visible' && (session.hiddenAt || Date.now() - new Date(session.dialledAt).getTime() > 5000)) {
        save({ ...session, visibleAt: now });
      }
    };
    document.addEventListener('visibilitychange', onChange);
    // the phone may have closed the page during a long call: opened again, the person is back
    if (session.hiddenAt && document.visibilityState === 'visible') onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [session, save]);

  // in the app, the phone reports the call: watch for it
  useEffect(() => {
    if (!session?.callId) return undefined;
    let stop = false;
    const look = () => api.sales.get(`/calls/${session.callId}/live`).then((r) => { if (!stop) setLive(r.call); }).catch(() => {});
    look();
    if (session.via !== 'ANDROID_APP') return () => { stop = true; };
    const timer = setInterval(() => { if (document.visibilityState === 'visible') look(); }, 3000);
    const end = setTimeout(() => clearInterval(timer), 30 * 60_000);
    return () => { stop = true; clearInterval(timer); clearTimeout(end); };
  }, [session?.callId, session?.via, session?.visibleAt]);

  const dial = useCallback((phone, callId) => {
    const bridge = phoneBridge();
    if (bridge) {
      Promise.resolve(bridge.placeCall({ number: phone, callId })).catch((err) => toast.error(err?.message || 'The phone could not dial'));
    } else {
      const href = telHref(phone);
      if (href) window.location.href = href;
    }
  }, [toast]);

  const start = useCallback(async ({ phone, target, label, overrideReason = null }) => {
    if (busy) return;
    const bridge = phoneBridge();
    // in the app, calls go through TaskFlow only on a phone set up for this person, after the phone policy
    if (bridge) {
      const st = await Promise.resolve(bridge.status()).catch(() => null);
      if (!st?.configured || st.userId !== user?.id || texts?.policy?.acknowledged === false) {
        toast.error('Set up this phone for your calls first');
        navigate('/phone-setup');
        return;
      }
    }
    const via = bridge ? 'ANDROID_APP' : 'DIALLER';
    const requestId = newRequestId();
    const body = { ...target, phone, via, request_id: requestId, override_reason: overrideReason };
    setBusy(true);
    try {
      const r = await api.sales.post('/calls/start', body);
      save({
        callId: r.call.id, requestId, phone, target, label, via, dialledAt: r.call.dialled_at, recording: r.recording,
        callbackReason: r.callback_reason, hoursOverride: r.hours_override_reason, hiddenAt: null, visibleAt: null,
      });
      setAsk(null);
      dial(phone, r.call.id);
    } catch (err) {
      const code = err.details?.code;
      if (err.status === 409 && code === 'OUTSIDE_HOURS') setAsk({ phone, target, label, message: err.message });
      else if (err.status === 409 && REFUSAL[code]) toast.error(err.message);
      else if (!err.status) {
        // no connection: dial anyway; the call is sent when the connection is back
        const queue = readJson(localStorage, QUEUE_KEY, []);
        writeJson(localStorage, QUEUE_KEY, [...queue, { body: { ...body, dialled_at: new Date().toISOString() } }]);
        save({ callId: null, requestId, phone, target, label, via, dialledAt: new Date().toISOString(), recording: null, hiddenAt: null, visibleAt: null, offline: true });
        dial(phone, null);
      } else toast.error(err);
    } finally {
      setBusy(false);
    }
  }, [busy, dial, save, toast, navigate, texts, user?.id]);

  const value = useMemo(() => {
    const estimate = session ? estimateFromAway(session) : null;
    return {
      session, live, busy, texts, estimate,
      start,
      /** The call in progress for this record, if there is one. */
      activeFor: (target) => (session && sameTarget(session.target, target) ? { ...session, live, estimate } : null),
      finish: () => save(null),
      update: (patch) => save({ ...session, ...patch }),
      refreshLive: () => session?.callId && api.sales.get(`/calls/${session.callId}/live`).then((r) => setLive(r.call)).catch(() => {}),
    };
  }, [session, live, busy, texts, start, save]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {session && <CallBar />}
      {ask && <OutsideHours ask={ask} onCancel={() => setAsk(null)} onGo={(reason) => start({ ...ask, overrideReason: reason })} />}
    </CallContext.Provider>
  );
}

export const useCallSession = () => useContext(CallContext) || {
  session: null, live: null, busy: false, texts: null, estimate: null, start: () => {}, activeFor: () => null, finish: () => {}, update: () => {},
};

/** Outside calling hours: the call goes out only with a reason. */
function OutsideHours({ ask, onCancel, onGo }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Outside calling hours" onClose={onCancel}
      footer={<><button type="button" className="btn" onClick={onCancel}>Don’t call now</button><button type="button" className="btn btn-primary" disabled={reason.trim().length < 3} onClick={() => onGo(reason.trim())}>Call anyway</button></>}>
      <div className="stack-sm">
        <p className="small">{ask.message}</p>
        <Field label="Why can’t this call wait? *" hint="Kept with the call, and listed for administrators in the weekly review.">
          <input className="input" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="For example: they asked for an evening call" />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * The Call button. It starts the call on the server, then dials. The number
 * is always shown as text, so it can be copied when nothing happens.
 */
export function CallAction({ phone, target, label, primary = false, large = false, showNumber = true }) {
  const { start, busy } = useCallSession();
  const { can } = useAuth();
  const path = callPath({ bridge: phoneBridge(), phone });
  if (path === 'NONE') return null;
  // someone who cannot log calls still gets the dialler, as before; nothing is recorded
  if (!can('crm.activity.log')) {
    return (
      <span className={`call-action${large ? ' is-large' : ''}`}>
        <a className={`btn${large ? ' call-dial' : ' btn-sm call-go'}${primary ? ' btn-primary' : ''}`} href={telHref(phone)} title="Opens your phone’s dialler">
          <Icon name="phone" size={large ? 16 : 13} /> Call{large ? ` ${phoneLabel(phone)}` : ''}
        </a>
        {showNumber && !large && <span className="call-number tnum">{phoneLabel(phone)}</span>}
      </span>
    );
  }
  return (
    <span className={`call-action${large ? ' is-large' : ''}`}>
      <button type="button" className={`btn${large ? ' call-dial' : ' btn-sm call-go'}${primary ? ' btn-primary' : ''}`} disabled={busy}
        title={path === 'APP' ? 'Dials on the company SIM' : 'Opens your phone’s dialler'} onClick={() => start({ phone, target, label })}>
        <Icon name="phone" size={large ? 16 : 13} /> Call{large ? ` ${phoneLabel(phone)}` : ''}
      </button>
      {showNumber && !large && <span className="call-number tnum">{phoneLabel(phone)}</span>}
    </span>
  );
}

/** "Attach recording": a file chosen by hand for one of your calls. */
export function AttachRecording({ callId, onDone, label = 'Attach recording' }) {
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const send = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadRecording(callId, file, 'ATTACHED');
      toast.success(r.duplicate ? 'That recording was already attached' : `Recording attached: ${lengthWords(r.recording.length_sec)}`);
      onDone?.(r);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="upload" size={13} /> {busy ? 'Sending…' : label}
      </button>
      <input ref={input} type="file" accept="audio/*,.m4a,.amr,.3gp,.3ga,.aac,.mp3,.ogg,.opus,.wav" hidden onChange={(e) => send(e.target.files?.[0])} />
    </>
  );
}

/** The bar shown while a call is going on. */
function CallBar() {
  const { session, live, texts, estimate, finish, update } = useCallSession();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [lang, setLang] = useState(() => (localStorage.getItem('taskflow.sentenceLang') === 'hi' ? 'hi' : 'en'));
  const [logging, setLogging] = useState(false);
  const panel = useRef(null);
  // the page and the toasts make room for the panel, whatever its height
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('has-live-call');
    const el = panel.current;
    const measure = () => root.style.setProperty('--live-call-h', `${Math.ceil(el?.getBoundingClientRect().height || 0)}px`);
    measure();
    const observer = typeof ResizeObserver === 'function' && el ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.classList.remove('has-live-call');
      root.style.removeProperty('--live-call-h');
    };
  }, []);
  if (!session) return null;
  const recordingOn = session.recording?.on && !session.recording?.objected;
  const sentence = texts?.texts?.opening_sentence?.[lang];
  const leadPage = session.target?.lead_id ? `/sales/leads/${session.target.lead_id}` : null;
  const state = live?.connected === true ? `Connected · ${lengthWords(live.talk_sec)}`
    : live?.connected === false ? 'Not answered'
      : session.offline ? 'No connection: the call is sent to TaskFlow when you are back online'
        : session.via === 'ANDROID_APP' ? 'Dialling on the company SIM…' : 'Your phone is dialling. Come back here to say how it went.';
  const howDidItGo = () => {
    if (leadPage) {
      if (location.pathname !== leadPage) navigate(`${leadPage}#call-outcome`);
      else document.getElementById('call-outcome')?.scrollIntoView({ behavior: 'smooth' });
    } else setLogging(true);
  };
  // the privacy notice, sent from the phone's own share sheet (WhatsApp, SMS…): never an automatic message
  const noticeUrl = `${window.location.origin}${BASE}/s/privacy`;
  const shareNotice = async () => {
    const text = lang === 'hi' ? 'जब हम आपको कॉल करते हैं तो आपकी जानकारी का उपयोग कैसे होता है:' : 'How we use your details when we call you:';
    const url = lang === 'hi' ? `${noticeUrl}?lang=hi` : noticeUrl;
    try {
      if (navigator.share) await navigator.share({ title: lang === 'hi' ? 'गोपनीयता सूचना' : 'Privacy notice', text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        toast.success('Link copied: paste it into WhatsApp or SMS');
      }
    } catch (err) {
      if (err?.name !== 'AbortError') toast.error(`Could not share. The link is ${url}`);
    }
  };
  const noRecording = async () => {
    try {
      await api.sales.post(`/calls/${session.callId}/no-recording`, {});
      update({ recording: { ...(session.recording || {}), objected: true } });
      toast.success('Noted: this call is not recorded, and nothing more is kept for this lead');
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
    <section className="live-call" ref={panel} role="region" aria-label="Call in progress">
      <div className="live-call-main">
        <div className="grow stack-xs" style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <Icon name="phone" size={14} />
            <strong className="truncate">Calling {session.label || phoneLabel(session.phone)}</strong>
            <span className="small muted tnum">started {exactTime(session.dialledAt)}</span>
            {session.callbackReason && <Badge tone="brand">{CALLBACK_REASON[session.callbackReason]}</Badge>}
            {session.hoursOverride && <Badge tone="warning">Outside hours</Badge>}
          </div>
          <div className="small" aria-live="polite">{state}{!live?.connected && estimate ? ` · away ${lengthWords(estimate, 'ESTIMATED').replace(' · estimated', '')}` : ''}</div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" aria-label="Hide the call bar (the call stays on the list to describe)" onClick={finish}><Icon name="close" size={14} /></button>
      </div>
      {recordingOn && sentence && (
        <div className="live-call-sentence small">
          <span className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
            <strong>Say first</strong>
            <span className="row" style={{ gap: 2 }} role="group" aria-label="Language">
              {[['en', 'English'], ['hi', 'हिंदी']].map(([k, l]) => (
                <button key={k} type="button" className={`kind-chip${lang === k ? ' is-active' : ''}`} aria-pressed={lang === k}
                  onClick={() => { setLang(k); try { localStorage.setItem('taskflow.sentenceLang', k); } catch { /* ignore */ } }}>{l}</button>
              ))}
            </span>
          </span>
          <span lang={lang}>{sentence}</span>
        </div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={howDidItGo}>How did it go?</button>
        {session.callId && recordingOn && <button type="button" className="btn btn-sm" onClick={noRecording}>They don’t want this recorded</button>}
        {session.callId && recordingOn && <AttachRecording callId={session.callId} />}
        {texts?.texts?.notice_published && <button type="button" className="btn btn-sm btn-ghost" onClick={shareNotice}><Icon name="send" size={13} /> Send the privacy notice</button>}
        {session.recording?.objected && <span className="small muted">Not recorded</span>}
      </div>
    </section>
    {logging && (
      <Suspense fallback={null}>
        <LogCallDialog target={session.target} phone={session.phone} onClose={() => setLogging(false)} />
      </Suspense>
    )}
    </>
  );
}

/** Calls you started (or the phone reported) that still need "How did it go?". */
export function PendingCalls({ compact = false }) {
  const [calls, setCalls] = useState(null);
  const [logging, setLogging] = useState(null);
  const load = useCallback(() => {
    api.sales.get('/calls/pending').then((r) => setCalls(r.calls)).catch(() => setCalls([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!calls?.length) return null;
  const targetOf = (c) => (c.opportunity_id ? { opportunity_id: c.opportunity_id }
    : { account_id: c.account_id, ...(c.contact_id ? { contact_id: c.contact_id } : {}) });
  return (
    <section className="card pending-calls" aria-labelledby="pending-calls-title">
      <div className="card-head">
        <h3 id="pending-calls-title">Dialled: say how it went</h3>
        <Badge tone="warning">{calls.length}</Badge>
      </div>
      <ul className="plain-list card-pad stack-xs">
        {calls.slice(0, compact ? 5 : 50).map((c) => (
          <li key={c.id} className="sales-row small">
            <span className="tnum muted">{exactTime(c.started_at || c.dialled_at)}</span>
            <span className="grow truncate">{c.about || c.contact_name || phoneLabel(c.to_number || c.from_number)}</span>
            {c.connected === true && <Badge tone="good">{lengthWords(c.talk_sec, c.duration_source)}</Badge>}
            {c.connected === false && <Badge>Not answered</Badge>}
            {c.direction === 'INBOUND' && <Badge tone="brand">They called</Badge>}
            {c.lead_id ? <Link className="btn btn-sm" to={`/sales/leads/${c.lead_id}#call-outcome`}>Say how it went</Link>
              : (c.account_id || c.opportunity_id) ? <button type="button" className="btn btn-sm" onClick={() => setLogging(c)}>Say how it went</button> : null}
          </li>
        ))}
      </ul>
      {logging && (
        <Suspense fallback={null}>
          <LogCallDialog target={targetOf(logging)} phone={logging.to_number || logging.from_number} call={logging}
            onClose={() => setLogging(null)} onSaved={load} />
        </Suspense>
      )}
    </section>
  );
}

/** The recording of a call: a player behind a short-lived link, and a download for those allowed. */
export function RecordingPlayer({ call, canDownload = false }) {
  const toast = useToast();
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = async (download = false) => {
    setBusy(true);
    try {
      const r = await api.sales.post(`/calls/${call.id}/recording/link`, { download });
      if (download) window.location.href = r.url;
      else setUrl(r.url);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-xs">
      {url ? <audio controls src={url} preload="metadata" className="call-audio" aria-label={`Recording of call #${call.id}`} />
        : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => open(false)}><Icon name="sound" size={13} /> Play the recording</button>}
      {canDownload && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => open(true)}>Download</button>}
    </div>
  );
}

/** "Customer complained": what they said, and the number is opted out of calls. */
export function ComplaintDialog({ leadId = null, contactId = null, callId = null, onClose, onDone }) {
  const toast = useToast();
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.sales.post('/calls/complaint', { lead_id: leadId, contact_id: contactId, call_id: callId, what_they_said: said.trim() });
      toast.success('Complaint recorded. The number will not be called again, and administrators were told.');
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Customer complained" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" disabled={busy || said.trim().length < 3} onClick={send}>Record the complaint</button></>}>
      <div className="stack-sm">
        <p className="small">The number is opted out of calls at once, its call-backs and retries stop, and administrators are told.</p>
        <Field label="What did they say? *"><textarea className="textarea" rows={3} value={said} autoFocus onChange={(e) => setSaid(e.target.value)} placeholder="In their words, as near as you can" /></Field>
      </div>
    </Modal>
  );
}

/** The source of a call's length, as a badge. */
export function LengthBadge({ sec, source }) {
  if (sec === null || sec === undefined) return null;
  const [, tone] = LENGTH_SOURCE[source] || [null, 'neutral'];
  return <Badge tone={tone}>{lengthWords(sec, source)}</Badge>;
}

/**
 * The TaskFlow Android app, for people who log calls: in the app, the way to
 * this phone's setup; in a browser, a private download link (made fresh, valid
 * for a short time).
 */
export function PhoneAppCard() {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can('crm.activity.log')) return null;
  const inApp = Boolean(phoneBridge());
  const download = async () => {
    setBusy(true);
    try {
      const r = await api.sales.post('/calling/app/link', {});
      if (!r.url) toast.error('No version of the app has been uploaded yet. Ask an administrator.');
      else window.location.href = r.url;
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="phone-app-title">
      <div className="card-head"><h2 id="phone-app-title">Calls from a company phone</h2></div>
      <div className="card-pad stack-sm">
        {inApp ? (
          <>
            <p className="small">This is the TaskFlow app. Its setup chooses the company SIM, asks for the permissions it needs and finds the recordings folder.</p>
            <div><Link className="btn btn-sm btn-primary" to="/phone-setup">Phone setup</Link></div>
          </>
        ) : (
          <>
            <p className="small">On a company Android phone, the TaskFlow app dials on the company SIM when you tap Call, logs each call’s exact length, and picks up recordings where the phone makes them. Only calls with leads and customers are sent; every other call stays on the phone.</p>
            <p className="small muted">Company phones usually get the app from the company’s device management. Otherwise, download it here on the phone and allow “Install unknown apps” for the browser when Android asks.</p>
            <div><button type="button" className="btn btn-sm" disabled={busy} onClick={download}><Icon name="download" size={13} /> Download the Android app</button></div>
          </>
        )}
      </div>
    </section>
  );
}
