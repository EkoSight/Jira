import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, BASE } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Badge, Field, Icon, Spinner } from '../components/ui.jsx';
import { PhoneAppCard } from '../components/sales/PhoneCall.jsx';
import { exactTime } from '../lib/crmWork.js';
import { phoneBridge } from '../lib/phoneBridge.js';
import { brandOf } from '../lib/phoneCalls.js';

/** What each permission is for, said before Android asks. */
const PERMISSIONS = [
  ['phone', 'Phone calls', 'Dial on the company SIM when you tap Call, and know when the call ends.'],
  ['callLog', 'Call history', 'Read the time and length of calls with leads and customers. Every other call is checked on the phone and never sent.'],
  ['audio', 'Audio files', 'Find the recording of a call with a lead in the folder you choose, and remove the phone’s copy once TaskFlow has it. No other file is touched.'],
  ['notifications', 'Notifications', 'Tell you when the phone needs attention, for example when recordings stop arriving.'],
];

const MODE_WORDS = {
  AUTOMATIC: ['Recordings are picked up automatically', 'good'],
  SHARE_BY_HAND: ['Recordings are shared by hand', 'warning'],
  NONE: ['This phone does not record calls', 'neutral'],
  UNKNOWN: ['Not confirmed yet', 'warning'],
};

/** The steps that depend on the make of the phone. Each is confirmed by the person: Android cannot check them. */
const BRAND_STEPS = {
  samsung: [
    ['autoRecord', 'Automatic call recording is on in Samsung’s Phone app', 'Phone app → ⋮ → Settings → Record calls → Auto record calls.'],
    ['wifiCallingOff', 'Wi-Fi Calling is off for the company SIM', 'Settings → Connections → Wi-Fi Calling. Calls over Wi-Fi may not be recorded.'],
  ],
  oppo: [
    ['odialerDefault', 'ODialer is the default phone app', 'Install ODialer, then Settings → Apps → Default apps → Phone app → ODialer. The phone app TaskFlow sees now is shown above.'],
    ['autoRecord', 'Auto-record is on in ODialer', 'ODialer → Settings → Call recording → Auto record.'],
    ['testCall', 'One test call was made and recorded', 'This creates the recordings folder, so it can be chosen below.'],
  ],
  motorola: [
    ['understood', 'I understand recordings are not picked up automatically on this phone', 'Google’s Phone app keeps its recordings inside the app. To add one to TaskFlow: Phone app → Recents → the call → the recording → Share → TaskFlow. Where the Phone app offers it, let it delete old recordings by itself.'],
  ],
};

function Step({ done, title, children, state }) {
  return (
    <li className={`setup-step${done ? ' is-done' : ''}`}>
      <span className="setup-step-mark" aria-hidden="true">{done ? <Icon name="check" size={14} /> : null}</span>
      <div className="stack-xs grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <h3 className="setup-step-title">{title}</h3>
          {state}
        </div>
        {children}
      </div>
    </li>
  );
}

/**
 * Setting up a company phone in the TaskFlow Android app: who uses it, the
 * company phone policy, the work SIM, permissions, battery, the make's own
 * recording steps and the recordings folder. Each is checked where Android
 * allows, and confirmed by the person where it does not. In a browser it says
 * how to get the app.
 */
export default function PhoneSetup() {
  const bridge = phoneBridge();
  const { user, can } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [lang, setLang] = useState('en');
  const [agree, setAgree] = useState(false);

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const [info, status, perms, sims, battery, policy] = await Promise.all([
        bridge.phoneInfo(), bridge.status(), bridge.checkPermissions(), bridge.listSims().catch(() => ({ sims: [] })),
        bridge.batteryStatus().catch(() => ({ unrestricted: null })), api.sales.get('/calling/policy'),
      ]);
      setState({ info, status, perms, sims: sims.sims || [], battery, policy });
    } catch (err) {
      setState({ error: err.message || 'The phone did not answer' });
    }
  }, [bridge]);
  useEffect(() => { load(); }, [load]);

  if (!bridge) {
    return (
      <div className="stack page-narrow">
        <h1>Calls from a company phone</h1>
        <PhoneAppCard />
      </div>
    );
  }
  if (!state) return <Spinner label="Checking this phone" />;
  if (state.error) return <div className="card card-pad critical-text small">{state.error}</div>;

  const { info, status, perms, sims, battery, policy } = state;
  const config = status.config || {};
  const mine = status.configured && status.userId === user.id;
  const setup = status.setup || {};
  const brand = brandOf(info.maker);
  const steps = BRAND_STEPS[brand] || [];
  const mode = config.recording_mode || status.recordingMode || { mode: 'UNKNOWN' };
  const needsFolder = brand === 'samsung' || brand === 'oppo' || mode.mode === 'AUTOMATIC';
  const policyText = policy.texts?.staff_policy?.[lang];
  const acknowledged = policy.policy?.acknowledged;
  const allPerms = PERMISSIONS.every(([k]) => perms[k] === 'granted');

  const run = async (key, fn, done) => {
    if (busy) return;
    setBusy(key);
    try {
      const r = await fn();
      if (done) toast.success(typeof done === 'function' ? done(r) : done);
      await load();
    } catch (err) {
      if (err?.message !== 'cancelled') toast.error(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const register = () => run('register', async () => {
    const r = await api.sales.post('/calling/devices/register', {
      install_id: info.installId,
      info: { maker: info.maker, model: info.model, android_version: info.androidVersion, app_version: info.appVersion, dialler_package: info.diallerPackage },
    });
    await bridge.configure({ apiBase: `${window.location.origin}${BASE}`, token: r.token, deviceId: r.device.id, userId: user.id, userName: user.full_name, recordingMode: r.recording_mode });
    return r;
  }, 'This phone now logs your calls with leads and customers');
  const acknowledge = () => run('policy', async () => {
    await api.sales.post('/calling/policy/ack', { version: policy.policy.version, device_id: status.deviceId || null });
    await bridge.heartbeat().catch(() => {});
  }, 'Thank you');
  const confirm = (key, value) => run(`setup-${key}`, async () => {
    await bridge.saveSetup({ setup: { ...setup, [key]: value } });
    await bridge.heartbeat().catch(() => {});
  });

  return (
    <div className="stack page-narrow phone-setup">
      <div className="stack-xs">
        <h1>Set up this phone for calls</h1>
        <p className="small muted">
          {[info.maker, info.model].filter(Boolean).join(' ')} · Android {info.androidVersion} · TaskFlow app {info.appVersion}
          {info.diallerLabel ? ` · phone app: ${info.diallerLabel}` : ''}
        </p>
      </div>

      <ol className="setup-steps plain-list">
        <Step done={mine} title="Use this phone for my calls"
          state={status.configured && !mine ? <Badge tone="warning">Signed in as {status.userName || 'someone else'}</Badge> : null}>
          <p className="small">Calls with leads and customers made on this phone are logged for the person signed in here. Earlier calls stay with whoever made them.</p>
          {!mine && can('crm.activity.log') && (
            <div><button type="button" className="btn btn-sm btn-primary" disabled={busy === 'register'} onClick={register}>{status.configured ? 'Switch this phone to me' : 'Use this phone for my calls'}</button></div>
          )}
          {!can('crm.activity.log') && <p className="small critical-text">Calling from a company phone needs permission to log calls. Ask an administrator.</p>}
        </Step>

        <Step done={acknowledged} title="Company phone policy" state={acknowledged ? <Badge tone="good">Understood {exactTime(policy.policy.acknowledged_at)}</Badge> : null}>
          <div className="row" style={{ gap: 4 }} role="group" aria-label="Language">
            {[['en', 'English'], ['hi', 'हिंदी']].map(([k, l]) => (
              <button key={k} type="button" className={`kind-chip${lang === k ? ' is-active' : ''}`} aria-pressed={lang === k} onClick={() => setLang(k)}>{l}</button>
            ))}
          </div>
          <blockquote className="setup-policy" lang={lang}>{policyText || 'The policy text has not been written yet. Ask an administrator.'}</blockquote>
          {!acknowledged && mine && policyText && (
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I understand</label>
              <button type="button" className="btn btn-sm btn-primary" disabled={!agree || busy === 'policy'} onClick={acknowledge}>Save</button>
            </div>
          )}
          {!acknowledged && <p className="small muted">Until this is done, the app does not dial through TaskFlow or send anything.</p>}
        </Step>

        <Step done={Boolean(status.workSim)} title="The company SIM"
          state={status.workSim ? <Badge tone="good">{status.workSim.label}{status.workSim.number ? ` · ${status.workSim.number}` : ''}</Badge> : null}>
          {sims.length === 0 ? <p className="small muted">No SIM was found. Allow “Phone calls” below, then try again.</p>
            : sims.length === 1 ? <p className="small muted">This phone has one SIM: it is used for calls from TaskFlow.</p> : (
              <Field label="Calls from TaskFlow use">
                <select className="select" value={status.workSim?.id ?? ''} disabled={busy === 'sim'}
                  onChange={(e) => e.target.value && run('sim', () => bridge.setWorkSim({ id: Number(e.target.value) }), 'Saved')}>
                  <option value="">Choose the company SIM…</option>
                  {sims.map((s) => <option key={s.id} value={s.id}>{s.label}{s.number ? ` · ${s.number}` : ''} (slot {s.slot + 1})</option>)}
                </select>
              </Field>
            )}
          <p className="small muted">Only calls on this SIM are looked at.</p>
        </Step>

        <Step done={allPerms} title="Permissions">
          <ul className="plain-list stack-xs">
            {PERMISSIONS.map(([k, label, why]) => (
              <li key={k} className="setup-perm">
                <Badge tone={perms[k] === 'granted' ? 'good' : perms[k] === 'denied' ? 'critical' : 'warning'}>{perms[k] === 'granted' ? 'Allowed' : perms[k] === 'denied' ? 'Refused' : 'Not asked yet'}</Badge>
                <span className="small"><strong>{label}:</strong> {why}</span>
              </li>
            ))}
          </ul>
          {!allPerms && (
            <div className="row wrap" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'perms'} onClick={() => run('perms', () => bridge.requestPermissions({ permissions: PERMISSIONS.map(([k]) => k) }))}>Allow</button>
              {PERMISSIONS.some(([k]) => perms[k] === 'denied') && <button type="button" className="btn btn-sm" onClick={() => bridge.openAppSettings()}>Open the app’s settings</button>}
            </div>
          )}
        </Step>

        <Step done={battery.unrestricted === true} title="Battery: let TaskFlow work in the background"
          state={battery.unrestricted === true ? <Badge tone="good">Unrestricted</Badge> : null}>
          <p className="small">Android stops background work to save battery, and calls would then reach TaskFlow late. Set TaskFlow’s battery use to “Unrestricted” (or “Don’t optimise”).</p>
          {battery.unrestricted !== true && <div><button type="button" className="btn btn-sm" onClick={() => run('battery', () => bridge.openBatterySettings())}>Open battery settings</button></div>}
        </Step>

        <Step done={steps.length > 0 && steps.every(([k]) => setup[k] === true)} title="Recording on this phone"
          state={<Badge tone={MODE_WORDS[mode.mode]?.[1]}>{MODE_WORDS[mode.mode]?.[0]}</Badge>}>
          {!config.recordings && <p className="small muted">Recording is switched off in TaskFlow for now: calls are logged with their length, and recordings are neither picked up nor accepted.</p>}
          {steps.length === 0 && <p className="small muted">An administrator confirms how this make of phone records calls. Until then, recordings can be attached by hand to each call.</p>}
          <ul className="plain-list stack-xs">
            {steps.map(([k, label, how]) => (
              <li key={k}>
                <label className="row small setup-confirm" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={setup[k] === true} disabled={!mine || busy === `setup-${k}`} onChange={(e) => confirm(k, e.target.checked)} />
                  <span><strong>{label}</strong><br /><span className="muted">{how}</span></span>
                </label>
              </li>
            ))}
          </ul>
        </Step>

        {needsFolder && (
          <Step done={Boolean(status.folder)} title="The recordings folder" state={status.folder ? <Badge tone="good">{status.folder.name}</Badge> : null}>
            <p className="small">Choose the folder where this phone saves call recordings. TaskFlow looks only there, only for recordings of calls with leads and customers.</p>
            {mode.folder_hint && <p className="small muted">On this phone it is usually: {mode.folder_hint}</p>}
            <div><button type="button" className="btn btn-sm" disabled={!mine || busy === 'folder'} onClick={() => run('folder', () => bridge.pickRecordingsFolder(), (r) => `Folder chosen: ${r.name}`)}>{status.folder ? 'Choose another folder' : 'Choose the folder'}</button></div>
          </Step>
        )}
      </ol>

      {mine && (
        <section className="card card-pad stack-sm" aria-label="Syncing">
          <div className="row wrap" style={{ gap: 8 }}>
            <strong className="grow">Syncing</strong>
            <span className="small muted">{status.lastSyncAt ? `Last synced ${exactTime(status.lastSyncAt)}` : 'Not synced yet'}</span>
          </div>
          {status.lastError && <p className="small critical-text">Last problem: {status.lastError}</p>}
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={busy === 'sync' || !acknowledged} onClick={() => run('sync', () => bridge.syncNow(), (r) => `Synced: ${r.sent ?? 0} call${r.sent === 1 ? '' : 's'}, ${r.recordings ?? 0} recording${r.recordings === 1 ? '' : 's'}`)}>Sync now</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy === 'signout'} onClick={() => run('signout', () => bridge.signOut(), 'Signed out of this phone: what was waiting was sent first')}>Sign out of this phone</button>
            <Link className="btn btn-sm btn-ghost" to="/sales">Back to sales</Link>
          </div>
        </section>
      )}
    </div>
  );
}
