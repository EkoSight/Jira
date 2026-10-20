/**
 * The pages people outside TaskFlow see: the preference and unsubscribe page,
 * confirmations, and hosted signup forms. Plain server-rendered HTML with no
 * scripts, so they work on any phone and leak nothing.
 */

import { escapeHtml as e } from '../../lib/emailRender.js';

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

/** A whole page around some content. */
export function page({ title, body, lang = 'en', company = 'EkoSight' }) {
  return `<!DOCTYPE html>
<html lang="${lang === 'hi' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)} · ${e(company)}</title>
<style>
  :root { --ink:#1f2a24; --muted:#5b6b61; --line:#d9e2db; --brand:#1f7a4d; --bg:#eef2ee; --card:#ffffff; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e7eee9; --muted:#a5b3aa; --line:#33403a; --brand:#4fb07c; --bg:#141a17; --card:#1c2420; --danger:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 'Segoe UI', Roboto, 'Noto Sans Devanagari', 'Nirmala UI', Arial, sans-serif; }
  main { max-width:560px; margin:32px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:22px; margin:0 0 8px; line-height:1.3; }
  h2 { font-size:15px; margin:20px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  label.row { display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-top:1px solid var(--line); }
  label.row:first-of-type { border-top:0; }
  input[type=checkbox] { width:18px; height:18px; margin-top:3px; accent-color:var(--brand); }
  input[type=text], input[type=email], input[type=number], input[type=date], select { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font:inherit; background:var(--card); color:var(--ink); }
  .field { margin-bottom:14px; } .field span { display:block; font-size:14px; font-weight:600; margin-bottom:4px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
  button { font:inherit; border-radius:8px; padding:10px 18px; cursor:pointer; border:1px solid var(--line); background:var(--card); color:var(--ink); }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
  button.danger { color:var(--danger); border-color:var(--danger); }
  button:focus-visible, input:focus-visible, select:focus-visible { outline:3px solid var(--brand); outline-offset:2px; }
  .notice { background:color-mix(in srgb, var(--brand) 12%, transparent); border-radius:8px; padding:10px 12px; margin-bottom:14px; }
  .hp { position:absolute; left:-5000px; width:1px; height:1px; overflow:hidden; }
  footer { text-align:center; margin:18px 0 32px; }
</style>
</head>
<body><main><div class="card">${body}</div><footer class="muted">${e(company)}</footer></main></body>
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
