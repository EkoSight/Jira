import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, downloadFile } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import EmailBuilder, { cleanDesign } from './EmailBuilder.jsx';
import { LangSwitch, PreviewFrame } from './parts.jsx';
import { TEMPLATE_CATEGORIES, fileSlug, newBlock, pick, templateSource } from '../../lib/marketing.js';

// ---------------------------------------------------------------- previews

const previews = new Map();
const previewPath = (t) => (t.key ? `/templates/starters/${t.key}/preview` : `/templates/${t.id}/preview`);
const previewKey = (t, lang) => `${t.key ? `s:${t.key}` : `t:${t.id}:${t.updated_at}`}:${lang}`;

/** The email as the server renders it for a sample reader, fetched once per version. */
function loadPreview(t, lang = 'en') {
  const key = previewKey(t, lang);
  if (!previews.has(key)) {
    previews.set(key, api.mkt.get(previewPath(t), { lang }).then((r) => r.html).catch((err) => { previews.delete(key); throw err; }));
  }
  return previews.get(key);
}

/** A live, scaled-down picture of the email, loaded when it scrolls into view. */
function TemplateThumb({ template }) {
  const box = useRef(null);
  const [html, setHtml] = useState(null);
  const [scale, setScale] = useState(0.36);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let live = true;
    const fit = () => setScale(el.clientWidth / 680 || 0.36);
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    const start = () => loadPreview(template).then((h) => live && setHtml(h)).catch(() => live && setFailed(true));
    let io = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: '200px' });
      io.observe(el);
    } else start();
    return () => { live = false; ro?.disconnect(); io?.disconnect(); };
  }, [template.key, template.id, template.updated_at]);
  return (
    <div className="mkt-thumb" ref={box} aria-hidden="true">
      {html
        ? <iframe title="" tabIndex={-1} sandbox="" srcDoc={html} style={{ transform: `scale(${scale})` }} />
        : <div className="mkt-thumb-wait">{failed ? 'Preview not available' : 'Drawing the email…'}</div>}
    </div>
  );
}

function PreviewDialog({ template, onClose, onUse }) {
  const toast = useToast();
  const [lang, setLang] = useState('en');
  const [width, setWidth] = useState('desktop');
  const [html, setHtml] = useState(null);
  useEffect(() => {
    let live = true;
    setHtml(null);
    loadPreview(template, lang).then((h) => live && setHtml(h)).catch((err) => live && toast.error(err));
    return () => { live = false; };
  }, [template, lang]);
  const subject = pick(template.subject, lang) || pick(template.subject, 'en');
  return (
    <Modal size="lg" title={template.name} onClose={onClose}
      footer={<>{onUse && <button type="button" className="btn btn-primary" onClick={() => onUse(template)}>Use in a campaign</button>}<button type="button" className="btn" onClick={onClose}>Close</button></>}>
      <div className="stack-sm">
        <div className="row-between wrap" style={{ gap: 8 }}>
          <div className="small muted">{subject ? <>Subject: <strong style={{ color: 'var(--ink)' }}>{subject}</strong></> : 'No subject line yet'}</div>
          <div className="row wrap">
            <LangSwitch value={lang} onChange={setLang} />
            <div className="mkt-lang" role="group" aria-label="Screen size">
              {[['desktop', 'Computer'], ['phone', 'Phone']].map(([k, l]) => (
                <button key={k} type="button" className={`mkt-lang-btn${width === k ? ' active' : ''}`} aria-pressed={width === k} onClick={() => setWidth(k)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        {html ? <PreviewFrame html={html} width={width} title={`${template.name} preview`} /> : <Spinner label="Drawing the email" />}
        <div className="small muted">Shown to a sample reader, Ramesh Kumar of Kisan FPO. Links in the preview are not tracked.</div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- designing a template

const BLANK = () => ({
  settings: { header: 'light', ground: 'sand' },
  blocks: [newBlock('hero'), newBlock('text'), newBlock('panel')].map(({ id, ...b }) => b),
});
const words = (v) => ({ en: pick(v, 'en'), hi: pick(v, 'hi') });

/** The template designer: name, subject and preview text in both languages, and the email itself. */
export function TemplateDesigner({ template, meta, categories, onClose, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => ({
    id: template?.id || null,
    name: template?.name || '',
    category: template?.category || 'GENERAL',
    description: template?.description || '',
    subject: words(template?.subject),
    preheader: words(template?.preheader),
    design: template?.design || BLANK(),
  }));
  const [busy, setBusy] = useState(false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const onDesign = useCallback((d) => setDraft((x) => ({ ...x, design: cleanDesign(d) })), []);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: draft.name, category: draft.category, description: draft.description, subject: draft.subject, preheader: draft.preheader, design: cleanDesign(draft.design) };
      const { template: saved } = draft.id ? await api.mkt.patch(`/templates/${draft.id}`, body) : await api.mkt.post('/templates', body);
      toast.success('Template saved');
      onSaved?.(saved);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="mkt-wide" title={draft.id ? `Design “${template.name}”` : 'Design a new template'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button></>}>
      <div className="stack">
        <div className="mkt-template-form">
          <Field label="Name"><input className="input" autoFocus={!draft.id} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Rabi advisory — Sehore" /></Field>
          <Field label="Category">
            <select className="select" value={draft.category} onChange={(e) => set({ category: e.target.value })}>
              {Object.entries(categories).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="What it is for (optional)"><input className="input" value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Before sowing, for farmers in one district" /></Field>
        </div>
        <div className="mkt-template-form">
          <Field label="Subject line" hint="Specific and outcome-led. No emoji, no capitals.">
            <input className="input" value={draft.subject.en} onChange={(e) => set({ subject: { ...draft.subject, en: e.target.value } })} placeholder="Sow with the right dose this Rabi" />
          </Field>
          <Field label="Subject line in Hindi"><input className="input" lang="hi" dir="auto" value={draft.subject.hi} onChange={(e) => set({ subject: { ...draft.subject, hi: e.target.value } })} /></Field>
          <Field label="Preview text" hint="Shown after the subject in the inbox."><input className="input" value={draft.preheader.en} onChange={(e) => set({ preheader: { ...draft.preheader, en: e.target.value } })} /></Field>
          <Field label="Preview text in Hindi"><input className="input" lang="hi" dir="auto" value={draft.preheader.hi} onChange={(e) => set({ preheader: { ...draft.preheader, hi: e.target.value } })} /></Field>
        </div>
        <EmailBuilder design={draft.design} meta={meta} subject={draft.subject.en} preheader={draft.preheader.en} aiContext={draft.description || draft.name} onChange={onDesign} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- uploading a template

const NOTE_ICON = { good: 'check', info: 'bulb', warn: 'alert' };

function UploadDialog({ categories, onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('GENERAL');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const choose = (f) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast.error('The file is over 8 MB'); return; }
    setFile(f);
  };
  const upload = async () => {
    setBusy(true);
    try {
      const r = await api.mkt.send('/templates/upload', file, 'application/octet-stream', { filename: file.name, name, category });
      setResult(r);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    return (
      <Modal title="Template uploaded" onClose={() => onDone(result.template, null)}
        footer={<>
          <button type="button" className="btn" onClick={() => onDone(result.template, 'preview')}><Icon name="eye" size={13} /> Preview</button>
          <button type="button" className="btn btn-primary" onClick={() => onDone(result.template, 'design')}>Open in the designer</button>
        </>}>
        <div className="stack">
          <div><strong>{result.template.name}</strong> is saved with your templates. Here is what was changed so it follows the Soil Doctor brand guideline:</div>
          <ul className="mkt-report">
            {result.report.notes.map((n, i) => (
              <li key={i} className={`is-${n.tone}`}><Icon name={NOTE_ICON[n.tone] || 'bulb'} size={14} /><span>{n.text}</span></li>
            ))}
          </ul>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Upload a template" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!file || busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
      <div className="stack">
        <label className={`mkt-dropzone${over ? ' is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); }}>
          <Icon name="upload" size={22} />
          <strong>{file ? file.name : 'Drop a file here, or choose one'}</strong>
          <span className="small muted">{file ? `${Math.round(file.size / 1024)} KB` : 'An HTML email (.html) or a TaskFlow template (.json)'}</span>
          <input type="file" accept=".html,.htm,.json,text/html,application/json" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
        </label>
        <div className="grid-2">
          <Field label="Name (optional)" hint="Otherwise taken from the file."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Category">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(categories).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div className="mkt-brand-note small">
          <span className="mkt-strata" aria-hidden="true" />
          <span>
            Works with templates exported from Mailchimp, Brevo, Campaign Monitor or HubSpot, or made by a designer. Styles are written onto the
            layout, merge tags such as *|FNAME|* become TaskFlow’s, images inside the file are hosted, scripts and forms are removed, and every
            colour and font moves onto the Soil Doctor brand. The Soil Doctor header and footer are added around it.
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- choosing a template (campaigns)

/** A gallery to start an email from: the team's templates first, then the starters. */
export function TemplatePicker({ onPick, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.mkt.get('/templates').then(setData).catch(() => setData({ starters: [], saved: [] })); }, []);
  return (
    <Modal title="Start from a template" onClose={onClose} size="lg">
      {!data ? <Spinner /> : (
        <div className="stack">
          {[['Your templates', data.saved], ['Soil Doctor starters', data.starters]].map(([title, list]) => list.length > 0 && (
            <div key={title} className="stack-sm">
              <h3>{title}</h3>
              <div className="mkt-gallery">
                {list.map((t) => (
                  <button key={t.id || t.key} type="button" className="mkt-tcard" onClick={() => onPick(t)}>
                    <TemplateThumb template={t} />
                    <span className="mkt-tcard-body"><span className="mkt-tcard-name">{t.name}</span><span className="small muted">{t.description}</span></span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- the Templates tab

export default function MarketingTemplates({ meta }) {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const manage = can('marketing.manage');
  const [data, setData] = useState(null);
  const [archived, setArchived] = useState(false);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(null);
  const [designing, setDesigning] = useState(null);
  const [uploading, setUploading] = useState(false);
  const load = useCallback(() => api.mkt.get('/templates', { archived: archived ? 'true' : undefined }).then(setData).catch((err) => toast.error(err)), [archived]);
  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => ({ ...TEMPLATE_CATEGORIES, ...(data?.categories || {}) }), [data]);
  const matches = (t) => (!category || t.category === category)
    && (!search.trim() || `${t.name} ${t.description || ''} ${pick(t.subject)}`.toLowerCase().includes(search.trim().toLowerCase()));

  const use = async (t) => {
    try {
      const { campaign } = await api.mkt.post('/campaigns', {
        name: t.name, design: t.design, create_task: true,
        subject: pick(t.subject, 'en') || null, subject_hi: pick(t.subject, 'hi') || null,
        preheader: pick(t.preheader, 'en') || null, preheader_hi: pick(t.preheader, 'hi') || null,
      });
      navigate(`/marketing/campaigns/${campaign.id}`);
    } catch (err) { toast.error(err); }
  };
  const copyStarter = async (t) => {
    try {
      const { template } = await api.mkt.post(`/templates/starters/${t.key}/copy`, {});
      await load();
      setDesigning(template);
      toast.success(`Copied “${t.name}” to your templates`);
    } catch (err) { toast.error(err); }
  };
  const duplicate = async (t) => {
    try {
      await api.mkt.post('/templates', { name: `Copy of ${t.name}`, category: t.category, description: t.description, subject: t.subject, preheader: t.preheader, design: t.design, source: t.source });
      await load();
      toast.success('Template copied');
    } catch (err) { toast.error(err); }
  };
  const setArchivedFlag = async (t, value) => {
    try { await api.mkt.patch(`/templates/${t.id}`, { is_archived: value }); await load(); toast.success(value ? 'Template archived' : 'Template restored'); } catch (err) { toast.error(err); }
  };
  const exportFile = (t) => downloadFile(api.mkt.url(t.key ? `/templates/starters/${t.key}/export` : `/templates/${t.id}/export`), `${fileSlug(t.name)}.json`).catch((err) => toast.error(err));

  if (!data) return <Spinner label="Loading templates" />;
  const saved = data.saved.filter(matches);
  const starters = data.starters.filter(matches);
  const present = new Set([...data.saved, ...data.starters].map((t) => t.category));

  const card = (t, isStarter) => (
    <div key={t.id || t.key} className="mkt-tcard">
      <button type="button" className="mkt-tcard-open" onClick={() => setPreview(t)} aria-label={`Preview ${t.name}`}>
        <TemplateThumb template={t} />
      </button>
      <div className="mkt-tcard-body">
        <span className="mkt-tcard-name">{t.name}</span>
        <div className="mkt-tcard-meta">
          <Badge tone="neutral">{categories[t.category] || t.category}</Badge>
          {!isStarter && <span className="small dim">{templateSource(t.source)}</span>}
          {t.is_archived && <Badge tone="warning">Archived</Badge>}
          {t.examples > 0 && <span className="small dim" title="Replace example figures and details before sending">{t.examples} example section{t.examples === 1 ? '' : 's'}</span>}
        </div>
        {t.description && <span className="small muted">{t.description}</span>}
        <div className="mkt-tcard-actions">
          {manage && <button type="button" className="btn btn-sm btn-primary" onClick={() => use(t)}>Use</button>}
          {manage && isStarter && <button type="button" className="btn btn-sm" onClick={() => copyStarter(t)}>Copy & edit</button>}
          {manage && !isStarter && !t.is_archived && <button type="button" className="btn btn-sm" onClick={() => setDesigning(t)}>Design</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview(t)}><Icon name="eye" size={13} /> Preview</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => exportFile(t)} title="Download as a TaskFlow template file"><Icon name="download" size={13} /> Export</button>
          {manage && !isStarter && !t.is_archived && <button type="button" className="btn btn-ghost btn-sm" onClick={() => duplicate(t)}><Icon name="copy" size={13} /> Copy</button>}
          {manage && !isStarter && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setArchivedFlag(t, !t.is_archived)}>{t.is_archived ? 'Restore' : 'Archive'}</button>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div className="stack-sm" style={{ maxWidth: 720 }}>
          <div className="small muted">
            Every template is sent in the Soil Doctor brand: the logo, colours, fonts and footer are added and kept on-brand automatically,
            in English and Hindi. Design one here, copy a starter, save a campaign as a template, or upload one made elsewhere.
          </div>
        </div>
        {manage && (
          <div className="row wrap">
            <button type="button" className="btn btn-sm" onClick={() => setUploading(true)}><Icon name="upload" size={13} /> Upload a template</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDesigning({})}><Icon name="plus" size={13} /> Design a template</button>
          </div>
        )}
      </div>

      <div className="filters">
        <input className="input" style={{ maxWidth: 240 }} aria-label="Search templates" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="mkt-chips" role="group" aria-label="Category">
          <button type="button" className={`mkt-chip${!category ? ' active' : ''}`} aria-pressed={!category} onClick={() => setCategory('')}>All</button>
          {Object.entries(categories).filter(([k]) => present.has(k)).map(([k, l]) => (
            <button key={k} type="button" className={`mkt-chip${category === k ? ' active' : ''}`} aria-pressed={category === k} onClick={() => setCategory(category === k ? '' : k)}>{l}</button>
          ))}
        </div>
        <div className="grow" />
        <label className="row small"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </div>

      <h3>Your templates</h3>
      {saved.length ? <div className="mkt-gallery">{saved.map((t) => card(t, false))}</div> : (
        <EmptyState title={data.saved.length ? 'No templates match' : 'No templates of your own yet'}>
          {data.saved.length ? 'Try another category or search.' : 'Copy a starter below, design one from scratch, or upload an HTML email.'}
        </EmptyState>
      )}

      <h3>Soil Doctor starters</h3>
      <div className="small muted">Written in the brand’s voice, in English and Hindi. Figures, readings and testimonials in them are examples: a campaign cannot be sent until they are replaced with real ones.</div>
      {starters.length ? <div className="mkt-gallery">{starters.map((t) => card(t, true))}</div> : <div className="small muted">No starters match.</div>}

      {preview && <PreviewDialog template={preview} onClose={() => setPreview(null)} onUse={manage ? (t) => { setPreview(null); use(t); } : null} />}
      {designing && (
        <TemplateDesigner template={designing.id ? designing : null} meta={meta} categories={categories} onClose={() => setDesigning(null)}
          onSaved={() => { setDesigning(null); load(); }} />
      )}
      {uploading && (
        <UploadDialog categories={categories} onClose={() => setUploading(false)}
          onDone={(template, next) => { setUploading(false); load(); if (next === 'design') setDesigning(template); if (next === 'preview') setPreview(template); }} />
      )}
    </div>
  );
}
