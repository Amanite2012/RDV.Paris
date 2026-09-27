/*
 * Agendas d'un utilisateur : liens iCal (téléchargés sans jamais viser le réseau interne)
 * et Google Agenda. Les créneaux occupés sont gardés 10 minutes en mémoire.
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const C = require('../src/core.js');
const G = require('./google.js');
const { USER_AGENT } = require('../src/rvs.js');

const MAX_ICS_BYTES = 5 * 1024 * 1024;
const BUSY_TTL = 10 * C.MINUTE;

// ---------------------------------------------------------------------------
// Téléchargement iCal protégé (SSRF)
// ---------------------------------------------------------------------------

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(::ffff:|64:ff9b:|f[cd]|fe[89ab]|ff)/.test(x);
  }
  return true;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, family: options && options.family }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
      const e = new Error('adresse interne refusée'); e.code = 'EPRIVATE';
      return cb(e);
    }
    if (options && options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

function normalizeIcalUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim().replace(/^webcal:/i, 'https:')); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return u.toString();
}

function fetchIcal(url, { allowPrivate = false, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(new Error('adresse interne refusée'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/calendar, */*' },
      lookup: allowPrivate ? undefined : safeLookup,
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('trop de redirections'));
        const next = normalizeIcalUrl(new URL(res.headers.location, u).toString());
        if (!next) return reject(new Error('redirection invalide'));
        return fetchIcal(next, { allowPrivate, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_ICS_BYTES) { req.destroy(); reject(new Error('fichier trop volumineux')); } else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', e => reject(e.code === 'EPRIVATE' ? new Error('adresse interne refusée') : e));
  });
}

function hostOf(url) { try { return new URL(url).host; } catch (e) { return 'lien iCal'; } }

// ---------------------------------------------------------------------------
// Créneaux occupés d'un utilisateur
// ---------------------------------------------------------------------------

function createCalendars({ cfg, secure, store }) {
  const busyCache = new Map(); // userId -> { at, key, result }
  const accessTokens = new Map(); // userId -> { accessToken, expiresAt }

  async function googleAccessToken(user) {
    const t = accessTokens.get(user.id);
    if (t && t.expiresAt > Date.now()) return t.accessToken;
    if (!cfg.google || !user.google || !user.google.refresh) throw new Error('Google Agenda non connecté');
    try {
      const fresh = await G.refreshAccessToken(cfg, secure.decrypt(user.google.refresh));
      accessTokens.set(user.id, fresh);
      if (user.google.error) { user.google.error = null; store.save(); }
      return fresh.accessToken;
    } catch (e) {
      if (e.code === 'invalid_grant') { user.google.error = 'Accès révoqué : reconnectez Google Agenda.'; store.save(); }
      throw e;
    }
  }

  function cacheKey(user) {
    return JSON.stringify([user.calendars.map(c => c.id), user.google && user.google.calendars.filter(c => c.selected).map(c => c.id)]);
  }

  async function loadBusy(user, range, { fresh = false } = {}) {
    const key = cacheKey(user);
    const hit = busyCache.get(user.id);
    if (!fresh && hit && hit.key === key && Date.now() - hit.at < BUSY_TTL && hit.range[1] >= range.rangeEnd) return hit.result;

    const busy = [], errors = [];
    let sources = 0;
    await Promise.all(user.calendars.map(async c => {
      try {
        const text = await fetchIcal(secure.decrypt(c.url), { allowPrivate: cfg.allowPrivateIcal });
        if (!/BEGIN:VCALENDAR|BEGIN:VEVENT/.test(text)) throw new Error("ce n'est pas un agenda iCal");
        busy.push(...C.parseIcs(text, range));
        sources++;
      } catch (e) { errors.push({ id: c.id, label: c.label, message: e.message }); }
    }));
    const gcals = user.google && user.google.refresh ? user.google.calendars.filter(c => c.selected) : [];
    if (gcals.length && cfg.google) {
      try {
        const at = await googleAccessToken(user);
        await Promise.all(gcals.map(async gc => {
          try {
            busy.push(...G.eventsToBusy(await G.listEvents(at, gc.id, range.rangeStart, range.rangeEnd)));
            sources++;
          } catch (e) { errors.push({ id: 'google:' + gc.id, label: gc.summary, message: e.message }); }
        }));
      } catch (e) { errors.push({ id: 'google', label: 'Google Agenda', message: e.message }); }
    }
    busy.sort((a, b) => a.start - b.start);
    const result = { busy, errors, sources };
    busyCache.set(user.id, { at: Date.now(), key, range: [range.rangeStart, range.rangeEnd], result });
    return result;
  }

  return {
    loadBusy,
    googleAccessToken,
    forget(userId) { busyCache.delete(userId); accessTokens.delete(userId); },
    invalidate(userId) { busyCache.delete(userId); },
  };
}

module.exports = { createCalendars, fetchIcal, normalizeIcalUrl, isPrivateAddress, hostOf };
