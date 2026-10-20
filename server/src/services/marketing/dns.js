/**
 * The sending domain's DNS, checked: SPF, DKIM, DMARC, and the provider's own
 * view where it has one. Read-only lookups; nothing is changed.
 *
 * Gmail and Yahoo have required SPF, DKIM and DMARC of bulk senders since
 * February 2024, with one-click unsubscribe and complaint rates under 0.3%.
 */

import { promises as dnsPromises } from 'node:dns';
import { activeProvider, providerName } from './providers.js';

let resolver = dnsPromises;
// tests answer for the internet
export function setResolverForTests(fake) { resolver = fake || dnsPromises; }

const txt = async (name) => {
  try {
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'ENOTIMP'].includes(err.code)) return [];
    throw err;
  }
};
const cname = async (name) => {
  try { return await resolver.resolveCname(name); } catch { return []; }
};

const SPF_INCLUDES = { ses: 'amazonses.com', brevo: 'spf.brevo.com', smtp: null, log: null };

export async function checkDomain(domain, { dkimSelectors = [] } = {}) {
  const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) return { domain: name, error: 'Enter the domain you send from, like ekosight.com' };
  const provider = providerName();
  const out = { domain: name, provider, checks: [] };
  // a domain that does not answer at all (or a server with no DNS) is not the
  // same as one with no records: say so rather than report everything missing
  if (resolver.resolveNs) {
    try {
      await resolver.resolveNs(name);
    } catch (err) {
      return { ...out, ready: false, error: `${name} could not be looked up in DNS from this server (${err.code || err.message}). Check the spelling; if it is right, the server cannot reach DNS — check from your DNS provider’s dashboard instead.` };
    }
  }
  const add = (key, label, status, detail, fix = null) => out.checks.push({ key, label, status, detail, fix });

  try {
    // ---- SPF: one record, naming the provider
    const spf = (await txt(name)).filter((r) => /^v=spf1\b/i.test(r));
    const include = SPF_INCLUDES[provider];
    if (!spf.length) {
      add('spf', 'SPF', 'missing', 'No SPF record.', `Add a TXT record on ${name}: v=spf1 ${include ? `include:${include} ` : ''}include:_spf.google.com ~all`);
    } else if (spf.length > 1) {
      add('spf', 'SPF', 'problem', `There are ${spf.length} SPF records; receivers treat that as none.`, 'Merge them into one TXT record.');
    } else if (include && !spf[0].includes(include)) {
      // with SES and a custom MAIL FROM domain, SPF is checked on that subdomain instead
      add('spf', 'SPF', 'warning', spf[0], `If you do not use a custom MAIL FROM domain, add include:${include} to this record.`);
    } else {
      add('spf', 'SPF', 'ok', spf[0]);
    }

    // ---- DKIM: the selectors the provider gave, or the provider's own status
    if (provider === 'ses') {
      try {
        const identity = await activeProvider().identity(name);
        if (identity.dkimStatus === 'SUCCESS') add('dkim', 'DKIM', 'ok', 'Amazon SES reports DKIM as verified.');
        else {
          add('dkim', 'DKIM', 'missing', `Amazon SES reports DKIM as ${identity.dkimStatus || 'not started'}.`,
            identity.dkimTokens.length
              ? `Add CNAME records: ${identity.dkimTokens.map((t) => `${t}._domainkey.${name} → ${t}.dkim.amazonses.com`).join('; ')}`
              : 'Create the domain identity in Amazon SES (Easy DKIM) and add the three CNAME records it gives.');
        }
        if (!identity.verified) add('identity', 'Domain in Amazon SES', 'missing', 'SES has not verified this domain for sending yet.');
        else add('identity', 'Domain in Amazon SES', 'ok', 'Verified for sending.');
      } catch (err) {
        add('dkim', 'DKIM', 'unknown', `Could not ask Amazon SES: ${err.message}`);
      }
    } else if (dkimSelectors.length) {
      for (const selector of dkimSelectors) {
        const host = `${selector}._domainkey.${name}`;
        const [records, aliases] = await Promise.all([txt(host), cname(host)]);
        if (records.some((r) => /v=DKIM1|k=rsa|p=/i.test(r)) || aliases.length) add(`dkim:${selector}`, `DKIM (${selector})`, 'ok', aliases[0] ? `Points to ${aliases[0]}` : 'Key published.');
        else add(`dkim:${selector}`, `DKIM (${selector})`, 'missing', `Nothing at ${host}.`, 'Publish the DKIM record your email provider gives you.');
      }
    } else {
      add('dkim', 'DKIM', 'unknown', 'No DKIM selector is set, so it cannot be checked here.', 'Add the selector your provider gave you (Settings → Sending domain), e.g. "brevo1".');
    }

    // ---- DMARC: present, and the policy
    const dmarc = (await txt(`_dmarc.${name}`)).find((r) => /^v=DMARC1\b/i.test(r));
    if (!dmarc) {
      add('dmarc', 'DMARC', 'missing', 'No DMARC record.', `Add a TXT record on _dmarc.${name}: v=DMARC1; p=none; rua=mailto:dmarc@${name} (start with p=none, move to quarantine once reports look clean)`);
    } else {
      const policy = (dmarc.match(/\bp=(\w+)/i) || [])[1] || 'none';
      add('dmarc', 'DMARC', policy.toLowerCase() === 'none' ? 'warning' : 'ok', dmarc,
        policy.toLowerCase() === 'none' ? 'p=none meets the bulk-sender rule; move to quarantine once the reports show only your own mail.' : null);
    }
  } catch (err) {
    out.error = `The DNS lookup failed: ${err.message}`;
  }
  out.ready = out.checks.length > 0 && !out.checks.some((c) => ['missing', 'problem'].includes(c.status));
  return out;
}
