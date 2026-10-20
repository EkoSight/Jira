import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, Icon } from '../ui.jsx';
import { CAMPAIGN_STATUS, MEMBERSHIP_STATUS, WORKFLOW_STATUS } from '../../lib/marketing.js';

// the catalogue changes only with a deploy; one fetch per session is enough
let metaPromise = null;
export function useMarketingMeta(version = 0) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!metaPromise) metaPromise = api.mkt.get('/meta').catch((err) => { metaPromise = null; throw err; });
    let live = true;
    metaPromise.then((m) => live && setMeta(m)).catch((err) => live && setError(err));
    return () => { live = false; };
  }, [version]);
  return { meta, error, reload: () => { metaPromise = null; } };
}
export const forgetMarketingMeta = () => { metaPromise = null; };

export function CampaignBadge({ status }) {
  const meta = CAMPAIGN_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
export function WorkflowBadge({ status }) {
  const meta = WORKFLOW_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
export function MembershipBadge({ status }) {
  const meta = MEMBERSHIP_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** English / Hindi switch for content written in both. */
export function LangSwitch({ value, onChange, hasHindi }) {
  return (
    <div className="mkt-lang" role="group" aria-label="Language">
      {[['en', 'English'], ['hi', 'हिन्दी']].map(([key, label]) => (
        <button key={key} type="button" className={`mkt-lang-btn${value === key ? ' active' : ''}`} aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
          {key === 'hi' && hasHindi === false && <span className="mkt-lang-empty" title="No Hindi written yet">·</span>}
        </button>
      ))}
    </div>
  );
}

const AI_TASKS = {
  subjects: 'Suggest subject lines',
  preheader: 'Suggest preview text',
  rewrite: 'Rewrite more clearly',
  shorten: 'Make it shorter',
  translate_hi: 'Translate to Hindi',
  translate_en: 'Translate to English',
  draft: 'Draft from a brief',
};

/**
 * The writing assistant: asks for suggestions and lets the person pick one.
 * Nothing is changed until they choose.
 */
export function AiAssist({ tasks, text, context, language = 'en', onPick, disabled, available }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [brief, setBrief] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const run = async (task) => {
    setBusy(task);
    setResult(null);
    try {
      const data = await api.mkt.post('/ai', { task, text: task === 'draft' ? brief : text, context, language });
      setResult({ task, suggestions: data.suggestions });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  if (available === false) {
    return (
      <span className="mkt-ai-off small muted" title="Add ANTHROPIC_API_KEY on the server to switch on the writing assistant">
        <Icon name="sparkle" size={12} /> Assistant off
      </span>
    );
  }

  return (
    <div className="mkt-ai" ref={box}>
      <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="sparkle" size={13} /> Write with AI
      </button>
      {open && (
        <div className="mkt-ai-pop card" role="dialog" aria-label="Writing assistant">
          {!result && (
            <div className="stack-sm">
              {tasks.includes('draft') && (
                <textarea className="textarea" rows={3} placeholder="What should the email say? Facts, offer, dates, link…"
                  value={brief} onChange={(e) => setBrief(e.target.value)} />
              )}
              {tasks.map((task) => (
                <button key={task} type="button" className="btn btn-sm" disabled={Boolean(busy) || (task === 'draft' ? !brief.trim() : !String(text || '').trim())}
                  onClick={() => run(task)}>
                  {busy === task ? 'Thinking…' : AI_TASKS[task]}
                </button>
              ))}
              <div className="small muted">Suggestions only — check facts, prices and dates before using one.</div>
            </div>
          )}
          {result && (
            <div className="stack-sm">
              <div className="small dim">{AI_TASKS[result.task]} — pick one to use it</div>
              {result.suggestions.length === 0 && <div className="small muted">No suggestions came back. Try again.</div>}
              {result.suggestions.map((s) => (
                <button key={s} type="button" className="mkt-ai-pick" onClick={() => { onPick(s, result.task); setOpen(false); setResult(null); }}>
                  {s}
                </button>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)}>Back</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * An email as the person would see it, in a sandboxed frame: no scripts, no
 * access to TaskFlow, links open in a new tab.
 */
export function PreviewFrame({ html, width = 'desktop', title = 'Email preview' }) {
  const doc = html ? html.replace('<head>', '<head><base target="_blank">') : '<p style="font-family:sans-serif;color:#888;padding:20px">Nothing to preview yet</p>';
  return (
    <div className={`mkt-preview mkt-preview-${width}`}>
      <iframe title={title} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />
    </div>
  );
}

/** The merge tags, as a menu that inserts one. */
export function MergeTagMenu({ tags = [], customFields = [], onInsert }) {
  return (
    <select className="select select-sm" value="" aria-label="Insert personalization" onChange={(e) => { if (e.target.value) onInsert(e.target.value); }}>
      <option value="">Personalize…</option>
      {tags.filter((t) => !t.endsWith('_url')).map((t) => <option key={t} value={`{{${t}}}`}>{t.replace(/_/g, ' ')}</option>)}
      {customFields.map((f) => <option key={f.key} value={`{{custom.${f.key}}}`}>{f.label}</option>)}
      <option value="{{first_name|there}}">first name, or “there”</option>
    </select>
  );
}

export function Stat({ label, value, note, tone }) {
  return (
    <div className="stat" style={{ cursor: 'default' }}>
      <span className="stat-label">{tone && <span className="stat-accent" style={{ background: `var(--${tone})` }} />}{label}</span>
      <span className="stat-value tnum">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

/** Copy to the clipboard, saying so. */
export function CopyButton({ text, label = 'Copy' }) {
  const toast = useToast();
  return (
    <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy; select the text and copy it'))}>
      <Icon name="copy" size={13} /> {label}
    </button>
  );
}
