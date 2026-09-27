/*
 * RDV.Paris — accès à l'API publique de rendez-vous.social, partagé par la CLI et le site.
 *
 *   GET /events?city_id=paris  toutes les activités à venir (rates, tickets_male, tickets_female)
 *   GET /event/<id>            détail, demandé seulement si la liste n'a pas la répartition
 *
 * Respect du site : cache de 5 minutes (mémoire + disque), 2 requêtes simultanées maximum,
 * User-Agent explicite.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./core.js');

// RDV_API permet de viser une fausse API dans les tests.
const apiBase = () => (process.env.RDV_API || 'https://ygejsv2vy3.execute-api.eu-west-3.amazonaws.com').replace(/\/$/, '');
const SITE = 'https://rendez-vous.social';
const USER_AGENT = 'rdv-paris/0.2 (+https://github.com/Amanite2012/RDV.Paris; usage personnel)';
const CACHE_TTL = 5 * C.MINUTE;
const MAX_PARALLEL = 2;

function num(v, d) { return Number.isFinite(+v) && v !== '' && v != null ? +v : d; }

// ---------------------------------------------------------------------------
// Réseau : cache court, User-Agent explicite, 2 requêtes simultanées maximum
// ---------------------------------------------------------------------------

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'rdv-paris');

function cachePath(key) { return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json'); }

const memory = new Map();

function readCache(key) {
  const m = memory.get(key);
  if (m && Date.now() - m.at < CACHE_TTL) return m.body;
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    if (c.key === key && Date.now() - c.at < CACHE_TTL) return c.body;
  } catch (e) { /* absent ou périmé */ }
  return undefined;
}

function writeCache(key, body) {
  memory.set(key, { at: Date.now(), body });
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ key, at: Date.now(), body }));
  } catch (e) { /* le cache est facultatif */ }
}

let active = 0;
const queue = [];
async function limited(fn) {
  if (active >= MAX_PARALLEL) await new Promise(r => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; if (queue.length) queue.shift()(); }
}

async function httpGet(url, { accept = 'application/json', label = url } = {}) {
  return limited(async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: accept, ...(url.startsWith(apiBase()) ? { Origin: SITE, Referer: SITE + '/' } : {}) },
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        throw new Error(`${label} : ${e.cause ? e.cause.code || e.cause.message : e.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 1) {
        const wait = Math.min(30, num(res.headers.get('retry-after'), 5));
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`${label} : HTTP ${res.status}`);
      return res;
    }
  });
}

async function apiGet(pathAndQuery, fresh) {
  const url = apiBase() + pathAndQuery;
  if (!fresh) {
    const cached = readCache(url);
    if (cached !== undefined) return cached;
  }
  const body = await (await httpGet(url, { label: `API ${pathAndQuery}` })).json();
  writeCache(url, body);
  return body;
}

// ---------------------------------------------------------------------------
// Activités
// ---------------------------------------------------------------------------

async function fetchActivities(cfg, fresh, onWarning) {
  const list = await apiGet(`/events?city_id=${encodeURIComponent(cfg.city)}`, fresh);
  if (!Array.isArray(list)) throw new Error("Réponse inattendue de l'API /events (tableau attendu)");
  const acts = prepareActivities(list, cfg, Date.now());

  // La liste contient déjà rates / tickets_male / tickets_female. Le détail
  // (/event/<id>) n'est demandé que si une activité n'a pas ces informations.
  await Promise.all(acts.filter(a => !a.gender).map(async a => {
    try {
      const [d] = C.extractEventsFromJson(await apiGet(`/event/${a.id}`, fresh));
      if (d && d.gender) a.gender = d.gender;
    } catch (err) { if (onWarning) onWarning(err.message); }
  }));
  return acts;
}

// Réponse de /events -> activités à venir, visibles, triées, avec une fin et une URL.
function prepareActivities(list, cfg, now) {
  const hidden = new Set(list.filter(o => o && o.hidden_at).map(o => o.id));
  return C.extractEventsFromJson(list)
    .filter(e => e.start != null && !hidden.has(e.id))
    .map(e => Object.assign(e, {
      endKnown: e.end != null,
      end: e.end != null ? e.end : e.start + cfg.defaultDurationMin * C.MINUTE,
      url: SITE + C.eventPath(e.id, e.title),
      sale: e.status !== 'closed', // statut de vente de l'API (sale / closed)
      status: null, // remplacé par le statut d'agenda (annotate)
    }))
    .filter(e => e.end > now)
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

function annotate(acts, busy, cfg, hasAgenda) {
  for (const a of acts) {
    const r = C.checkConflicts(a, busy, { bufferMs: cfg.bufferMin * C.MINUTE, ignoreAllDay: cfg.ignoreAllDay });
    Object.assign(a, { status: hasAgenda ? r.status : 'unknown', conflicts: r.conflicts, near: r.near });
  }
  return acts;
}

function clearMemoryCache() { memory.clear(); }

module.exports = { apiBase, SITE, USER_AGENT, httpGet, apiGet, fetchActivities, prepareActivities, annotate, clearMemoryCache };
