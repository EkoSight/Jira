/**
 * Reusable email designs, and the images used in them.
 *
 * Starter templates ship with TaskFlow (English and Hindi, EkoSight's colours)
 * and are copied, never edited in place. Saved templates are the team's own.
 * Images are kept in the database and served from a public address, because
 * mail apps fetch them; only PNG, JPEG, GIF and WebP are accepted (SVG can
 * carry scripts and most mail apps do not show it).
 */

import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { publicBase } from './core.js';

const BRAND = { background: '#eef2ee', contentBackground: '#ffffff', textColor: '#1f2a24', mutedColor: '#5b6b61', linkColor: '#1f7a4d', brandColor: '#1f7a4d', width: 600, logo: null };
const SITE = 'https://soildoctor.in';

const t = (en, hi) => ({ en, hi });

export const STARTERS = [
  {
    key: 'newsletter', name: 'Monthly newsletter', category: 'NEWSLETTER',
    description: 'A short round-up: one main story, two smaller ones and a link to read more.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('This month at EkoSight', 'इस महीने EkoSight में') },
      { type: 'text', text: t('Hello {{first_name|there}},\n\nHere is what is new with Soil Doctor this month.', 'नमस्ते {{first_name|}},\n\nइस महीने Soil Doctor में क्या नया है, यहाँ पढ़ें।') },
      { type: 'heading', level: 2, text: t('The main story', 'मुख्य समाचार') },
      { type: 'text', text: t('Write two or three sentences about the most important news.', 'सबसे ज़रूरी समाचार के बारे में दो-तीन वाक्य लिखें।') },
      { type: 'button', text: t('Read more', 'और पढ़ें'), href: SITE, align: 'left' },
      { type: 'divider' },
      { type: 'columns', columns: [
        { title: t('Story two', 'दूसरा समाचार'), text: t('A sentence or two.', 'एक-दो वाक्य।'), button_text: t('Read', 'पढ़ें'), button_href: SITE },
        { title: t('Story three', 'तीसरा समाचार'), text: t('A sentence or two.', 'एक-दो वाक्य।'), button_text: t('Read', 'पढ़ें'), button_href: SITE },
      ] },
      { type: 'social', links: [{ network: 'website', url: SITE }] },
    ] },
  },
  {
    key: 'festival', name: 'Festival greeting', category: 'GREETING',
    description: 'A warm greeting for a festival or the start of a season. {{festival}} is filled in by festival automations.',
    subject: t('Warm wishes on {{festival|this festival}}', '{{festival|त्योहार}} की हार्दिक शुभकामनाएँ'),
    design: { settings: BRAND, blocks: [
      { type: 'heading', align: 'center', text: t('Happy {{festival|festival}}!', '{{festival|त्योहार}} की हार्दिक शुभकामनाएँ!') },
      { type: 'text', align: 'center', text: t('Dear {{first_name|friend}},\n\nEveryone at EkoSight wishes you and your family joy, good health and a rich harvest.', 'प्रिय {{first_name|मित्र}},\n\nEkoSight परिवार की ओर से आपको और आपके परिवार को सुख, अच्छे स्वास्थ्य और भरपूर फसल की शुभकामनाएँ।') },
      { type: 'spacer', height: 12 },
      { type: 'text', align: 'center', text: t('With best wishes,\n**The EkoSight team**', 'शुभकामनाओं सहित,\n**EkoSight टीम**') },
    ] },
  },
  {
    key: 'product', name: 'Product update or offer', category: 'PRODUCT',
    description: 'One new feature, device or offer, with a single clear action.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('Something new from Soil Doctor', 'Soil Doctor से कुछ नया') },
      { type: 'text', text: t('Hello {{first_name|there}},\n\nDescribe what is new and what it does for the reader in two short paragraphs.\n\n- The first benefit\n- The second benefit\n- The third benefit', 'नमस्ते {{first_name|}},\n\nदो छोटे अनुच्छेदों में बताएं कि नया क्या है और पाठक को इससे क्या लाभ है।\n\n- पहला लाभ\n- दूसरा लाभ\n- तीसरा लाभ') },
      { type: 'button', text: t('See how it works', 'देखें यह कैसे काम करता है'), href: SITE, align: 'center' },
    ] },
  },
  {
    key: 'follow_up', name: 'Personal follow-up', category: 'FOLLOW_UP',
    description: 'A plain, personal note to a lead — reads like an email from a person, which gets more replies.',
    design: { settings: { ...BRAND, background: '#ffffff' }, blocks: [
      { type: 'text', text: t('Hi {{first_name|there}},\n\nI wanted to follow up on our conversation about soil testing for {{organization|your farms}}.\n\nWould a short call this week help? Just reply to this email with a time that suits you.\n\nThanks,\nThe EkoSight team', 'नमस्ते {{first_name|}},\n\n{{organization|आपके खेतों}} के लिए मिट्टी जाँच पर हमारी बातचीत के बारे में मैं आपसे फिर बात करना चाहता था।\n\nक्या इस सप्ताह एक छोटी कॉल ठीक रहेगी? अपना सुविधाजनक समय बताते हुए इस ईमेल का जवाब दें।\n\nधन्यवाद,\nEkoSight टीम') },
    ] },
  },
  {
    key: 'careers', name: 'Jobs, internships and training', category: 'CAREERS',
    description: 'Openings and training programmes for students and graduates.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('Opportunities at EkoSight', 'EkoSight में अवसर') },
      { type: 'text', text: t('Hello {{first_name|there}},\n\nWe are looking for people who want to work on soil health and agriculture technology.', 'नमस्ते {{first_name|}},\n\nहम ऐसे लोगों की तलाश में हैं जो मिट्टी के स्वास्थ्य और कृषि तकनीक पर काम करना चाहते हैं।') },
      { type: 'columns', columns: [
        { title: t('Role or programme', 'पद या कार्यक्रम'), text: t('Where, how long, and who it suits.', 'कहाँ, कितने समय के लिए, और किसके लिए।'), button_text: t('Apply', 'आवेदन करें'), button_href: SITE },
        { title: t('Another opening', 'एक और अवसर'), text: t('Where, how long, and who it suits.', 'कहाँ, कितने समय के लिए, और किसके लिए।'), button_text: t('Apply', 'आवेदन करें'), button_href: SITE },
      ] },
      { type: 'text', text: t('Know someone who would be a good fit? Forward this email to them.', 'किसी ऐसे व्यक्ति को जानते हैं जो इसके लिए सही हो? यह ईमेल उन्हें भेजें।') },
    ] },
  },
  {
    key: 'industry', name: 'Industry update for FPOs', category: 'INDUSTRY',
    description: 'Schemes, policy and soil-health news for farmer producer organizations and partners.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('Industry update', 'उद्योग समाचार') },
      { type: 'text', text: t('Dear {{first_name|member}},\n\nHere are the schemes, policy changes and soil-health news that matter to {{organization|your FPO}} this month.', 'प्रिय {{first_name|सदस्य}},\n\nइस महीने {{organization|आपके FPO}} के लिए ज़रूरी योजनाएँ, नीतिगत बदलाव और मिट्टी स्वास्थ्य समाचार।') },
      { type: 'heading', level: 2, text: t('Schemes and deadlines', 'योजनाएँ और अंतिम तिथियाँ') },
      { type: 'text', text: t('- Scheme name: what it offers and the last date\n- Scheme name: what it offers and the last date', '- योजना का नाम: क्या लाभ है और अंतिम तिथि\n- योजना का नाम: क्या लाभ है और अंतिम तिथि') },
      { type: 'button', text: t('Talk to us about soil testing', 'मिट्टी जाँच के बारे में बात करें'), href: SITE, align: 'left' },
    ] },
  },
  {
    key: 'welcome', name: 'Welcome', category: 'WELCOME',
    description: 'The first email after someone joins: who you are and what they will get.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('Welcome to EkoSight', 'EkoSight में आपका स्वागत है') },
      { type: 'text', text: t('Hello {{first_name|there}},\n\nThank you for joining us. We make Soil Doctor, which tests soil on the spot and tells farmers exactly what their fields need.\n\nHere is what you can expect from us:\n\n- Useful soil-health and crop advice\n- News about Soil Doctor\n- Nothing more than a few emails a month', 'नमस्ते {{first_name|}},\n\nहमसे जुड़ने के लिए धन्यवाद। हम Soil Doctor बनाते हैं, जो मौके पर मिट्टी की जाँच करके बताता है कि खेत को ठीक-ठीक क्या चाहिए।\n\nहमसे आपको मिलेगा:\n\n- मिट्टी और फसल पर उपयोगी सलाह\n- Soil Doctor से जुड़ी खबरें\n- महीने में बस कुछ ही ईमेल') },
      { type: 'button', text: t('Visit Soil Doctor', 'Soil Doctor देखें'), href: SITE, align: 'left' },
    ] },
  },
  {
    key: 'reengage', name: 'Still interested?', category: 'REENGAGE',
    description: 'For people who have not opened anything in months: one click to stay, or they can leave.',
    design: { settings: BRAND, blocks: [
      { type: 'heading', text: t('Do you still want to hear from us?', 'क्या आप अब भी हमसे जुड़े रहना चाहते हैं?') },
      { type: 'text', text: t('Hello {{first_name|there}},\n\nWe have not heard from you in a while. If you would like to keep getting our emails, click below. If not, you can unsubscribe at the bottom of this email — no hard feelings.', 'नमस्ते {{first_name|}},\n\nकाफ़ी समय से आपसे संपर्क नहीं हुआ। यदि आप हमारे ईमेल पाते रहना चाहते हैं, तो नीचे क्लिक करें। यदि नहीं, तो इस ईमेल के नीचे से सदस्यता समाप्त कर सकते हैं।') },
      { type: 'button', text: t('Yes, keep me on the list', 'हाँ, मुझे सूची में रखें'), href: SITE, align: 'center' },
    ] },
  },
];

export async function listTemplates({ includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.category, t.description, t.design, t.is_archived, t.created_at, t.updated_at, u.full_name AS created_by_name
       FROM mkt_templates t LEFT JOIN users u ON u.id = t.created_by
      WHERE ($1 OR t.is_archived = FALSE) ORDER BY t.updated_at DESC`,
    [includeArchived],
  );
  return {
    starters: STARTERS.map((s) => ({ key: s.key, name: s.name, category: s.category, description: s.description, design: s.design, subject: s.subject || null })),
    saved: rows,
  };
}

export async function getTemplate(id) {
  const { rows } = await query('SELECT * FROM mkt_templates WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Template not found');
  return rows[0];
}

export async function saveTemplate(id, { name, category, description, design, is_archived: archived }, actor) {
  if (design !== undefined && (!design || !Array.isArray(design.blocks))) throw badRequest('The template has no design');
  if (!id) {
    if (!String(name || '').trim() || !design) throw badRequest('Give the template a name and some content');
    const { rows } = await query(
      `INSERT INTO mkt_templates (name, category, description, design, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim().slice(0, 200), String(category || 'GENERAL').toUpperCase().slice(0, 40), description || null, design, actor.id],
    );
    return rows[0];
  }
  const { rows } = await query(
    `UPDATE mkt_templates SET name = COALESCE($2, name), category = COALESCE($3, category), description = COALESCE($4, description),
            design = COALESCE($5, design), is_archived = COALESCE($6, is_archived), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, name?.trim() || null, category ? String(category).toUpperCase().slice(0, 40) : null, description ?? null, design ?? null, archived ?? null],
  );
  if (!rows[0]) throw notFound('Template not found');
  return rows[0];
}

// ---------------------------------------------------------------- images

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Checks the file really is the image type it claims, from its first bytes. */
export function sniffImage(buffer) {
  const b = buffer || Buffer.alloc(0);
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function saveAsset({ buffer, filename }, actor) {
  if (!buffer?.length) throw badRequest('No image was received');
  if (buffer.length > MAX_IMAGE_BYTES) throw badRequest('Images can be up to 2 MB; make it smaller and try again');
  const mime = sniffImage(buffer);
  if (!mime) throw badRequest('Use a PNG, JPEG, GIF or WebP image');
  const base = String(filename || 'image').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  const name = `${base}.${IMAGE_TYPES[mime]}`;
  const { rows } = await query(
    `INSERT INTO mkt_assets (public_id, filename, mime, size, data, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, public_id, filename, mime, size, created_at`,
    [crypto.randomBytes(12).toString('base64url'), name, mime, buffer.length, buffer, actor.id],
  );
  return { ...rows[0], url: assetUrl(rows[0]) };
}

export const assetUrl = (asset) => `${publicBase()}/a/${asset.public_id}/${encodeURIComponent(asset.filename)}`;

export async function listAssets() {
  const { rows } = await query(
    `SELECT a.id, a.public_id, a.filename, a.mime, a.size, a.created_at, u.full_name AS created_by_name
       FROM mkt_assets a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC LIMIT 300`,
  );
  return rows.map((a) => ({ ...a, url: assetUrl(a) }));
}

export async function readAsset(publicId) {
  const { rows } = await query('SELECT mime, data, filename FROM mkt_assets WHERE public_id = $1', [publicId]);
  return rows[0] || null;
}
