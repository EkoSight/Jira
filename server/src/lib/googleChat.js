/**
 * Talking to Google Chat.
 *
 * Outgoing: TaskFlow signs in as its service account (the three
 * GOOGLE_CHAT_* variables) with the chat.bot scope and posts messages into
 * spaces the app has been added to. No Google library is needed — the token
 * exchange is one signed JWT and one HTTPS call.
 *
 * Incoming: every request Google Chat sends to the endpoint carries a bearer
 * token signed by Google. It is verified against Google's published keys
 * before anything in the request is believed. Two audience settings exist in
 * Google Cloud and both are supported:
 *
 *   "HTTP endpoint URL" — a Google ID token whose audience is the endpoint URL
 *                          and whose email is chat@system.gserviceaccount.com.
 *   "Project number"    — a token issued by chat@system.gserviceaccount.com
 *                          whose audience is the project number.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHAT_API = 'https://chat.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const CERTS = {
  oidc: 'https://www.googleapis.com/oauth2/v1/certs',
  chat: `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`,
};

// ---------------------------------------------------------------- the private key

const BEGIN = '-----BEGIN PRIVATE KEY-----';
const END = '-----END PRIVATE KEY-----';
const parses = (pem) => { try { crypto.createPrivateKey(pem); return true; } catch { return false; } };
const wrap = (body) => `${BEGIN}\n${body.match(/.{1,64}/g).join('\n')}\n${END}\n`;

/**
 * Turns whatever ended up in GOOGLE_CHAT_PRIVATE_KEY into a usable key, or
 * says what is wrong with it. Pasting a key into an .env file goes wrong in a
 * handful of predictable ways — real line breaks cut it off, \n written as \\n,
 * a trailing comma or quotes copied from the JSON, a service manager that drops
 * backslashes — so each is undone here rather than asking people to retry.
 * Also accepts the key base64-encoded. Never returns or logs the key text.
 */
export function readPrivateKey(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { key: null, problem: 'GOOGLE_CHAT_PRIVATE_KEY is empty or missing' };

  // the whole key base64-encoded, to sidestep quoting altogether
  if (!text.includes('PRIVATE KEY') && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (decoded.includes('PRIVATE KEY')) text = decoded.trim();
  }

  // copied straight from the JSON line: "private_key": "…",
  text = text.replace(/^"?private_key"?\s*:\s*/, '').replace(/,\s*$/, '');
  for (let i = 0; i < 3 && /^(["'`]).*\1$/s.test(text); i += 1) text = text.slice(1, -1).trim();

  if (!text.includes(BEGIN)) {
    if (text.includes('BEGIN RSA PRIVATE KEY') || text.includes('BEGIN ENCRYPTED')) {
      return { key: null, problem: 'This is not the key from the Google service account JSON — use the "private_key" value from that file' };
    }
    return { key: null, problem: 'GOOGLE_CHAT_PRIVATE_KEY does not start with -----BEGIN PRIVATE KEY-----' };
  }
  if (!text.includes(END)) {
    return {
      key: null,
      problem: 'GOOGLE_CHAT_PRIVATE_KEY is cut off before -----END PRIVATE KEY-----. Usually the key was pasted over several lines without double quotes; put it on one line in double quotes, or use the command in docs/GOOGLE_CHAT.md',
    };
  }

  const inner = text.slice(text.indexOf(BEGIN) + BEGIN.length, text.indexOf(END));
  const body = inner.replace(/\\\\n|\\n|\\r|\s+/g, '');
  if (!body) return { key: null, problem: 'GOOGLE_CHAT_PRIVATE_KEY has nothing between its BEGIN and END lines' };

  const candidates = [wrap(body)];
  // a service manager that strips backslashes leaves an "n" at every line break
  if (body.startsWith('n')) {
    // n, 64 characters, n, 64 characters … last line, n
    const lines = body.slice(1).replace(/n$/, '');
    candidates.push(wrap(lines.split('').filter((_, i) => (i + 1) % 65 !== 0).join('')));
  }
  for (const pem of candidates) if (parses(pem)) return { key: pem, problem: null };

  if (/[^A-Za-z0-9+/=]/.test(body)) {
    return { key: null, problem: 'GOOGLE_CHAT_PRIVATE_KEY contains characters that are not part of a key — check for extra quotes, spaces or text pasted with it' };
  }
  return { key: null, problem: 'GOOGLE_CHAT_PRIVATE_KEY is the right shape but incomplete or altered — copy it again from the JSON file with the command in docs/GOOGLE_CHAT.md' };
}

// ---------------------------------------------------------------- configuration

let override = null;
/** Tests replace the environment's credentials; production never calls this. */
export const setChatConfig = (value) => { override = value; tokenCache = new Map(); };

let keyCache = { raw: null, result: null };

export function chatConfig() {
  const base = override || config.googleChat;
  const endpointPath = `${config.apiPrefix}/integrations/google-chat/events`;
  if (keyCache.raw !== base.privateKey) keyCache = { raw: base.privateKey, result: readPrivateKey(base.privateKey) };
  const { key, problem } = keyCache.result;
  return {
    ...base,
    privateKey: key,
    keyProblem: base.privateKey ? problem : null,
    endpointUrl: base.audience || `${config.publicUrl}${endpointPath}`,
    directoryAdmin: base.directoryAdmin || '',
    // present at all: shown as "set up" with the problem spelled out
    configured: Boolean(base.clientEmail && base.privateKey),
    usable: Boolean(base.clientEmail && key),
  };
}

// ---------------------------------------------------------------- outgoing

// one token per (scope, impersonated user), each reused until near expiry
let tokenCache = new Map();

let googleFetch = (...args) => fetch(...args);
/** Tests stand in for Google's servers; production always uses the network. */
export const setGoogleFetch = (fn) => { googleFetch = fn || ((...args) => fetch(...args)); tokenCache = new Map(); };

/**
 * Signs in as the service account. `subject` impersonates a Workspace user,
 * which only works for scopes an admin has granted under domain-wide
 * delegation (used for the read-only directory lookup).
 */
async function accessToken({ scope = SCOPE, subject = null } = {}) {
  const cfg = chatConfig();
  if (!cfg.configured) throw new ChatError('Google Chat credentials are not configured on the server', { permanent: true });
  if (!cfg.usable) throw new ChatError(cfg.keyProblem || 'GOOGLE_CHAT_CLIENT_EMAIL is missing', { permanent: true });
  const key = `${scope}|${subject || ''}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  let assertion;
  try {
    assertion = jwt.sign(
      { iss: cfg.clientEmail, scope, aud: TOKEN_URL, iat: now, exp: now + 3600, ...(subject ? { sub: subject } : {}) },
      cfg.privateKey,
      { algorithm: 'RS256' },
    );
  } catch (err) {
    throw new ChatError(`The private key could not sign a request: ${err.message}`, { permanent: true });
  }
  const response = await googleFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.error_description || data.error || response.status;
    const hint = subject && /unauthorized_client|access_denied/i.test(String(data.error))
      ? ' — domain-wide delegation for the directory scope has not been granted to this service account in the Admin console'
      : '';
    throw new ChatError(`Google refused the service account sign-in: ${reason}${hint}`, { status: response.status, permanent: response.status < 500 });
  }
  tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

/** A Google API call as the service account; returns JSON, or throws ChatError. */
async function googleApi(url, { method = 'GET', body, scope, subject } = {}) {
  const token = await accessToken({ scope, subject });
  const response = await googleFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) tokenCache.delete(`${scope || SCOPE}|${subject || ''}`);
    throw new ChatError(`Google: ${data.error?.message || `HTTP ${response.status}`}`, {
      status: response.status,
      permanent: response.status >= 400 && response.status < 500 && ![401, 429].includes(response.status),
    });
  }
  return data;
}

/**
 * Any other Google Workspace API, as the service account acting for `subject`
 * (a Workspace user) — used to read a person's own Gmail and Calendar when they
 * have switched that on. Needs the scope granted under domain-wide delegation.
 */
export const workspaceApi = (url, options = {}) => googleApi(url, options);

// ---------------------------------------------------------------- finding people's chats

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

/**
 * The Google user id for a Workspace email, from the Admin directory. Needs a
 * one-time grant in the Admin console (domain-wide delegation, read-only) and
 * GOOGLE_CHAT_DIRECTORY_ADMIN naming an administrator to read as.
 * Returns null when the directory has no such user.
 */
export async function directoryUserId(email) {
  const admin = chatConfig().directoryAdmin;
  if (!admin) throw new ChatError('GOOGLE_CHAT_DIRECTORY_ADMIN is not set', { permanent: true });
  try {
    const user = await googleApi(
      `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?projection=basic&viewType=domain_public`,
      { scope: DIRECTORY_SCOPE, subject: admin },
    );
    return user.id || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** The direct message between TaskFlow and a Google user id, or null if there is none yet. */
export async function findDirectMessage(googleUserId) {
  try {
    return await googleApi(`${CHAT_API}/spaces:findDirectMessage?name=${encodeURIComponent(`users/${googleUserId}`)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Every direct message TaskFlow is in — after an admin install, one per person. */
export async function listDirectMessages() {
  const spaces = [];
  let pageToken = '';
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ pageSize: '1000', filter: 'spaceType = "DIRECT_MESSAGE"' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleApi(`${CHAT_API}/spaces?${params}`);
    spaces.push(...(data.spaces || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return spaces;
}

export class ChatError extends Error {
  constructor(message, { status = null, permanent = false, spaceGone = false } = {}) {
    super(message);
    this.status = status;
    this.permanent = permanent;
    this.spaceGone = spaceGone;
  }
}

async function googleTransport(spaceName, message) {
  const token = await accessToken();
  const response = await googleFetch(`${CHAT_API}/${spaceName}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(message),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.error?.message || `HTTP ${response.status}`;
    // 404/403: the app was removed or the space is gone — retrying will not help
    const spaceGone = response.status === 404 || response.status === 403;
    const permanent = spaceGone || (response.status >= 400 && response.status < 500 && response.status !== 429);
    if (response.status === 401) tokenCache.delete(`${SCOPE}|`);
    throw new ChatError(`Google Chat: ${reason}`, { status: response.status, permanent: permanent && response.status !== 401, spaceGone });
  }
  return { name: data.name };
}

/** Signs in to Google once, to prove the credentials work. Sends no message. */
export async function checkSignIn() {
  tokenCache = new Map();
  await accessToken();
  return true;
}

let transport = googleTransport;
/** Tests capture messages instead of sending them. */
export const setChatTransport = (fn) => { transport = fn || googleTransport; };
export const sendChatMessage = (spaceName, message) => transport(spaceName, message);

// ---------------------------------------------------------------- incoming

const certCache = {};

async function certsFor(kind, fetchImpl) {
  const cached = certCache[kind];
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetchImpl(CERTS[kind]);
  if (!response.ok) throw new Error(`Could not load Google's signing keys (${response.status})`);
  const keys = await response.json();
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 3600);
  certCache[kind] = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

let certFetcher = (url) => fetch(url);
/** Tests supply their own keys. */
export const setCertFetcher = (fn) => {
  certFetcher = fn || ((url) => fetch(url));
  for (const k of Object.keys(certCache)) delete certCache[k];
};

/**
 * Checks the Authorization header on a request from Google Chat. Returns the
 * verified claims, or throws. Nothing in the request body is trusted until
 * this has passed.
 */
export async function verifyChatToken(authorization) {
  const token = /^Bearer\s+(.+)$/i.exec(authorization || '')?.[1];
  if (!token) throw new Error('missing bearer token');
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid || !decoded.payload) throw new Error('malformed token');
  const cfg = chatConfig();

  if (decoded.payload.iss === CHAT_ISSUER) {
    if (!cfg.projectNumber) throw new Error('project-number audience is not configured (GOOGLE_CHAT_PROJECT_NUMBER)');
    const keys = await certsFor('chat', certFetcher);
    const key = keys[decoded.header.kid];
    if (!key) throw new Error('unknown signing key');
    return jwt.verify(token, key, { algorithms: ['RS256'], issuer: CHAT_ISSUER, audience: cfg.projectNumber });
  }

  const keys = await certsFor('oidc', certFetcher);
  const key = keys[decoded.header.kid];
  if (!key) throw new Error('unknown signing key');
  const claims = jwt.verify(token, key, {
    algorithms: ['RS256'],
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: cfg.endpointUrl,
  });
  if (claims.email !== CHAT_ISSUER || claims.email_verified === false) throw new Error('token was not issued for Google Chat');
  return claims;
}

let verifier = verifyChatToken;
/** API tests stand in for Google; production always uses the real check. */
export const setChatVerifier = (fn) => { verifier = fn || verifyChatToken; };
export const verifyIncoming = (authorization) => verifier(authorization);

// ---------------------------------------------------------------- formatting

/** Text from people (task titles, names) shown as text, never as Chat markup or links. */
export const chatText = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A link in Chat's own syntax. The label is escaped; the URL is ours. */
export const chatLink = (url, label) => `<${url}|${chatText(label).replace(/\|/g, '/')}>`;
