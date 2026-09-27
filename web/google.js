/*
 * Google : connexion (OpenID Connect, code + PKCE) et lecture de Google Agenda.
 * Aucune bibliothèque : uniquement les points d'accès HTTP documentés par Google.
 */
'use strict';
const crypto = require('node:crypto');
const C = require('../src/core.js');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE_LOGIN = 'openid email profile';
const SCOPE_CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function authUrl(cfg, { state, challenge, calendar, loginHint }) {
  const p = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: cfg.baseUrl + '/auth/google/callback',
    response_type: 'code',
    scope: calendar ? `${SCOPE_LOGIN} ${SCOPE_CALENDAR}` : SCOPE_LOGIN,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (calendar) {
    // Jeton de rafraîchissement nécessaire pour relire l'agenda pendant les notifications.
    p.set('access_type', 'offline');
    p.set('prompt', 'consent');
    p.set('include_granted_scopes', 'true');
  } else {
    p.set('prompt', 'select_account');
  }
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google : ${body.error || res.status}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function exchangeCode(cfg, code, verifier) {
  const t = await tokenRequest({
    code, code_verifier: verifier, grant_type: 'authorization_code',
    client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
    redirect_uri: cfg.baseUrl + '/auth/google/callback',
  });
  // Jeton d'identité reçu directement de Google en TLS : la vérification de l'émetteur, de
  // l'audience et de l'expiration suffit (OpenID Connect Core, § 3.1.3.7).
  const claims = JSON.parse(Buffer.from(String(t.id_token).split('.')[1] || '', 'base64url').toString('utf8'));
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new Error('Google : émetteur inattendu');
  if (claims.aud !== cfg.google.clientId) throw new Error('Google : audience inattendue');
  if (claims.exp * 1000 < Date.now()) throw new Error('Google : jeton expiré');
  if (!claims.email || claims.email_verified === false) throw new Error('Google : adresse e-mail non vérifiée');
  return { claims, accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token || null, scope: t.scope || '' };
}

async function refreshAccessToken(cfg, refreshToken) {
  const t = await tokenRequest({
    refresh_token: refreshToken, grant_type: 'refresh_token',
    client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
  });
  return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
}

async function revoke(refreshToken) {
  try {
    await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }), signal: AbortSignal.timeout(10000) });
  } catch (e) { /* le jeton est supprimé de notre côté dans tous les cas */ }
}

async function calApi(accessToken, pathAndQuery) {
  const res = await fetch(CAL_API + pathAndQuery, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Google Agenda : HTTP ${res.status}`);
  return res.json();
}

async function listCalendars(accessToken) {
  const r = await calApi(accessToken, '/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250');
  return (r.items || []).map(c => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary, selected: !!c.primary }));
}

async function listEvents(accessToken, calendarId, timeMin, timeMax) {
  const items = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(),
      singleEvents: 'true', maxResults: '2500',
      fields: 'items(summary,status,transparency,start,end,attendees(self,responseStatus)),nextPageToken',
    });
    if (page) q.set('pageToken', page);
    const r = await calApi(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
    items.push(...(r.items || []));
    if (!(page = r.nextPageToken)) break;
  }
  return items;
}

/** Évènements Google Agenda -> créneaux occupés au format de parseIcs. */
function eventsToBusy(items, tz = 'Europe/Paris') {
  const out = [];
  const day = s => { const [y, m, d] = s.split('-').map(Number); return C.zonedTimeToUtc(y, m, d, 0, 0, 0, tz); };
  for (const e of items || []) {
    if (!e || e.status === 'cancelled' || !e.start || !e.end) continue;
    const me = (e.attendees || []).find(a => a.self);
    if (me && me.responseStatus === 'declined') continue;
    const allDay = !!e.start.date;
    const start = allDay ? day(e.start.date) : Date.parse(e.start.dateTime);
    const end = allDay ? day(e.end.date) : Date.parse(e.end.dateTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ title: e.summary || 'Occupé', start, end, allDay, busy: e.transparency !== 'transparent' });
  }
  return out;
}

module.exports = { SCOPE_CALENDAR, pkce, authUrl, exchangeCode, refreshAccessToken, revoke, listCalendars, listEvents, eventsToBusy };
