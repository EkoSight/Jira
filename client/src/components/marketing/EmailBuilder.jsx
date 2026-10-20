import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Field, Icon } from '../ui.jsx';
import {
  BLOCKS, BLOCK_GROUPS, BUTTON_STYLE_LABEL, CONDITION_KINDS, GROUND_LABEL, HEADER_LABEL, LEVEL_WORDS, NUMBERS_BLOCKS, SOCIAL_NETWORKS,
  TAG_TONE_LABEL, TONE_LABEL, blockSummary, designHasHindi, insertAt, moveItem, newBlock, newItem, pick, setLang, withIds, withoutExample,
} from '../../lib/marketing.js';
import { AiAssist, LangSwitch, MergeTagMenu, PreviewFrame } from './parts.jsx';

const NEW = 'application/x-taskflow-block-new';
const MOVE = 'application/x-taskflow-block-move';

// the brand's typefaces, so the canvas looks like the email (loaded once, only here)
let fontsLoaded = false;
function useBrandFonts() {
  useEffect(() => {
    if (fontsLoaded || typeof document === 'undefined') return;
    fontsLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+Devanagari:wght@400;600;700;800&family=Source+Serif+4:ital,opsz,wght@1,8..60,400;1,8..60,500&display=swap';
    document.head.appendChild(link);
  }, []);
}

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
      {(mergeTags || ai) && (
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
      )}
    </div>
  );
}

/** The brand's own choices for one setting, as a row of buttons. */
function Choice({ value, options, onChange, label, swatch }) {
  return (
    <div className="mkt-choice" role="radiogroup" aria-label={label}>
      {Object.entries(options).map(([key, words]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={`mkt-choice-btn${value === key ? ' active' : ''}`} onClick={() => onChange(key)}>
          {swatch && <span className={`mkt-swatch sw-${swatch}-${key}`} aria-hidden="true" />}
          {Array.isArray(words) ? words[0] : words}
        </button>
      ))}
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

function ImagePicker({ value, onChange, label = 'Picture address' }) {
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
      <input className="input" aria-label={label} value={value || ''} placeholder="https://…/picture.jpg" onChange={(e) => onChange(e.target.value)} />
      <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
        <Icon name="image" size={13} /> {busy ? 'Uploading…' : 'Upload an image'}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <div className="field-hint">PNG, JPEG, GIF or WebP up to 2 MB. Use real photos from the field, not stock pictures or icons.</div>
    </div>
  );
}

/** Words, link and style of one button. */
function ButtonFields({ value, onChange, common, label = 'Button', styles = ['primary', 'secondary', 'gold', 'link'], optional = false }) {
  const b = value || {};
  const set = (patch) => onChange({ ...b, ...patch });
  if (optional && !pick(b.text) && !b.href && !b.open) {
    return <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange({ text: { en: 'Find out more', hi: '' }, href: 'https://soildoctor.in', style: styles[0], open: true })}><Icon name="plus" size={13} /> Add {label.toLowerCase()}</button>;
  }
  return (
    <div className="mkt-subcard stack-sm">
      <div className="row-between"><span className="small dim" style={{ fontWeight: 650 }}>{label}</span>
        {optional && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Remove</button>}
      </div>
      <Field label="Words" hint="Short and direct: “Book a soil test →”, “Talk to us”."><LangText label={`${label} words`} {...common} multiline={false} mergeTags={null} value={b.text} onChange={(text) => set({ text })} /></Field>
      <Field label="Link"><input className="input" value={b.href || ''} onChange={(e) => set({ href: e.target.value })} placeholder="https://soildoctor.in/…" /></Field>
      {styles.length > 1 && <Field label="Style"><Choice label={`${label} style`} value={b.style || styles[0]} options={Object.fromEntries(styles.map((k) => [k, BUTTON_STYLE_LABEL[k]]))} onChange={(style) => set({ style })} /></Field>}
    </div>
  );
}

/**
 * A list inside a section (cards, figures, readings, steps, details): each
 * item's fields, with add, remove and reorder.
 */
function ItemsEditor({ items = [], onChange, fields, kind, max = 6, noun = 'item', common }) {
  const setItem = (i, patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="stack-sm">
      {items.map((item, i) => (
        <div key={i} className="mkt-subcard stack-sm">
          <div className="row-between">
            <span className="small dim" style={{ fontWeight: 650 }}>{noun[0].toUpperCase() + noun.slice(1)} {i + 1}</span>
            <div className="row" style={{ gap: 2 }}>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Move ${noun} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveItem(items, i, i - 1))}><Icon name="up" size={13} /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Move ${noun} ${i + 1} down`} disabled={i === items.length - 1} onClick={() => onChange(moveItem(items, i, i + 2))}><Icon name="down" size={13} /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
            </div>
          </div>
          {fields.map((f) => {
            if (f.kind === 'url') return <Field key={f.key} label={f.label}><input className="input" value={item[f.key] || ''} onChange={(e) => setItem(i, { [f.key]: e.target.value })} placeholder="https://" /></Field>;
            if (f.kind === 'tone') return <Field key={f.key} label={f.label}><Choice label={f.label} swatch="tag" value={item[f.key] || 'good'} options={TAG_TONE_LABEL} onChange={(v) => setItem(i, { [f.key]: v })} /></Field>;
            if (f.kind === 'level') {
              return (
                <Field key={f.key} label={f.label} hint="Drawn on the brand scale: Soil Brown (very low) to Forest (high).">
                  <div className="mkt-levels" role="radiogroup" aria-label={f.label}>
                    {LEVEL_WORDS.map((word, n) => (
                      <button key={word} type="button" role="radio" aria-checked={Number(item.level) === n + 1} className={`mkt-level lv-${n + 1}${Number(item.level) === n + 1 ? ' active' : ''}`} onClick={() => setItem(i, { level: n + 1 })}>{word}</button>
                    ))}
                  </div>
                </Field>
              );
            }
            if (f.kind === 'image') return <Field key={f.key} label={f.label}><ImagePicker value={item.image?.src || ''} onChange={(src) => setItem(i, { image: src ? { ...(item.image || {}), src } : null })} /></Field>;
            return (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <LangText label={f.label} {...common} multiline={f.kind === 'multiline'} rows={3} mergeTags={f.kind === 'multiline' ? common.mergeTags : null} value={item[f.key]} onChange={(v) => setItem(i, { [f.key]: v })} />
              </Field>
            );
          })}
        </div>
      ))}
      {items.length < max && (
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, newItem(kind)])}>
          <Icon name="plus" size={13} /> Add {noun}
        </button>
      )}
    </div>
  );
}

function BlockProperties({ block, lang, onChange, meta, aiContext }) {
  const set = (patch) => onChange({ ...block, ...patch });
  const common = { lang, mergeTags: meta?.merge_tags, customFields: meta?.custom_fields, aiAvailable: meta?.ai, aiContext };
  const words = (key, label, { multiline = false, rows = 3, ai = false, hint, tags = multiline } = {}) => (
    <Field label={label} hint={hint}>
      <LangText label={label} {...common} multiline={multiline} rows={rows} mergeTags={tags ? common.mergeTags : null} ai={ai} value={block[key]} onChange={(v) => set({ [key]: v })} />
    </Field>
  );
  const align = (
    <Field label="Align">
      <Choice label="Align" value={block.align || 'left'} options={{ left: 'Left', center: 'Centre' }} onChange={(a) => set({ align: a })} />
    </Field>
  );
  const eyebrowHint = 'A few words above the title, in capitals with the strata dot.';
  const highlightHint = 'Words from the title to show in Deep Green (Mint on dark). Leave empty for none.';
  return (
    <div className="stack">
      {block.example && NUMBERS_BLOCKS.includes(block.type) && (
        <div className="mkt-callout is-warning small">These are the template’s example {block.type === 'quote' ? 'words' : 'figures'}. Put in real ones — the email cannot be sent until you change this section.</div>
      )}
      {block.type === 'hero' && (
        <>
          <Field label="Ground"><Choice label="Ground" swatch="tone" value={block.tone || 'sand'} options={TONE_LABEL} onChange={(tone) => set({ tone })} /></Field>
          {words('eyebrow', 'Eyebrow', { hint: eyebrowHint })}
          {words('title', 'Headline', { ai: true, hint: 'Lead with the outcome: “Sow with the right dose this Rabi”.' })}
          {words('highlight', 'Highlight', { hint: highlightHint })}
          {words('text', 'Text', { multiline: true, rows: 4, ai: true })}
          <ButtonFields label="Button" value={block.button} common={common} onChange={(button) => set({ button })} optional />
          <ButtonFields label="Second button" value={block.button2} common={common} styles={['secondary', 'link', 'primary']} onChange={(button2) => set({ button2 })} optional />
          <Field label="Photo below (optional)"><ImagePicker value={block.image?.src || ''} onChange={(src) => set({ image: src ? { ...(block.image || {}), src } : null })} /></Field>
          {align}
        </>
      )}
      {block.type === 'heading' && (
        <>
          {words('eyebrow', 'Eyebrow (optional)', { hint: eyebrowHint })}
          {words('text', 'Heading', { ai: true })}
          {words('highlight', 'Highlight', { hint: highlightHint })}
          <Field label="Size"><Choice label="Size" value={block.level === 2 ? '2' : '1'} options={{ 1: 'Large', 2: 'Medium' }} onChange={(v) => set({ level: Number(v) })} /></Field>
          {align}
        </>
      )}
      {block.type === 'text' && (
        <>
          {words('text', 'Text', { multiline: true, rows: 8, ai: true, hint: '**bold**, *italic*, [link words](https://…), a line starting with “- ” for a list, a blank line for a new paragraph.' })}
          {align}
        </>
      )}
      {block.type === 'button' && (
        <>
          <ButtonFields label="Button" value={{ text: block.text, href: block.href, style: block.style }} common={common} onChange={(b) => set({ text: b?.text, href: b?.href, style: b?.style })} />
          {align}
        </>
      )}
      {block.type === 'image' && (
        <>
          <Field label="Picture"><ImagePicker value={block.src} onChange={(src) => set({ src })} /></Field>
          {words('alt', 'Description for people who cannot see it')}
          {words('caption', 'Caption (optional)')}
          <Field label="Link (optional)"><input className="input" value={block.href || ''} onChange={(e) => set({ href: e.target.value })} placeholder="https://" /></Field>
        </>
      )}
      {block.type === 'cards' && (
        <>
          <div className="grid-2">
            <Field label="Cards on"><Choice label="Card ground" swatch="tone" value={block.tone || 'paper'} options={{ paper: 'Paper', sand: 'Sand' }} onChange={(tone) => set({ tone })} /></Field>
            <Field label="Layout"><Choice label="Layout" value={block.layout || 'grid'} options={{ grid: 'Two a row', stack: 'One a row' }} onChange={(layout) => set({ layout })} /></Field>
          </div>
          <ItemsEditor kind="cards" noun="card" max={6} common={common} items={block.items} onChange={(items) => set({ items })} fields={[
            { key: 'tag', label: 'Tag (optional)' }, { key: 'tag_tone', label: 'Tag tone', kind: 'tone' }, { key: 'title', label: 'Title' },
            { key: 'text', label: 'Text', kind: 'multiline' }, { key: 'link_text', label: 'Link words' }, { key: 'href', label: 'Link', kind: 'url' },
            { key: 'image', label: 'Photo (optional)', kind: 'image' },
          ]} />
        </>
      )}
      {block.type === 'stats' && (
        <>
          {words('eyebrow', 'Eyebrow', { hint: eyebrowHint })}
          {words('title', 'Title (optional)')}
          <ItemsEditor kind="stats" noun="figure" max={4} common={common} items={block.items} onChange={(items) => set({ items })} fields={[
            { key: 'value', label: 'Number', hint: 'A real figure: “4,212”, “−18%”, “₹1,850”.' }, { key: 'label', label: 'What it counts' },
          ]} />
          {words('note', 'Source (optional)', { hint: 'Where the figures come from, so readers can trust them.' })}
        </>
      )}
      {block.type === 'data' && (
        <>
          {words('eyebrow', 'Eyebrow', { hint: eyebrowHint })}
          {words('title', 'Title')}
          <ItemsEditor kind="data" noun="reading" max={12} common={common} items={block.rows} onChange={(rows) => set({ rows })} fields={[
            { key: 'label', label: 'What' }, { key: 'value', label: 'Reading' }, { key: 'level', label: 'Level', kind: 'level' },
            { key: 'status', label: 'Tag words (optional)', hint: 'Leave empty to show the level’s own word.' },
          ]} />
          {words('note', 'Note (optional)')}
        </>
      )}
      {block.type === 'steps' && (
        <>
          {words('eyebrow', 'Eyebrow', { hint: eyebrowHint })}
          {words('title', 'Title (optional)')}
          <ItemsEditor kind="steps" noun="step" max={8} common={common} items={block.items} onChange={(items) => set({ items })} fields={[
            { key: 'title', label: 'Step' }, { key: 'text', label: 'How', kind: 'multiline' },
          ]} />
        </>
      )}
      {block.type === 'details' && (
        <ItemsEditor kind="details" noun="detail" max={8} common={common} items={block.items} onChange={(items) => set({ items })} fields={[
          { key: 'label', label: 'Label' }, { key: 'value', label: 'Value' },
        ]} />
      )}
      {block.type === 'quote' && (
        <>
          <Field label="Card"><Choice label="Card ground" swatch="tone" value={block.tone || 'paper'} options={{ paper: 'Paper', sand: 'Sand' }} onChange={(tone) => set({ tone })} /></Field>
          {words('outcome', 'Outcome', { hint: 'The result first, as a tag: “−22% fertilizer spend”.' })}
          {words('text', 'What they said', { multiline: true, rows: 4, tags: false, hint: 'Their real words. Shown in Source Serif italic, the brand’s quote face.' })}
          <div className="grid-2">{words('name', 'Name')}{words('role', 'Role and place')}</div>
          <Field label="Photo (optional)"><ImagePicker value={block.photo || ''} onChange={(photo) => set({ photo })} /></Field>
        </>
      )}
      {block.type === 'panel' && (
        <>
          {words('eyebrow', 'Eyebrow', { hint: eyebrowHint })}
          {words('title', 'Title', { ai: true })}
          {words('highlight', 'Highlight', { hint: highlightHint })}
          {words('text', 'Text', { multiline: true, rows: 3, ai: true })}
          <ButtonFields label="Button" value={block.button} common={common} styles={['gold']} onChange={(button) => set({ button })} />
          <ButtonFields label="Text link" value={block.link} common={common} styles={['link']} onChange={(link) => set({ link })} optional />
          {align}
        </>
      )}
      {block.type === 'columns' && (block.columns || []).map((col, i) => {
        const setCol = (patch) => set({ columns: block.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
        return (
          <div key={i} className="mkt-subcard stack-sm">
            <div className="small dim">{i === 0 ? 'Left' : 'Right'} column · sent as a card</div>
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
      {block.type === 'pulse' && <div className="small muted">The pulse line from the Soil Doctor mark, drawn in the strata colours. Use it once, between two sections.</div>}
      {block.type === 'spacer' && (
        <Field label="Height (pixels)"><input className="input" type="number" min={4} max={120} value={block.height || 24} onChange={(e) => set({ height: Number(e.target.value) })} /></Field>
      )}
      {block.type === 'social' && (
        <Field label="Links">
          <div className="stack-sm">
            {(block.links || []).map((l, i) => (
              <div key={i} className="row">
                <select className="select" style={{ width: 130 }} aria-label={`Network ${i + 1}`} value={l.network} onChange={(e) => set({ links: block.links.map((x, j) => (j === i ? { ...x, network: e.target.value } : x)) })}>
                  {SOCIAL_NETWORKS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select>
                <input className="input" aria-label={`Link ${i + 1}`} value={l.url} onChange={(e) => set({ links: block.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
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
        <Field label="HTML" hint="Scripts, forms and frames are removed. Colours move to the nearest brand colour and fonts to Manrope when it is sent. Links are still tracked.">
          <LangText label="HTML" {...common} rows={10} mergeTags={null} value={block.html} onChange={(html) => set({ html })} />
        </Field>
      )}
      <Field label="Who sees this section" hint="Dynamic content: show it only to some people.">
        <ConditionEditor condition={block.condition} meta={meta} onChange={(condition) => set({ condition })} />
      </Field>
    </div>
  );
}

function DesignSettings({ settings = {}, onChange }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  return (
    <div className="stack">
      <div className="small muted">Select a section to edit it, or set the email’s frame here.</div>
      <Field label="Header">
        <div className="mkt-header-choice" role="radiogroup" aria-label="Header">
          {Object.entries(HEADER_LABEL).map(([key, [name, hint]]) => (
            <button key={key} type="button" role="radio" aria-checked={(settings.header || 'light') === key} className={`mkt-header-opt${(settings.header || 'light') === key ? ' active' : ''}`} onClick={() => set({ header: key })}>
              <span className={`mkt-header-thumb hd-${key}`} aria-hidden="true"><i /><b /></span>
              <span><strong>{name}</strong><span className="small muted">{hint}</span></span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Ground around the email"><Choice label="Ground" swatch="ground" value={settings.ground || 'sand'} options={GROUND_LABEL} onChange={(ground) => set({ ground })} /></Field>
      <div className="mkt-brand-note small">
        <span className="mkt-strata" aria-hidden="true" />
        <span>Colours, fonts, the logo and the footer come from the Soil Doctor brand guideline and are the same in every email. The footer — company, postal address, why they get this, unsubscribe and preferences — cannot be removed.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the canvas: the email, roughly as it will look

/** Text with **bold**, [links] and merge tags shown as the reader will see their place. */
function Rich({ text }) {
  const paragraphs = String(text || '').split(/\n{2,}/).filter((p) => p.trim());
  const inline = (line, key) => {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\)|\{\{\s*[a-z_.]+\s*(?:\|[^}]*)?\}\})/gi;
    let last = 0;
    for (const m of line.matchAll(re)) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      const token = m[0];
      if (token.startsWith('**')) parts.push(<strong key={`${key}-${m.index}`}>{token.slice(2, -2)}</strong>);
      else if (token.startsWith('[')) parts.push(<u key={`${key}-${m.index}`}>{token.slice(1, token.indexOf(']'))}</u>);
      else {
        const [name, fallback] = token.slice(2, -2).split('|');
        parts.push(<span key={`${key}-${m.index}`} className="sk-merge" title={`Filled in for each person${fallback ? `; “${fallback.trim()}” when unknown` : ''}`}>{name.trim().replace(/_/g, ' ').replace(/^custom\./, '')}</span>);
      }
      last = m.index + token.length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  };
  return paragraphs.map((p, i) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-•]\s+/, ''), `${i}-${j}`)}</li>)}</ul>;
    return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, `${i}-${j}`)}</Fragment>)}</p>;
  });
}

function Title({ value, highlight, lang, as: Tag = 'h3', className }) {
  const text = pick(value, lang) || pick(value, 'en');
  // a Hindi title falls back to English, and so does its highlight
  const phrase = pick(highlight, lang) || (pick(value, lang) ? '' : pick(highlight, 'en'));
  if (!text) return null;
  const at = phrase ? text.indexOf(phrase) : -1;
  return (
    <Tag className={className}>{at < 0 ? text : <>{text.slice(0, at)}<span className="sk-hl">{phrase}</span>{text.slice(at + phrase.length)}</>}</Tag>
  );
}

const Eyebrow = ({ value, lang }) => (pick(value, lang) || pick(value, 'en') ? <div className="sk-eyebrow"><span className="mkt-strata" aria-hidden="true" />{pick(value, lang) || pick(value, 'en')}</div> : null);
const Pill = ({ b, lang, dark, fallbackStyle = 'primary' }) => {
  if (!b || !(pick(b.text, lang) || pick(b.text, 'en'))) return null;
  const style = b.style || fallbackStyle;
  return <span className={`sk-btn sk-btn-${style}${dark ? ' on-dark' : ''}`}>{pick(b.text, lang) || pick(b.text, 'en')}{style === 'link' && !/→\s*$/.test(pick(b.text, lang) || pick(b.text, 'en')) ? ' →' : ''}</span>;
};
const say = (value, lang) => pick(value, lang) || pick(value, 'en');

function BlockSketch({ block, lang, brandBase }) {
  const center = block.align === 'center' ? ' is-center' : '';
  switch (block.type) {
    case 'hero': {
      const tone = block.tone || 'sand';
      return (
        <div className={`sk-hero tone-${tone}${center}`} style={tone === 'dark' && brandBase ? { backgroundImage: `url(${brandBase}/watermark.png)` } : undefined}>
          <Eyebrow value={block.eyebrow} lang={lang} />
          <Title value={block.title} highlight={block.highlight} lang={lang} as="h2" className="sk-display" />
          {say(block.text, lang) && <div className="sk-lead"><Rich text={say(block.text, lang)} /></div>}
          <div className="sk-btns"><Pill b={block.button} lang={lang} dark={tone === 'dark'} fallbackStyle={tone === 'dark' ? 'gold' : 'primary'} /><Pill b={block.button2} lang={lang} dark={tone === 'dark'} fallbackStyle="secondary" /></div>
          {block.image?.src && <img className="sk-media" src={block.image.src} alt="" />}
        </div>
      );
    }
    case 'heading': return <div className={`sk-pad${center}`}><Eyebrow value={block.eyebrow} lang={lang} /><Title value={block.text} highlight={block.highlight} lang={lang} as="h3" className={block.level === 2 ? 'sk-h3' : 'sk-h2'} /></div>;
    case 'text': return <div className={`sk-pad sk-body${center}`}><Rich text={say(block.text, lang)} /></div>;
    case 'button': return <div className={`sk-pad${center}`}><Pill b={block} lang={lang} /></div>;
    case 'image': return <div className="sk-pad">{block.src ? <img className="sk-media" src={block.src} alt="" /> : <div className="sk-empty-media">No picture yet</div>}{say(block.caption, lang) && <div className="sk-caption">{say(block.caption, lang)}</div>}</div>;
    case 'cards':
    case 'columns': {
      const items = block.type === 'columns' ? (block.columns || []).map((c) => ({ title: c.title, text: c.text, link_text: c.button_text })) : (block.items || []);
      return (
        <div className={`sk-cards${block.layout === 'stack' || items.length === 1 ? ' is-stack' : ''}`}>
          {items.map((c, i) => (
            <div key={i} className={`sk-card${block.tone === 'sand' ? ' is-sand' : ''}`}>
              {c.image?.src && <img className="sk-media" src={c.image.src} alt="" />}
              {say(c.tag, lang) && <span className={`sk-tag tag-${c.tag_tone || 'good'}`}>{say(c.tag, lang)}</span>}
              {say(c.title, lang) && <div className="sk-card-title">{say(c.title, lang)}</div>}
              {say(c.text, lang) && <div className="sk-small"><Rich text={say(c.text, lang)} /></div>}
              {say(c.link_text, lang) && <span className="sk-link">{say(c.link_text, lang)} →</span>}
            </div>
          ))}
        </div>
      );
    }
    case 'stats':
      return (
        <div className="sk-stats">
          <Eyebrow value={block.eyebrow} lang={lang} />
          {say(block.title, lang) && <div className="sk-h3 on-dark">{say(block.title, lang)}</div>}
          <div className="sk-stat-grid">{(block.items || []).slice(0, 4).map((s, i) => <div key={i}><div className="sk-stat-value">{say(s.value, lang)}</div><div className="sk-stat-label">{say(s.label, lang)}</div></div>)}</div>
          {say(block.note, lang) && <div className="sk-note on-dark">{say(block.note, lang)}</div>}
        </div>
      );
    case 'data':
      return (
        <div className="sk-panel-sand">
          <Eyebrow value={block.eyebrow} lang={lang} />
          {say(block.title, lang) && <div className="sk-card-title">{say(block.title, lang)}</div>}
          {(block.rows || []).map((r, i) => {
            const level = Math.min(5, Math.max(1, Number(r.level) || 3));
            return (
              <div key={i} className="sk-data-row">
                <span className="sk-data-label">{say(r.label, lang)}</span>
                <span className="sk-bar"><i className={`lv-${level}`} style={{ width: `${level * 20}%` }} /></span>
                <span className="sk-data-value">{say(r.value, lang)}</span>
                <span className={`sk-tag tag-${['warn', 'warn', 'info', 'good', 'good'][level - 1]}`}>{say(r.status, lang) || LEVEL_WORDS[level - 1]}</span>
              </div>
            );
          })}
          {say(block.note, lang) && <div className="sk-note">{say(block.note, lang)}</div>}
        </div>
      );
    case 'steps':
      return (
        <div className="sk-pad">
          <Eyebrow value={block.eyebrow} lang={lang} />
          {say(block.title, lang) && <div className="sk-h3">{say(block.title, lang)}</div>}
          {(block.items || []).map((s, i) => <div key={i} className="sk-step"><span className="sk-step-n">{i + 1}</span><div><div className="sk-step-title">{say(s.title, lang)}</div><div className="sk-small">{say(s.text, lang)}</div></div></div>)}
        </div>
      );
    case 'details':
      return <div className="sk-panel-sand sk-details">{(block.items || []).map((d, i) => <div key={i}><div className="sk-label">{say(d.label, lang)}</div><div className="sk-detail-value">{say(d.value, lang)}</div></div>)}</div>;
    case 'quote':
      return (
        <div className={`sk-card sk-quote${block.tone === 'sand' ? ' is-sand' : ''}`}>
          {say(block.outcome, lang) && <span className="sk-tag tag-good">{say(block.outcome, lang)}</span>}
          <blockquote lang={lang}>“{say(block.text, lang)}”</blockquote>
          <div className="sk-step-title">{say(block.name, lang)}</div><div className="sk-small">{say(block.role, lang)}</div>
        </div>
      );
    case 'panel':
      return (
        <div className={`sk-panel${center}`} style={brandBase ? { backgroundImage: `url(${brandBase}/watermark.png)` } : undefined}>
          <Eyebrow value={block.eyebrow} lang={lang} />
          <Title value={block.title} highlight={block.highlight} lang={lang} as="h3" className="sk-h2 on-dark" />
          {say(block.text, lang) && <div className="sk-body on-dark"><Rich text={say(block.text, lang)} /></div>}
          <div className="sk-btns"><Pill b={block.button ? { style: 'gold', ...block.button } : null} lang={lang} dark /><Pill b={block.link ? { ...block.link, style: 'link' } : null} lang={lang} dark /></div>
        </div>
      );
    case 'pulse': return <div className="sk-pad">{brandBase ? <img className="sk-pulse" src={`${brandBase}/pulse.png`} alt="Pulse line" /> : <hr />}</div>;
    case 'divider': return <div className="sk-pad"><hr className="sk-hr" /></div>;
    case 'spacer': return <div style={{ height: Math.min(Math.max(Number(block.height) || 24, 4), 120) / 2 }} aria-label="Space" />;
    case 'social': return <div className="sk-pad is-center sk-link">{(block.links || []).map((l) => SOCIAL_NETWORKS.find(([k]) => k === l.network)?.[1] || 'Link').join('  ·  ')}</div>;
    case 'html': return <div className="sk-pad sk-html"><span className="sk-label">Custom HTML</span><div className="sk-small">{blockSummary(block, lang) || 'Empty'}</div></div>;
    default: return <div className="sk-pad sk-small">{blockSummary(block, lang)}</div>;
  }
}

// ---------------------------------------------------------------- the brand check

function useDesignCheck(design, subject, enabled) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      const body = { design: { settings: design.settings, blocks: (design.blocks || []).map(({ id, ...b }) => b) }, subject: subject || '' };
      api.mkt.post('/design-check', body).then((r) => live && setResult(r)).catch(() => live && setResult(null));
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [design, subject, enabled]);
  return result;
}

function BrandCheck({ result }) {
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const { problems, warnings } = result;
  const total = problems.length + warnings.length;
  return (
    <div className={`mkt-check${problems.length ? ' is-critical' : warnings.length ? ' is-warning' : ' is-good'}`}>
      <button type="button" className="mkt-check-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={!total}>
        <Icon name={problems.length ? 'alert' : 'check'} size={14} />
        <span className="grow">{problems.length ? `${problems.length} to fix before sending` : warnings.length ? 'Ready to send · a few things to consider' : 'On brand and ready to send'}</span>
        {total > 0 && <span className="small">{open ? 'Hide' : `Show ${total}`}</span>}
      </button>
      {open && total > 0 && (
        <ul className="mkt-notes small">
          {problems.map((p) => <li key={p} className="is-problem">{p}</li>)}
          {warnings.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * The drag-and-drop designer. Drag a section from the left into the email,
 * drag sections to reorder (or use the arrows — everything works without a
 * mouse), and edit the selected one on the right. The canvas shows the email
 * in the brand; the preview is rendered by the server exactly as it is sent.
 */
export default function EmailBuilder({ design: initial, onChange, subject = '', preheader = '', meta, readOnly = false, aiContext = '', checks = true }) {
  useBrandFonts();
  const toast = useToast();
  const [design, setDesign] = useState(() => withIds(initial || { blocks: [] }));
  const [selected, setSelected] = useState(null);
  const [lang, setLang_] = useState('en');
  const [view, setView] = useState('edit');
  const [width, setWidth] = useState('desktop');
  const [preview, setPreview] = useState(null);
  const [dropAt, setDropAt] = useState(null);
  const [sample, setSample] = useState('');
  const check = useDesignCheck(design, subject, checks && !readOnly);
  const brandBase = meta?.public_base ? `${meta.public_base}/brand` : null;

  const update = useCallback((next) => {
    setDesign(next);
    onChange?.(next);
  }, [onChange]);

  const blocks = design.blocks || [];
  const settings = design.settings || {};
  const selectedIndex = blocks.findIndex((b) => b.id === selected);
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex] : null;

  const add = (type, index = blocks.length) => {
    const block = newBlock(type);
    update({ ...design, blocks: insertAt(blocks, index, block) });
    setSelected(block.id);
  };
  const move = (from, to) => update({ ...design, blocks: moveItem(blocks, from, to) });
  // an edited section is the team's own: no longer the template's example
  const replace = (block) => update({ ...design, blocks: blocks.map((b) => (b.id === block.id ? withoutExample(block) : b)) });
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

  const header = settings.header || 'light';
  return (
    <div className="mkt-builder">
      <div className="row-between wrap mkt-builder-bar">
        <div className="tabs" role="tablist" style={{ borderBottom: 0 }}>
          {[['edit', 'Design'], ['preview', 'Preview']].map(([k, l]) => (
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
              <input className="input" style={{ width: 150, height: 30 }} aria-label="Contact id to preview as" placeholder="Contact id to preview as" value={sample} onChange={(e) => setSample(e.target.value.replace(/\D/g, ''))} />
            </>
          )}
        </div>
      </div>
      {view === 'edit' && <BrandCheck result={check} />}

      {view === 'preview' ? (
        <div className="stack-sm">
          {preview?.contact && <div className="small muted">{preview.contact.id ? `Shown as ${preview.contact.first_name || preview.contact.email} would see it` : 'Shown with a made-up sample person'}, in {lang === 'hi' ? 'Hindi' : 'English'}. Links in the preview are not tracked.</div>}
          <PreviewFrame html={preview?.html} width={width} />
        </div>
      ) : (
        <div className={`mkt-builder-grid${readOnly ? ' is-readonly' : ''}`}>
          {!readOnly && (
            <div className="mkt-palette" aria-label="Sections you can add">
              <div className="small dim" style={{ fontWeight: 600 }}>Drag into the email, or click to add</div>
              {BLOCK_GROUPS.map(([group, title]) => (
                <div key={group} className="mkt-palette-group">
                  <div className="mkt-palette-title">{title}</div>
                  {Object.entries(BLOCKS).filter(([, b]) => b.group === group).map(([type, b]) => (
                    <button key={type} type="button" className="mkt-palette-item" draggable
                      onDragStart={(e) => { e.dataTransfer.setData(NEW, type); e.dataTransfer.effectAllowed = 'copy'; }}
                      onClick={() => add(type, selectedIndex >= 0 ? selectedIndex + 1 : blocks.length)} title={b.hint}>
                      <Icon name={b.icon} size={14} /> <span>{b.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className={`mkt-canvas ground-${settings.ground === 'paper' ? 'paper' : 'sand'}`} lang={lang}>
            {header === 'light' && brandBase && <div className="mkt-canvas-head"><img className="mkt-canvas-lockup" src={`${brandBase}/lockup-ink.png`} alt="Soil Doctor by ekosight" /></div>}
            {header === 'minimal' && <div className="mkt-canvas-head mkt-canvas-mark">{brandBase && <img src={`${brandBase}/mark-96.png`} alt="" />}<span>Soil Doctor</span></div>}
            <div className="mkt-canvas-paper">
              {header === 'dark' && <div className="mkt-canvas-band">{brandBase && <img src={`${brandBase}/lockup-paper.png`} alt="Soil Doctor by ekosight" />}</div>}
              {dropZone(0)}
              {blocks.length === 0 && <div className="mkt-canvas-empty">Drag a section here to start, or pick a template.</div>}
              {blocks.map((block, index) => (
                <div key={block.id}>
                  <div className={`mkt-block${selected === block.id ? ' is-selected' : ''}${block.condition?.type ? ' is-conditional' : ''}`}
                    draggable={!readOnly}
                    onDragStart={(e) => { e.dataTransfer.setData(MOVE, String(index)); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => setSelected(block.id)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(block.id); } }}
                    aria-label={`${BLOCKS[block.type]?.label || block.type} section`}>
                    <div className="mkt-block-label">
                      <span className="mkt-block-grip" aria-hidden="true"><Icon name="grip" size={12} /></span>
                      {BLOCKS[block.type]?.label}
                      {block.example && <span className={`mkt-flag${NUMBERS_BLOCKS.includes(block.type) ? ' is-warn' : ''}`}>{NUMBERS_BLOCKS.includes(block.type) ? 'Example figures — replace' : 'Example wording'}</span>}
                      {block.condition?.type && <span className="mkt-flag">Only some people</span>}
                    </div>
                    <BlockSketch block={block} lang={lang} brandBase={brandBase} />
                    {!readOnly && (
                      <div className="mkt-block-tools" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, index - 1)}><Icon name="up" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move down" disabled={index === blocks.length - 1} onClick={() => move(index, index + 2)}><Icon name="down" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Duplicate" onClick={() => duplicate(index)}><Icon name="copy" size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Delete section" onClick={() => remove(block.id)}><Icon name="trash" size={13} /></button>
                      </div>
                    )}
                  </div>
                  {dropZone(index + 1)}
                </div>
              ))}
            </div>
            <div className="mkt-canvas-footer">
              {brandBase && <img src={`${brandBase}/mark-96.png`} alt="" />}
              <strong>Turning soil data into farmer prosperity</strong>
              <span>Company · postal address · why they get this · Unsubscribe · Preferences</span>
            </div>
          </div>

          <div className="mkt-props card card-pad">
            <div className="row-between" style={{ marginBottom: 10 }}>
              <h3>{selectedBlock ? BLOCKS[selectedBlock.type]?.label : 'Email frame'}</h3>
              {selectedBlock && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Done</button>}
            </div>
            {readOnly && <div className="small muted" style={{ marginBottom: 8 }}>This email can no longer be changed.</div>}
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {selectedBlock
                ? <BlockProperties block={selectedBlock} lang={lang} meta={meta} aiContext={aiContext} onChange={replace} />
                : <DesignSettings settings={design.settings} onChange={(s) => update({ ...design, settings: s })} />}
            </fieldset>
          </div>
        </div>
      )}
    </div>
  );
}

/** The design as stored: without the editor's ids, and only the frame settings the brand allows. */
export const cleanDesign = (design) => {
  const s = design.settings || {};
  return {
    settings: { header: ['light', 'dark', 'minimal'].includes(s.header) ? s.header : 'light', ground: s.ground === 'paper' ? 'paper' : 'sand' },
    blocks: (design.blocks || []).map(({ id, ...b }) => {
      // an optional button that was opened but never filled in is not kept
      for (const key of ['button', 'button2', 'link']) if (b[key] && !pick(b[key].text) && !b[key].href) delete b[key];
      for (const key of ['button', 'button2', 'link']) if (b[key]?.open) { const { open, ...rest } = b[key]; b[key] = rest; }
      return b;
    }),
  };
};
