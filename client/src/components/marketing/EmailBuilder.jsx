import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Field, Icon } from '../ui.jsx';
import {
  BLOCKS, CONDITION_KINDS, SOCIAL_NETWORKS, blockSummary, designHasHindi, insertAt, moveItem, newBlock, pick, setLang, withIds,
} from '../../lib/marketing.js';
import { AiAssist, LangSwitch, MergeTagMenu, PreviewFrame } from './parts.jsx';

const NEW = 'application/x-taskflow-block-new';
const MOVE = 'application/x-taskflow-block-move';

/** A text box that edits one language of a { en, hi } field. */
function LangText({ value, lang, onChange, rows = 4, placeholder, multiline = true, mergeTags, customFields, ai, aiContext, aiAvailable, label }) {
  const ref = useRef(null);
  const text = pick(value, lang);
  const insert = (tag) => {
    const el = ref.current;
    const at = el ? el.selectionStart ?? text.length : text.length;
    onChange(setLang(value, lang, `${text.slice(0, at)}${tag}${text.slice(at)}`));
  };
  const Input = multiline ? 'textarea' : 'input';
  return (
    <div className="stack-sm">
      <Input ref={ref} className={multiline ? 'textarea' : 'input'} rows={multiline ? rows : undefined} dir="auto" lang={lang}
        aria-label={label ? `${label}${lang === 'hi' ? ' (Hindi)' : ''}` : undefined}
        placeholder={lang === 'hi' ? 'हिन्दी में लिखें (खाली छोड़ें तो अंग्रेज़ी दिखेगी)' : placeholder}
        value={text} onChange={(e) => onChange(setLang(value, lang, e.target.value))} />
      <div className="row wrap" style={{ gap: 6 }}>
        {mergeTags && <MergeTagMenu tags={mergeTags} customFields={customFields} onInsert={insert} />}
        {ai && (
          <AiAssist available={aiAvailable} tasks={lang === 'hi' ? ['translate_en', 'rewrite', 'shorten'] : ['rewrite', 'shorten', 'translate_hi', ...(multiline ? ['draft'] : [])]}
            text={text || pick(value, 'en')} language={lang} context={aiContext}
            onPick={(s, task) => {
              if (task === 'translate_hi') onChange(setLang(value, 'hi', s));
              else if (task === 'translate_en') onChange(setLang(value, 'en', s));
              else onChange(setLang(value, lang, s));
            }} />
        )}
      </div>
    </div>
  );
}

function ConditionEditor({ condition, onChange, meta }) {
  const c = condition || {};
  const set = (patch) => onChange({ ...c, ...patch });
  return (
    <div className="stack-sm">
      <select className="select" value={c.type || ''} onChange={(e) => onChange(e.target.value ? { type: e.target.value, op: e.target.value === 'tag' ? 'has' : 'is', value: '' } : null)}>
        {CONDITION_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {c.type === 'language' && (
        <select className="select" value={c.value || 'en'} onChange={(e) => set({ value: e.target.value })}>
          <option value="en">English readers</option><option value="hi">Hindi readers</option>
        </select>
      )}
      {c.type === 'tag' && (
        <div className="row">
          <select className="select" style={{ width: 150 }} value={c.op || 'has'} onChange={(e) => set({ op: e.target.value })}>
            <option value="has">has the tag</option><option value="not_has">does not have</option>
          </select>
          <input className="input" value={c.value || ''} placeholder="dealer" onChange={(e) => set({ value: e.target.value })} />
        </div>
      )}
      {c.type === 'crm' && (
        <select className="select" value={c.value || 'LEAD'} onChange={(e) => set({ value: e.target.value })}>
          {[['LEAD', 'Leads'], ['CUSTOMER', 'Customers'], ['PARTNER', 'Partners'], ['NONE', 'Not in the pipeline']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      )}
      {c.type === 'audience' && (
        <div className="row">
          <select className="select" style={{ width: 130 }} value={c.op || 'is'} onChange={(e) => set({ op: e.target.value })}>
            <option value="is">on</option><option value="is_not">not on</option>
          </select>
          <select className="select" value={c.value || ''} onChange={(e) => set({ value: Number(e.target.value) })}>
            <option value="">Choose…</option>
            {(meta?.audiences || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}
      {c.type === 'field' && (
        <div className="stack-sm">
          <select className="select" value={c.key || ''} onChange={(e) => set({ key: e.target.value })}>
            <option value="">Choose a field…</option>
            {['city', 'state', 'organization', 'designation'].map((k) => <option key={k} value={k}>{k}</option>)}
            {(meta?.custom_fields || []).map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
          </select>
          <div className="row">
            <select className="select" style={{ width: 130 }} value={c.op || 'is'} onChange={(e) => set({ op: e.target.value })}>
              {[['is', 'is'], ['is_not', 'is not'], ['contains', 'contains'], ['empty', 'is empty'], ['not_empty', 'is filled in']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {!['empty', 'not_empty'].includes(c.op) && <input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value })} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ImagePicker({ value, onChange }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { asset } = await api.mkt.send('/assets', file, file.type || 'application/octet-stream', { filename: file.name });
      onChange(asset.url);
      toast.success('Image uploaded');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <input className="input" value={value || ''} placeholder="https://…/picture.jpg" onChange={(e) => onChange(e.target.value)} />
      <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
        <Icon name="image" size={13} /> {busy ? 'Uploading…' : 'Upload an image'}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <div className="field-hint">PNG, JPEG, GIF or WebP up to 2 MB. Mail apps fetch it from TaskFlow’s public address.</div>
    </div>
  );
}

function BlockProperties({ block, lang, onChange, meta, aiContext }) {
  const set = (patch) => onChange({ ...block, ...patch });
  const common = { lang, mergeTags: meta?.merge_tags, customFields: meta?.custom_fields, aiAvailable: meta?.ai, aiContext };
  const align = (
    <Field label="Align">
      <div className="row">
        {['left', 'center', 'right'].map((a) => (
          <button key={a} type="button" className={`btn btn-sm${(block.align || 'left') === a ? ' btn-primary' : ''}`} onClick={() => set({ align: a })}>{a}</button>
        ))}
      </div>
    </Field>
  );
  return (
    <div className="stack">
      {block.type === 'heading' && (
        <>
          <Field label="Heading"><LangText label="Heading" {...common} multiline={false} value={block.text} onChange={(text) => set({ text })} ai /></Field>
          <Field label="Size">
            <select className="select" value={block.level === 2 ? 2 : 1} onChange={(e) => set({ level: Number(e.target.value) })}>
              <option value={1}>Large</option><option value={2}>Medium</option>
            </select>
          </Field>
          {align}
        </>
      )}
      {block.type === 'text' && (
        <>
          <Field label="Text" hint="**bold**, *italic*, [link words](https://…), a line starting with “- ” for a list, a blank line for a new paragraph.">
            <LangText label="Text" {...common} rows={8} value={block.text} onChange={(text) => set({ text })} ai />
          </Field>
          {align}
        </>
      )}
      {block.type === 'button' && (
        <>
          <Field label="Button words"><LangText label="Button words" {...common} multiline={false} value={block.text} onChange={(text) => set({ text })} /></Field>
          <Field label="Link" hint="Clicks are tracked; a click can create a follow-up task.">
            <input className="input" value={block.href || ''} onChange={(e) => set({ href: e.target.value })} placeholder="https://soildoctor.in/…" />
          </Field>
          <Field label="Colour">
            <input className="input" type="color" value={block.color || '#1f7a4d'} onChange={(e) => set({ color: e.target.value })} style={{ width: 80, padding: 2 }} />
          </Field>
          {align}
        </>
      )}
      {block.type === 'image' && (
        <>
          <Field label="Picture"><ImagePicker value={block.src} onChange={(src) => set({ src })} /></Field>
          <Field label="Description for people who cannot see it"><LangText label="Description for people who cannot see it" {...common} multiline={false} mergeTags={null} value={block.alt} onChange={(alt) => set({ alt })} /></Field>
          <Field label="Link (optional)"><input className="input" value={block.href || ''} onChange={(e) => set({ href: e.target.value })} placeholder="https://" /></Field>
          {align}
        </>
      )}
      {block.type === 'columns' && (block.columns || []).map((col, i) => {
        const setCol = (patch) => set({ columns: block.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
        return (
          <div key={i} className="mkt-subcard stack-sm">
            <div className="small dim">{i === 0 ? 'Left' : 'Right'} column</div>
            <Field label="Title"><LangText label="Title" {...common} multiline={false} mergeTags={null} value={col.title} onChange={(title) => setCol({ title })} /></Field>
            <Field label="Text"><LangText label="Text" {...common} rows={3} value={col.text} onChange={(text) => setCol({ text })} /></Field>
            <Field label="Picture (optional)"><ImagePicker value={col.image} onChange={(image) => setCol({ image })} /></Field>
            <div className="grid-2">
              <Field label="Link words"><LangText label="Link words" {...common} multiline={false} mergeTags={null} value={col.button_text} onChange={(t) => setCol({ button_text: t })} /></Field>
              <Field label="Link"><input className="input" value={col.button_href || ''} onChange={(e) => setCol({ button_href: e.target.value })} placeholder="https://" /></Field>
            </div>
          </div>
        );
      })}
      {block.type === 'spacer' && (
        <Field label="Height (pixels)"><input className="input" type="number" min={4} max={120} value={block.height || 24} onChange={(e) => set({ height: Number(e.target.value) })} /></Field>
      )}
      {block.type === 'social' && (
        <Field label="Links">
          <div className="stack-sm">
            {(block.links || []).map((l, i) => (
              <div key={i} className="row">
                <select className="select" style={{ width: 130 }} value={l.network} onChange={(e) => set({ links: block.links.map((x, j) => (j === i ? { ...x, network: e.target.value } : x)) })}>
                  {SOCIAL_NETWORKS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select>
                <input className="input" value={l.url} onChange={(e) => set({ links: block.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove link" onClick={() => set({ links: block.links.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ links: [...(block.links || []), { network: 'facebook', url: 'https://' }] })}>
              <Icon name="plus" size={13} /> Add a link
            </button>
          </div>
        </Field>
      )}
      {block.type === 'html' && (
        <Field label="HTML" hint="Scripts, forms and frames are removed before sending. Links are still tracked.">
          <LangText label="HTML" {...common} rows={8} mergeTags={null} value={block.html} onChange={(html) => set({ html })} />
        </Field>
      )}
      <Field label="Who sees this block" hint="Dynamic content: show it only to some people.">
        <ConditionEditor condition={block.condition} meta={meta} onChange={(condition) => set({ condition })} />
      </Field>
    </div>
  );
}

function DesignSettings({ settings = {}, onChange }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  const logo = settings.logo || {};
  return (
    <div className="stack">
      <div className="small muted">Select a block to edit it, or set the email’s look here.</div>
      <div className="grid-2">
        <Field label="Brand colour"><input className="input" type="color" value={settings.brandColor || '#1f7a4d'} onChange={(e) => set({ brandColor: e.target.value, linkColor: e.target.value })} style={{ padding: 2 }} /></Field>
        <Field label="Background"><input className="input" type="color" value={settings.background || '#eef2ee'} onChange={(e) => set({ background: e.target.value })} style={{ padding: 2 }} /></Field>
      </div>
      <Field label="Logo at the top"><ImagePicker value={logo.src} onChange={(src) => set({ logo: src ? { ...logo, src, width: logo.width || 160 } : null })} /></Field>
      {logo.src && (
        <div className="grid-2">
          <Field label="Logo width"><input className="input" type="number" min={60} max={300} value={logo.width || 160} onChange={(e) => set({ logo: { ...logo, width: Number(e.target.value) } })} /></Field>
          <Field label="Logo link"><input className="input" value={logo.href || ''} onChange={(e) => set({ logo: { ...logo, href: e.target.value } })} placeholder="https://" /></Field>
        </div>
      )}
      <div className="field-hint">The footer — your company, postal address, why they get this, unsubscribe and preferences — is added to every email and cannot be removed.</div>
    </div>
  );
}

/**
 * The drag-and-drop builder. Drag a block from the left into the email, drag
 * blocks to reorder (or use the arrows — everything works without a mouse),
 * and edit the selected block on the right. The preview is rendered by the
 * server exactly as it will be sent.
 */
export default function EmailBuilder({ design: initial, onChange, subject = '', preheader = '', meta, readOnly = false, aiContext = '' }) {
  const toast = useToast();
  const [design, setDesign] = useState(() => withIds(initial || { blocks: [] }));
  const [selected, setSelected] = useState(null);
  const [lang, setLang_] = useState('en');
  const [view, setView] = useState('edit');
  const [width, setWidth] = useState('desktop');
  const [preview, setPreview] = useState(null);
  const [dropAt, setDropAt] = useState(null);
  const [sample, setSample] = useState('');

  const update = useCallback((next) => {
    setDesign(next);
    onChange?.(next);
  }, [onChange]);

  const blocks = design.blocks || [];
  const selectedIndex = blocks.findIndex((b) => b.id === selected);
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex] : null;

  const add = (type, index = blocks.length) => {
    const block = newBlock(type);
    update({ ...design, blocks: insertAt(blocks, index, block) });
    setSelected(block.id);
  };
  const move = (from, to) => update({ ...design, blocks: moveItem(blocks, from, to) });
  const replace = (block) => update({ ...design, blocks: blocks.map((b) => (b.id === block.id ? block : b)) });
  const remove = (id) => { update({ ...design, blocks: blocks.filter((b) => b.id !== id) }); setSelected(null); };
  const duplicate = (index) => {
    const copy = { ...structuredClone(blocks[index]), id: newBlock('divider').id };
    update({ ...design, blocks: insertAt(blocks, index + 1, copy) });
    setSelected(copy.id);
  };

  const onDrop = (index) => (event) => {
    event.preventDefault();
    setDropAt(null);
    if (readOnly) return;
    const type = event.dataTransfer.getData(NEW);
    if (type) return add(type, index);
    const from = event.dataTransfer.getData(MOVE);
    if (from !== '') move(Number(from), index);
    return undefined;
  };
  const dropZone = (index) => (
    <div className={`mkt-drop${dropAt === index ? ' is-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDropAt(index); }}
      onDragLeave={() => setDropAt((d) => (d === index ? null : d))}
      onDrop={onDrop(index)} aria-hidden="true" />
  );

  useEffect(() => {
    if (view !== 'preview') return undefined;
    let live = true;
    const body = { design: { settings: design.settings, blocks: design.blocks.map(({ id, ...b }) => b) }, subject, preheader, lang };
    if (sample) body.contact_id = Number(sample);
    api.mkt.post('/preview', body).then((r) => live && setPreview(r)).catch((err) => live && toast.error(err));
    return () => { live = false; };
  }, [view, lang, design, subject, preheader, sample]);

  return (
    <div className="mkt-builder">
      <div className="row-between wrap mkt-builder-bar">
        <div className="tabs" role="tablist" style={{ borderBottom: 0 }}>
          {[['edit', 'Build'], ['preview', 'Preview']].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        <div className="row wrap">
          <LangSwitch value={lang} onChange={setLang_} hasHindi={designHasHindi(design)} />
          {view === 'preview' && (
            <>
              <div className="mkt-lang" role="group" aria-label="Screen size">
                {[['desktop', 'Computer'], ['phone', 'Phone']].map(([k, l]) => (
                  <button key={k} type="button" className={`mkt-lang-btn${width === k ? ' active' : ''}`} aria-pressed={width === k} onClick={() => setWidth(k)}>{l}</button>
                ))}
              </div>
              <input className="input" style={{ width: 150, height: 30 }} placeholder="Contact id to preview as" value={sample} onChange={(e) => setSample(e.target.value.replace(/\D/g, ''))} />
            </>
          )}
        </div>
      </div>

      {view === 'preview' ? (
        <div className="stack-sm">
          {preview?.contact && <div className="small muted">{preview.contact.id ? `Shown as ${preview.contact.first_name || preview.contact.email} would see it` : 'Shown with a made-up sample person'}, in {lang === 'hi' ? 'Hindi' : 'English'}. Links in the preview are not tracked.</div>}
          <PreviewFrame html={preview?.html} width={width} />
        </div>
      ) : (
        <div className={`mkt-builder-grid${readOnly ? ' is-readonly' : ''}`}>
          {!readOnly && (
            <div className="mkt-palette" aria-label="Blocks you can add">
              <div className="small dim" style={{ fontWeight: 600 }}>Drag into the email, or click to add</div>
              {Object.entries(BLOCKS).map(([type, b]) => (
                <button key={type} type="button" className="mkt-palette-item" draggable
                  onDragStart={(e) => { e.dataTransfer.setData(NEW, type); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => add(type, selectedIndex >= 0 ? selectedIndex + 1 : blocks.length)} title={b.hint}>
                  <Icon name={b.icon} size={14} /> <span>{b.label}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mkt-canvas" style={{ '--mkt-bg': design.settings?.background || '#eef2ee' }}>
            <div className="mkt-canvas-paper">
              {dropZone(0)}
              {blocks.length === 0 && <div className="mkt-canvas-empty">Drag a block here to start, or pick a template.</div>}
              {blocks.map((block, index) => (
                <div key={block.id}>
                  <div className={`mkt-block${selected === block.id ? ' is-selected' : ''}${block.condition?.type ? ' is-conditional' : ''}`}
                    draggable={!readOnly}
                    onDragStart={(e) => { e.dataTransfer.setData(MOVE, String(index)); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => setSelected(block.id)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(block.id); } }}
                    aria-label={`${BLOCKS[block.type]?.label || block.type} block`}>
                    <span className="mkt-block-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
                    <div className="grow">
                      <div className="mkt-block-type">
                        {BLOCKS[block.type]?.label}
                        {block.condition?.type && <span className="badge badge-brand" style={{ height: 18 }}>Only some people</span>}
                        {lang === 'hi' && ['heading', 'text', 'button'].includes(block.type) && !pick(block.text, 'hi') && <span className="small muted">no Hindi yet</span>}
                      </div>
                      <div className={`mkt-block-text mkt-block-${block.type}`} lang={lang}>{
                        block.type === 'image' ? (block.src ? <img src={block.src} alt="" style={{ maxHeight: 90, maxWidth: '100%' }} /> : 'No picture yet')
                          : block.type === 'divider' ? <hr />
                            : (lang === 'hi' ? pick(block.text, 'hi') || blockSummary(block) : blockSummary(block)) || <span className="muted">Empty</span>
                      }</div>
                    </div>
                    {!readOnly && (
                      <div className="mkt-block-tools" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, index - 1)}><Icon name="up" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move down" disabled={index === blocks.length - 1} onClick={() => move(index, index + 2)}><Icon name="down" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Duplicate" onClick={() => duplicate(index)}><Icon name="copy" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Delete block" onClick={() => remove(block.id)}><Icon name="trash" size={13} /></button>
                      </div>
                    )}
                  </div>
                  {dropZone(index + 1)}
                </div>
              ))}
              <div className="mkt-canvas-footer">Footer: company, postal address, why they get this · Unsubscribe · Preferences</div>
            </div>
          </div>

          <div className="mkt-props card card-pad">
            <div className="row-between" style={{ marginBottom: 10 }}>
              <h3>{selectedBlock ? BLOCKS[selectedBlock.type]?.label : 'Email style'}</h3>
              {selectedBlock && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Done</button>}
            </div>
            {readOnly && <div className="small muted" style={{ marginBottom: 8 }}>This email can no longer be changed.</div>}
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
              {selectedBlock
                ? <BlockProperties block={selectedBlock} lang={lang} meta={meta} aiContext={aiContext} onChange={replace} />
                : <DesignSettings settings={design.settings} onChange={(settings) => update({ ...design, settings })} />}
            </fieldset>
          </div>
        </div>
      )}
    </div>
  );
}

/** The design as stored: without the editor's ids. */
export const cleanDesign = (design) => ({ ...(design.settings ? { settings: design.settings } : {}), blocks: (design.blocks || []).map(({ id, ...b }) => b) });
