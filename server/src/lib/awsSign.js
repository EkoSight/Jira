/**
 * AWS Signature Version 4, for calling Amazon SES without the AWS SDK.
 *
 * The algorithm is AWS's published one: a canonical request, a string to sign
 * over the request date and credential scope, and an HMAC-SHA256 chain from
 * the secret key. Tested against AWS's own documented example.
 */

import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256 = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

// RFC 3986 encoding, as AWS expects it
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signingKey(secret, date, region, service) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Signs a request. Returns the headers to send (including Authorization and
 * X-Amz-Date). `headers` must include Host.
 */
export function signRequest({
  method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, now = new Date(),
}) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const all = { ...headers, 'x-amz-date': amzDate };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;

  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  if (!lower.host) lower.host = u.host;
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = u.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';

  const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, date, region, service)).update(stringToSign, 'utf8').digest('hex');

  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    __debug: { canonicalRequest, stringToSign, signature },
  };
}
