/**
 * A raw email message (RFC 5322 / MIME), built by hand so every provider that
 * takes raw mail — Amazon SES, any SMTP server — sends exactly the same bytes.
 *
 * Text and HTML go as multipart/alternative, UTF-8, base64 (safe for Hindi and
 * any line length). Headers with non-ASCII words (a Hindi subject, a sender
 * name) are RFC 2047 encoded.
 */

import crypto from 'node:crypto';

const ASCII = /^[\x20-\x7e]*$/;

/** One header value, encoded when it is not plain ASCII. Long values are split into words. */
export function encodeWord(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (ASCII.test(text)) return text;
  // split on characters, not bytes, so a Devanagari letter is never cut in half
  const chunks = [];
  let current = '';
  for (const ch of text) {
    if (Buffer.byteLength(current + ch, 'utf8') > 45) {
      chunks.push(current);
      current = '';
    }
    current += ch;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** "Name" <address>, with the name encoded or quoted as needed. */
export function formatAddress(email, name) {
  const address = String(email || '').trim();
  if (!name) return address;
  const clean = String(name).replace(/[\r\n"]/g, '').trim();
  if (!clean) return address;
  return ASCII.test(clean) ? `"${clean}" <${address}>` : `${encodeWord(clean)} <${address}>`;
}

const base64Lines = (text) => Buffer.from(String(text ?? ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();

const headerSafe = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * Builds the message.
 *   { from, fromName, to, toName, replyTo, subject, html, text, headers: {Name: value}, messageId, date, domain }
 * Returns { raw, messageId }.
 */
export function buildMime({
  from, fromName, to, toName, replyTo, subject, html, text, headers = {}, messageId, date = new Date(), domain,
}) {
  const host = domain || String(from || '').split('@')[1] || 'localhost';
  const id = messageId || `<${crypto.randomUUID()}@${host}>`;
  const boundary = `tf_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${formatAddress(to, toName)}`,
    ...(replyTo ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || value === undefined || value === null) continue;
    lines.push(`${name}: ${headerSafe(value)}`);
  }
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ];
  return { raw: [...lines, ...parts].join('\r\n'), messageId: id };
}

/** Reads a raw message back into its parts — used by tests and the outbox preview. */
export function parseMime(raw) {
  const [head, ...rest] = String(raw).split('\r\n\r\n');
  const headers = {};
  let last = null;
  for (const line of head.split('\r\n')) {
    if (/^\s/.test(line) && last) headers[last] += line.trim();
    else {
      const i = line.indexOf(':');
      last = line.slice(0, i).toLowerCase();
      headers[last] = line.slice(i + 1).trim();
    }
  }
  const decodeWords = (v) => String(v || '').replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (w, b) => Buffer.from(b, 'base64').toString('utf8'));
  const body = rest.join('\r\n\r\n');
  const part = (type) => {
    const m = body.match(new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
    return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : null;
  };
  return { headers, subject: decodeWords(headers.subject), text: part('text/plain'), html: part('text/html') };
}
