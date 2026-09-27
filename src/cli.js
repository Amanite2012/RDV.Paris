#!/usr/bin/env node
/*
 * RDV.Paris — outil en ligne de commande.
 *
 * Récupère les activités à venir de rendez-vous.social (API publique, sans compte),
 * les compare à votre agenda iCal et affiche la répartition hommes/femmes.
 *
 *   npm run plan -- [--libres] [--jours N] [--ics fichier.ics] [--html rapport.html] [--json]
 *
 * Agenda : variable RDV_ICS (liens ou fichiers .ics séparés par des espaces ou des virgules)
 * et/ou rdv-paris.config.json (ignoré par git). Voir README, « Outil en ligne de commande ».
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const C = require('./core.js');

const API = 'https://ygejsv2vy3.execute-api.eu-west-3.amazonaws.com';
const SITE = 'https://rendez-vous.social';
const USER_AGENT = 'rdv-paris-cli/0.1 (+https://github.com/Amanite2012/RDV.Paris; usage personnel)';
const CACHE_TTL = 5 * C.MINUTE;
const MAX_PARALLEL = 2;
const TZ = 'Europe/Paris';
const ROOT = path.join(__dirname, '..');

const HELP = `Usage : npm run plan -- [options]

  --libres            seulement les activités libres dans votre agenda (et encore en vente)
  --jours N           seulement les N prochains jours
  --ics FICHIER       exporter les activités libres au format .ics
  --html FICHIER      écrire une page récapitulative
  --json              sortie JSON au lieu du tableau
  --agenda LIEN       ajouter un agenda iCal (lien ou fichier .ics), répétable
  --frais             ignorer le cache local (5 min) des réponses de l'API
  -h, --aide          cette aide

Agenda : RDV_ICS="https://…/basic.ics https://…" ou rdv-paris.config.json (voir README).`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig(extraAgendas) {
  const file = process.env.RDV_CONFIG || path.join(ROOT, 'rdv-paris.config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`Configuration illisible (${file}) : ${e.message}`); }
  }
  const split = s => String(s || '').split(/[\s,]+/).filter(Boolean);
  const agendas = [...split(process.env.RDV_ICS), ...(Array.isArray(cfg.agendas) ? cfg.agendas : split(cfg.agendas)), ...extraAgendas];
  return {
    agendas: [...new Set(agendas)],
    city: cfg.ville || 'paris',
    bufferMin: num(cfg.margeMin, 30),
    defaultDurationMin: num(cfg.dureeParDefautMin, 120),
    ignoreAllDay: cfg.ignorerJourneeEntiere !== false,
  };
}

function num(v, d) { return Number.isFinite(+v) && v !== '' && v != null ? +v : d; }

// ---------------------------------------------------------------------------
// Réseau : cache court, User-Agent explicite, 2 requêtes simultanées maximum
// ---------------------------------------------------------------------------

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'rdv-paris');

function cachePath(key) { return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json'); }

function readCache(key) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    if (c.key === key && Date.now() - c.at < CACHE_TTL) return c.body;
  } catch (e) { /* absent ou périmé */ }
  return undefined;
}

function writeCache(key, body) {
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
          headers: { 'User-Agent': USER_AGENT, Accept: accept, Origin: SITE, Referer: SITE + '/' },
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
  const url = API + pathAndQuery;
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

async function fetchActivities(cfg, fresh) {
  const list = await apiGet(`/events?city_id=${encodeURIComponent(cfg.city)}`, fresh);
  if (!Array.isArray(list)) throw new Error("Réponse inattendue de l'API /events (tableau attendu)");
  const acts = prepareActivities(list, cfg, Date.now());

  // La liste contient déjà rates / tickets_male / tickets_female. Le détail
  // (/event/<id>) n'est demandé que si une activité n'a pas ces informations.
  await Promise.all(acts.filter(a => !a.gender).map(async a => {
    try {
      const [d] = C.extractEventsFromJson(await apiGet(`/event/${a.id}`, fresh));
      if (d && d.gender) a.gender = d.gender;
    } catch (err) { warn(err.message); }
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

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

// Ne jamais afficher un lien d'agenda complet : il donne accès à l'agenda.
function agendaLabel(src) {
  if (!/^(https?|webcal):/i.test(src)) return path.basename(src);
  try { return new URL(src.replace(/^webcal:/i, 'https:')).host; } catch (e) { return 'lien iCal'; }
}

async function loadBusy(cfg, range) {
  const busy = [];
  const errors = [];
  await Promise.all(cfg.agendas.map(async src => {
    try {
      let text;
      if (/^(https?|webcal):/i.test(src)) {
        const res = await httpGet(src.replace(/^webcal:/i, 'https:'), { accept: 'text/calendar, */*', label: `agenda ${agendaLabel(src)}` });
        text = await res.text();
      } else {
        text = fs.readFileSync(path.resolve(src.replace(/^~(?=\/)/, os.homedir())), 'utf8');
      }
      if (!/BEGIN:VCALENDAR|BEGIN:VEVENT/.test(text)) throw new Error(`agenda ${agendaLabel(src)} : ce n'est pas un fichier iCal`);
      busy.push(...C.parseIcs(text, range));
    } catch (e) {
      errors.push(e.code === 'ENOENT' ? `agenda ${agendaLabel(src)} : fichier introuvable` : e.message);
    }
  }));
  return { busy, errors };
}

// ---------------------------------------------------------------------------
// Présentation
// ---------------------------------------------------------------------------

const fmtDate = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hm = ms => fmtTime.format(ms);
const hours = a => (a.endKnown ? `${hm(a.start)}–${hm(a.end)}` : hm(a.start));

const STATUS = {
  free: { icon: '✅', label: 'libre' },
  tight: { icon: '⚠️', label: 'serré' },
  conflict: { icon: '❌', label: 'conflit' },
  unknown: { icon: '·', label: 'sans agenda' },
};

function statusText(a) {
  const s = STATUS[a.status];
  if (a.status === 'conflict') return `${s.icon} ${a.conflicts[0].title}`;
  if (a.status === 'tight') return `${s.icon} serré (${a.near[0].title})`;
  return `${s.icon} ${s.label}`;
}

function ratioText(g) { return g && g.pctMen != null ? `${g.pctMen}% / ${g.pctWomen}%` : '—'; }
function seatsText(g) {
  if (!g) return '—';
  const one = (n, cap) => (cap != null ? `${n}/${cap}` : n ? `${n}` : '—');
  return `${one(g.men, g.menCapacity)} · ${one(g.women, g.womenCapacity)}`;
}

// Largeur affichée : emoji en couleur (✅, ❌, 🔒, ou suivi de U+FE0F comme ⚠️) = 2 colonnes,
// symboles texte (♂, ♀, ·) = 1, sélecteurs de variante et accents combinants = 0.
function width(s) {
  const chars = [...s];
  let w = 0;
  chars.forEach((ch, i) => {
    if (/[\u200d\ufe0e\ufe0f\u0300-\u036f]/.test(ch)) return;
    w += /\p{Emoji_Presentation}/u.test(ch) || chars[i + 1] === '\ufe0f' ? 2 : 1;
  });
  return w;
}
function fit(s, n) {
  if (width(s) <= n) return s + ' '.repeat(n - width(s));
  let out = '';
  for (const ch of s) { if (width(out + ch) > n - 1) break; out += ch; }
  return out + '…' + ' '.repeat(Math.max(0, n - 1 - width(out)));
}

function printTable(acts) {
  const cols = [
    ['Date', 10], ['Heure', 11], ['Activité', 38], ['Statut', 30], ['♂ / ♀', 10], ['♂ x/cap · ♀ x/cap', 17],
  ];
  const line = cells => cells.map((c, i) => fit(c, cols[i][1])).join('  ').trimEnd();
  console.log(line(cols.map(c => c[0])));
  console.log(cols.map(c => '─'.repeat(c[1])).join('  '));
  for (const a of acts) {
    const title = (a.sale === false ? '🔒 ' : '') + a.title.trim();
    console.log(line([fmtDate.format(a.start), hours(a), title, statusText(a), ratioText(a.gender), seatsText(a.gender)]));
  }
}

function toJson(a) {
  const brief = x => ({ title: x.title, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString() });
  return {
    id: a.id, title: a.title.trim(), url: a.url, location: a.location,
    start: new Date(a.start).toISOString(), end: a.endKnown ? new Date(a.end).toISOString() : null,
    onSale: a.sale, status: a.status,
    conflicts: a.conflicts.map(brief), near: a.near.map(brief),
    gender: a.gender && {
      men: a.gender.men, women: a.gender.women, pctMen: a.gender.pctMen, pctWomen: a.gender.pctWomen,
      menCapacity: a.gender.menCapacity, womenCapacity: a.gender.womenCapacity,
      menRemaining: a.gender.menRemaining, womenRemaining: a.gender.womenRemaining,
    },
  };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildHtml(acts, meta) {
  const rows = acts.map(a => {
    const g = a.gender;
    const bar = g && g.pctMen != null ? `<div class="bar" title="${g.pctMen} % hommes · ${g.pctWomen} % femmes"><i style="width:${g.pctMen}%"></i></div>` : '';
    const left = n => (n == null ? '?' : Math.max(0, n)); // remaining < 0 quand l'activité est surréservée
    const rem = g ? `<small>reste ♂ ${left(g.menRemaining)} · ♀ ${left(g.womenRemaining)}</small>` : '';
    const why = a.status === 'conflict' ? a.conflicts : a.status === 'tight' ? a.near : [];
    return `<tr class="${a.status}${a.sale === false ? ' closed' : ''}">
  <td>${esc(fmtDate.format(a.start))}</td><td>${esc(hours(a))}</td>
  <td><a href="${esc(a.url)}">${esc(a.title.trim())}</a>${a.sale === false ? ' <em>vente fermée</em>' : ''}<br><small>${esc(a.location || '')}</small></td>
  <td class="st">${STATUS[a.status].icon} ${esc(STATUS[a.status].label)}${why.length ? `<br><small>${why.slice(0, 2).map(x => esc(x.title) + ' ' + esc(hm(x.start)) + '–' + esc(hm(x.end))).join(', ')}</small>` : ''}</td>
  <td>${esc(ratioText(g))}${bar}</td><td>${esc(seatsText(g))}<br>${rem}</td>
</tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RDV.Paris — planning</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e4e4e8;--free:#e7f6ec;--tight:#fff4dc;--conflict:#fde8e8;--men:#3b6fd8;--women:#d8467a;--link:#0a58ca}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa2;--line:#2c2c31;--free:#15301f;--tight:#352b12;--conflict:#3a1a1a;--men:#6f9bff;--women:#ff7aa8;--link:#8ab4ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}.meta{color:var(--muted);margin:0 0 16px}
label{display:inline-flex;gap:6px;align-items:center;margin:0 0 12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr.free td.st{background:var(--free)}tr.tight td.st{background:var(--tight)}tr.conflict td.st{background:var(--conflict)}
tr.closed{opacity:.6}small{color:var(--muted)}a{color:var(--link)}
.bar{height:6px;border-radius:3px;background:var(--women);margin-top:4px;min-width:80px;overflow:hidden}.bar i{display:block;height:100%;background:var(--men)}
body.only-free tr:not(.free){display:none}
</style></head><body><main>
<h1>Activités rendez-vous.social — Paris</h1>
<p class="meta">${esc(meta)}</p>
<label><input type="checkbox" id="f"> Seulement les activités libres</label>
<div class="wrap"><table>
<thead><tr><th>Date</th><th>Heure</th><th>Activité</th><th>Agenda</th><th>♂ / ♀</th><th>Billets ♂ · ♀</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
</main>
<script>document.getElementById('f').onchange=e=>document.body.classList.toggle('only-free',e.target.checked)</script>
</body></html>
`;
}

// ---------------------------------------------------------------------------

function warn(msg) { console.error('⚠️  ' + msg); }
function fail(msg) { console.error('Erreur : ' + msg); process.exit(1); }

async function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        libres: { type: 'boolean' }, jours: { type: 'string' }, ics: { type: 'string' }, html: { type: 'string' },
        json: { type: 'boolean' }, agenda: { type: 'string', multiple: true }, frais: { type: 'boolean' },
        aide: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) { fail(e.message + '\n\n' + HELP); }
  if (args.aide) { console.log(HELP); return; }
  const days = args.jours != null ? Number(args.jours) : null;
  if (days != null && !(days > 0)) fail('--jours attend un nombre de jours positif');

  const cfg = loadConfig(args.agenda || []);
  let acts = await fetchActivities(cfg, !!args.frais);
  if (days != null) acts = acts.filter(a => a.start < Date.now() + days * C.DAY);

  const range = { rangeStart: Date.now() - C.DAY, rangeEnd: Math.max(Date.now(), ...acts.map(a => a.end)) + C.DAY };
  const { busy, errors } = cfg.agendas.length ? await loadBusy(cfg, range) : { busy: [], errors: [] };
  errors.forEach(warn);
  const hasAgenda = cfg.agendas.length > errors.length;
  if (!cfg.agendas.length) warn("Aucun agenda configuré (RDV_ICS ou rdv-paris.config.json) : statut libre/conflit non calculé.");

  annotate(acts, busy, cfg, hasAgenda);

  const free = acts.filter(a => a.status === 'free' && a.sale);
  const shown = args.libres ? free : acts;

  if (args.ics) {
    fs.writeFileSync(args.ics, C.buildIcs(free.map(a => ({
      id: `rdv-${a.id}`, title: a.title.trim(), start: a.start, end: a.end, location: a.location, url: a.url,
      description: `${a.url}\nH/F : ${ratioText(a.gender)} (${seatsText(a.gender)})`,
    }))));
    console.error(`${free.length} activité(s) libre(s) exportée(s) dans ${args.ics}`);
  }

  const count = s => acts.filter(a => a.status === s).length;
  const summary = `${acts.length} activités · ✅ ${count('free')} libres · ⚠️ ${count('tight')} serrées · ❌ ${count('conflict')} en conflit`
    + ` · agenda : ${hasAgenda ? `${busy.length} évènement(s) de ${cfg.agendas.length - errors.length} source(s)` : 'aucun'}`;

  if (args.html) {
    const meta = `${summary} · mis à jour le ${new Date().toLocaleString('fr-FR', { timeZone: TZ })}`;
    fs.writeFileSync(args.html, buildHtml(shown, meta));
    console.error(`Rapport écrit dans ${args.html}`);
  }

  if (args.json) {
    console.log(JSON.stringify(shown.map(toJson), null, 2));
  } else {
    printTable(shown);
    console.log('\n' + summary + (acts.some(a => !a.sale) ? ' · 🔒 = vente fermée' : ''));
  }
}

if (require.main === module) main().catch(e => fail(e.message));

module.exports = { loadConfig, prepareActivities, annotate, agendaLabel, buildHtml, statusText, width, fit };
