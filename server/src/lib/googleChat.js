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

// ---------------------------------------------------------------- configuration

let override = null;
/** Tests replace the environment's credentials; production never calls this. */
export const setChatConfig = (value) => { override = value; tokenCache = null; };

export function chatConfig() {
  const base = override || config.googleChat;
  const endpointPath = `${config.apiPrefix}/integrations/google-chat/events`;
  return {
    ...base,
    endpointUrl: base.audience || `${config.publicUrl}${endpointPath}`,
    configured: Boolean(base.clientEmail && base.privateKey && base.privateKey.includes('PRIVATE KEY')),
  };
}

// ---------------------------------------------------------------- outgoing

let tokenCache = null;

async function accessToken(fetchImpl = fetch) {
  const cfg = chatConfig();
  if (!cfg.configured) throw new ChatError('Google Chat credentials are not configured on the server', { permanent: true });
  if (tokenCache && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  let assertion;
  try {
    assertion = jwt.sign(
      { iss: cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      cfg.privateKey,
      { algorithm: 'RS256' },
    );
  } catch {
    throw new ChatError('GOOGLE_CHAT_PRIVATE_KEY could not be read — check it was copied whole, on one line, in double quotes', { permanent: true });
  }
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ChatError(`Google refused the service account sign-in: ${data.error_description || data.error || response.status}`, { status: response.status, permanent: response.status < 500 });
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
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
  const response = await fetch(`${CHAT_API}/${spaceName}/messages`, {
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
    if (response.status === 401) tokenCache = null;
    throw new ChatError(`Google Chat: ${reason}`, { status: response.status, permanent: permanent && response.status !== 401, spaceGone });
  }
  return { name: data.name };
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
