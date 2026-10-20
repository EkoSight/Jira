/**
 * The pages people outside TaskFlow see: the preference and unsubscribe page,
 * confirmations, and hosted signup forms. Plain server-rendered HTML with no
 * scripts, so they work on any phone and leak nothing; in the Soil Doctor
 * brand, like the emails that link to them.
 */

import { escapeHtml as e } from '../../lib/emailRender.js';
import { BRAND, FONTS, TAGLINE } from '../../lib/brand.js';
import { publicBase } from './core.js';

const WORDS = {
  en: {
    preferences: 'Your email preferences',
    hello: (name) => (name ? `Hello ${name},` : 'Hello,'),
    intro: 'Choose what you would like to hear about. You can come back and change this at any time.',
    audiences: 'Lists you are on',
    topics: 'What we send you',
    save: 'Save my choices',
    leaveAll: 'Unsubscribe from all emails',
    leaveThis: (a) => `Unsubscribe from ${a}`,
    saved: 'Your choices are saved.',
    done: 'You are unsubscribed',
    doneAll: 'You will not get any more marketing emails from us. Sorry to see you go.',
    doneOne: (a) => `You will not get more emails on ${a}.`,
    rejoin: 'Changed your mind? You can subscribe again from any of our signup forms.',
    notFound: 'This link is not valid any more. If you want to stop our emails, reply to any of them with “unsubscribe”.',
    language: 'Language',
  },
  hi: {
    preferences: 'आपकी ईमेल पसंद',
    hello: (name) => (name ? `नमस्ते ${name},` : 'नमस्ते,'),
    intro: 'चुनें कि आप किस बारे में सुनना चाहते हैं। आप इसे कभी भी बदल सकते हैं।',
    audiences: 'आप इन सूचियों में हैं',
    topics: 'हम आपको क्या भेजते हैं',
    save: 'मेरी पसंद सहेजें',
    leaveAll: 'सभी ईमेल से सदस्यता समाप्त करें',
    leaveThis: (a) => `${a} से सदस्यता समाप्त करें`,
    saved: 'आपकी पसंद सहेज ली गई है।',
    done: 'आपकी सदस्यता समाप्त हो गई है',
    doneAll: 'अब आपको हमारी ओर से कोई मार्केटिंग ईमेल नहीं मिलेगा।',
    doneOne: (a) => `अब आपको ${a} पर ईमेल नहीं मिलेंगे।`,
    rejoin: 'मन बदल गया? आप हमारे किसी भी साइनअप फ़ॉर्म से फिर से जुड़ सकते हैं।',
    notFound: 'यह लिंक अब मान्य नहीं है।',
    language: 'भाषा',
  },
};

export const wordsFor = (lang) => WORDS[lang] || WORDS.en;

/** A whole page around some content, in the Soil Doctor brand. */
export function page({ title, body, lang = 'en', company = 'EkoSight' }) {
  const brand = `${publicBase()}/brand`;
  return `<!DOCTYPE html>
<html lang="${lang === 'hi' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<title>${e(title)} · Soil Doctor</title>
<link rel="icon" href="${brand}/mark-96.png">
<link rel="stylesheet" href="${FONTS.link}">
<style>
  :root { --deep:${BRAND.deepGreen}; --forest:${BRAND.forest}; --ink:${BRAND.ink}; --body:${BRAND.body}; --muted:${BRAND.muted};
    --paper:${BRAND.paper}; --sand:${BRAND.sand}; --sand-hover:${BRAND.sandHover}; --mint:${BRAND.mint};
    --line:rgba(16,21,16,.09); --line-strong:rgba(16,21,16,.16);
    --strata:linear-gradient(180deg,#9DDCF8 0 22%,#FFF 22% 25%,#AED252 25% 50%,#FFF 50% 54%,#8B5E3B 54% 75%,#FFF 75% 78%,#593C28 78%); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--sand); color:var(--body); font:16px/1.55 ${FONTS.sans}; -webkit-font-smoothing:antialiased; }
  main { max-width:580px; margin:0 auto; padding:28px 16px 40px; }
  .logo { display:block; width:150px; height:auto; margin:0 0 20px 6px; }
  .card { background:var(--paper); border:1px solid var(--line); border-radius:28px; padding:34px 32px 30px; box-shadow:0 18px 40px rgba(7,63,42,.06); }
  h1 { font-size:30px; line-height:1.1; font-weight:800; letter-spacing:-.035em; color:var(--ink); margin:0 0 12px; text-wrap:balance; }
  h2 { display:flex; align-items:center; gap:10px; font-size:13px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--forest); margin:26px 0 8px; }
  h2::before { content:""; width:16px; height:16px; border-radius:50%; flex-shrink:0; background:var(--strata); }
  :lang(hi) h2 { letter-spacing:0; text-transform:none; } :lang(hi) h1 { letter-spacing:0; line-height:1.35; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  label.row { display:flex; gap:12px; align-items:flex-start; padding:12px 0; border-top:1px solid var(--line); color:var(--ink); }
  label.row:first-of-type { border-top:0; }
  input[type=checkbox] { width:18px; height:18px; margin-top:3px; accent-color:var(--deep); }
  input[type=text], input[type=email], input[type=number], input[type=date], select { width:100%; padding:12px 14px; border:1px solid var(--line-strong); border-radius:14px; font:inherit; background:var(--paper); color:var(--ink); }
  .field { display:block; margin-bottom:16px; } .field span { display:block; font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
  :lang(hi) .field span { letter-spacing:0; text-transform:none; font-size:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:20px; }
  button { font:700 15.5px/1 ${FONTS.sans}; border-radius:999px; padding:15px 26px; cursor:pointer; border:1px solid var(--line-strong); background:var(--paper); color:var(--ink); transition:background .2s; }
  button:hover { background:var(--sand); }
  button.primary { background:var(--deep); border-color:var(--deep); color:var(--paper); }
  button.primary:hover { background:var(--forest); }
  button.danger { color:var(--ink); }
  :focus-visible { outline:2px solid var(--forest); outline-offset:2px; }
  .notice { background:var(--mint); color:var(--deep); font-weight:700; border-radius:18px; padding:12px 16px; margin-bottom:16px; }
  .hp { position:absolute; left:-5000px; width:1px; height:1px; overflow:hidden; }
  footer { text-align:center; margin:22px 0 0; }
  footer img { width:28px; height:28px; display:block; margin:0 auto 8px; }
  footer strong { display:block; color:var(--ink); font-size:13px; }
  @media (max-width:520px) { .card { padding:26px 20px 22px; border-radius:24px; } h1 { font-size:26px; } }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
</head>
<body><main>
<img class="logo" src="${brand}/lockup-ink.png" width="150" height="45" alt="Soil Doctor by ekosight">
<div class="card">${body}</div>
<footer class="muted"><img src="${brand}/mark-96.png" alt=""><strong>${e(TAGLINE)}</strong>${e(company)}</footer>
</main></body>
</html>`;
}

export function messagePage({ title, text, lang = 'en', company }) {
  return page({ title, lang, company, body: `<h1>${e(title)}</h1><p>${e(text)}</p>` });
}

/** The preference centre: lists, topics, language, and the way out. */
export function preferencesPage({ token, contact, memberships, topics, lang = 'en', company, saved = false, currentAudience = null }) {
  const w = wordsFor(lang);
  const action = `./${encodeURIComponent(token)}`;
  const lists = memberships.filter((m) => ['SUBSCRIBED', 'PENDING'].includes(m.status));
  const body = `
<h1>${e(w.preferences)}</h1>
${saved ? `<div class="notice" role="status">${e(w.saved)}</div>` : ''}
<p>${e(w.hello(contact.first_name))}</p>
<p class="muted">${e(w.intro)}</p>
<form method="post" action="${action}">
  <input type="hidden" name="action" value="save">
  ${lists.length ? `<h2>${e(w.audiences)}</h2>${lists.map((m) => `<label class="row"><input type="checkbox" name="audience_${m.audience_id}" value="1" checked><span>${e(m.audience_name)}${m.purpose ? `<br><span class="muted">${e(m.purpose)}</span>` : ''}</span></label>`).join('')}` : ''}
  ${topics.length ? `<h2>${e(w.topics)}</h2>${topics.map((t) => `<label class="row"><input type="checkbox" name="topic_${t.id}" value="1" ${t.opted_in ? 'checked' : ''}><span>${e(lang === 'hi' && t.name_hi ? t.name_hi : t.name)}${t.description ? `<br><span class="muted">${e(t.description)}</span>` : ''}</span></label>`).join('')}` : ''}
  <h2>${e(w.language)}</h2>
  <select name="language" aria-label="${e(w.language)}"><option value="en" ${contact.language !== 'hi' ? 'selected' : ''}>English</option><option value="hi" ${contact.language === 'hi' ? 'selected' : ''}>हिन्दी</option></select>
  <div class="actions"><button class="primary" type="submit">${e(w.save)}</button></div>
</form>
<form method="post" action="${action}" class="actions">
  ${currentAudience ? `<button type="submit" name="action" value="unsubscribe_audience" class="danger">${e(w.leaveThis(currentAudience.name))}</button>` : ''}
  <button type="submit" name="action" value="unsubscribe_all" class="danger">${e(w.leaveAll)}</button>
</form>`;
  return page({ title: w.preferences, lang, company, body });
}

export function unsubscribedPage({ all, audience, lang = 'en', company }) {
  const w = wordsFor(lang);
  return page({
    title: w.done, lang, company,
    body: `<h1>${e(w.done)}</h1><p>${e(all ? w.doneAll : w.doneOne(audience || ''))}</p><p class="muted">${e(w.rejoin)}</p>`,
  });
}

const FIELD_LABELS = {
  email: ['Email address', 'ईमेल पता'], first_name: ['First name', 'पहला नाम'], last_name: ['Last name', 'उपनाम'],
  phone: ['Phone', 'फ़ोन'], organization: ['Organization', 'संस्था'], designation: ['Designation', 'पद'],
  city: ['City or village', 'शहर या गाँव'], state: ['State', 'राज्य'],
};

/** A hosted signup form. */
export function formPage({ form, fields, topics, lang = 'en', company, error = null, values = {} }) {
  const hi = lang === 'hi';
  const label = (f) => f.label || (FIELD_LABELS[f.key] ? FIELD_LABELS[f.key][hi ? 1 : 0] : f.key);
  const input = (f) => {
    const name = f.key;
    const v = e(values[name] ?? '');
    const req = f.required || f.key === 'email' ? 'required' : '';
    if (f.type === 'SELECT') {
      return `<select name="${e(name)}" ${req}><option value=""></option>${(f.options || []).map((o) => `<option ${String(values[name]) === String(o) ? 'selected' : ''}>${e(o)}</option>`).join('')}</select>`;
    }
    const type = f.key === 'email' ? 'email' : f.type === 'NUMBER' ? 'number' : f.type === 'DATE' ? 'date' : 'text';
    return `<input type="${type}" name="${e(name)}" value="${v}" ${req} ${f.key === 'email' ? 'autocomplete="email"' : ''}>`;
  };
  const body = `
<h1>${e(form.title || form.name)}</h1>
${form.intro ? `<p class="muted">${e(form.intro)}</p>` : ''}
${error ? `<div class="notice" role="alert">${e(error)}</div>` : ''}
<form method="post" action="./${encodeURIComponent(form.public_id)}">
  ${fields.map((f) => `<label class="field"><span>${e(label(f))}${f.required || f.key === 'email' ? ' *' : ''}</span>${input(f)}</label>`).join('')}
  ${topics.length ? `<h2>${hi ? 'मुझे इनके बारे में बताएं' : 'Tell me about'}</h2>${topics.map((t) => `<label class="row"><input type="checkbox" name="topic_${t.id}" value="1" checked><span>${e(hi && t.name_hi ? t.name_hi : t.name)}</span></label>`).join('')}` : ''}
  <label class="row"><input type="checkbox" name="consent" value="1" required><span>${e(form.consent_text)}</span></label>
  <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <div class="actions"><button class="primary" type="submit">${hi ? 'सदस्यता लें' : 'Subscribe'}</button></div>
</form>`;
  return page({ title: form.title || form.name, lang, company, body });
}
