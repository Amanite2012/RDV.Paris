#!/usr/bin/env node
/*
 * RDV.Paris — répartition hommes/femmes de chaque activité à venir à Paris et en Île-de-France.
 *
 *   npm run hf                    toutes les activités, triées par date
 *   npm run hf -- --dept 75       seulement Paris (plusieurs : --dept 92,93)
 *   npm run hf -- --json          sortie JSON
 *
 * Une seule requête à l'API publique : /events?city_id=paris (« Paris & Banlieue ») couvre
 * les 8 départements d'Île-de-France (75, 77, 78, 91, 92, 93, 94, 95).
 */
'use strict';
const { parseArgs } = require('node:util');
const C = require('./core.js');
const { apiGet, SITE } = require('./rvs.js');
const { fit } = require('./cli.js');

const TZ = 'Europe/Paris';
const fmtDate = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

/** Réponse de /events -> lignes { id, title, start, postalCode, dept, place, url, men, women, pctMen, pctWomen }, triées par date. */
function buildRows(list, { depts = null, now = Date.now() } = {}) {
  const raw = new Map(list.filter(e => e && e.id != null).map(e => [e.id, e]));
  return C.extractEventsFromJson(list)
    .filter(e => e.start != null && e.start > now && !(raw.get(e.id) || {}).hidden_at)
    .map(e => {
      const r = raw.get(e.id) || {};
      const place = (Array.isArray(r.places) && r.places.find(p => p && p.name)) || {};
      const postalCode = place.postal_code || null;
      const dept = r.zone_department || (postalCode ? postalCode.slice(0, 2) : null);
      const g = e.gender || {};
      return {
        id: e.id, title: e.title.replace(/\s+/g, ' ').trim(), start: e.start,
        postalCode, dept, place: place.name || null, url: SITE + C.eventPath(e.id, e.title),
        men: g.men != null ? g.men : null, women: g.women != null ? g.women : null,
        pctMen: g.pctMen != null ? g.pctMen : null, pctWomen: g.pctWomen != null ? g.pctWomen : null,
      };
    })
    .filter(r => !depts || depts.includes(r.dept))
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

function printRows(rows) {
  const cols = [['Date', 10], ['Heure', 5], ['CP', 5], ['Activité', 42], ['♂ %', 5], ['♀ %', 5], ['Inscrits', 12]];
  const right = new Set([4, 5]);
  const line = cells => cells.map((c, i) => (right.has(i) ? String(c).padStart(cols[i][1]) : fit(String(c), cols[i][1]))).join('  ').trimEnd();
  console.log(line(cols.map(c => c[0])));
  console.log(cols.map(c => '─'.repeat(c[1])).join('  '));
  for (const r of rows) {
    const has = r.pctMen != null;
    console.log(line([
      fmtDate.format(r.start), fmtTime.format(r.start), r.postalCode || r.dept || '?', r.title,
      has ? `${r.pctMen} %` : '—', has ? `${r.pctWomen} %` : '—',
      r.men != null ? `${r.men} H · ${r.women} F` : '—',
    ]));
  }
  const men = rows.reduce((s, r) => s + (r.men || 0), 0), women = rows.reduce((s, r) => s + (r.women || 0), 0);
  const total = men + women;
  console.log(`\n${rows.length} activités · ensemble : ${total ? `♂ ${Math.round(100 * men / total)} % · ♀ ${Math.round(100 * women / total)} %` : '—'} (${men} H · ${women} F inscrits)`);
}

async function main() {
  const { values: a } = parseArgs({ options: { dept: { type: 'string' }, json: { type: 'boolean' }, frais: { type: 'boolean' }, aide: { type: 'boolean', short: 'h' } } });
  if (a.aide) {
    console.log('Usage : npm run hf -- [--dept 75,92] [--json] [--frais]\n\nRépartition hommes/femmes des activités à venir à Paris et en Île-de-France.');
    return;
  }
  const depts = a.dept ? a.dept.split(/[\s,]+/).filter(Boolean) : null;
  const list = await apiGet('/events?city_id=paris', !!a.frais);
  if (!Array.isArray(list)) throw new Error("Réponse inattendue de l'API /events");
  const rows = buildRows(list, { depts });
  if (a.json) console.log(JSON.stringify(rows.map(r => Object.assign({}, r, { start: new Date(r.start).toISOString() })), null, 2));
  else printRows(rows);
}

if (require.main === module) main().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

module.exports = { buildRows };
