#!/usr/bin/env node
/*
 * Test de bout en bout : sert de fausses pages façon rendez-vous.social
 * (liste + page d'activité + agenda .ics), y injecte le userscript construit
 * et vérifie les badges, les conflits et la répartition H/F.
 *
 *   npm run build && npm run test:e2e   (nécessite Playwright + Chromium)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const C = require('../src/core.js');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../dist/rdv-paris.user.js'), 'utf8');
const SHOTS = process.env.SHOTS_DIR || null;

// Dates relatives à aujourd'hui pour que le test reste valable.
const p = C.zonedParts(Date.now() + 3 * C.DAY, 'Europe/Paris');
const day = new Date(Date.UTC(p.y, p.mo - 1, p.d));
const D = n => new Date(day.getTime() + n * C.DAY);
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const fr = d => `${JOURS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

const EVENTS = [
  { id: 1889, slug: '1889-soiree-oenologie', title: 'Soirée oenologie', d: D(3), time: '19h30 - 21h', place: 'Paris 3e', men: 0, women: 1, cap: 8, api: true },
  { slug: 'speed-dating-bastille', title: 'Speed dating à Bastille', d: D(0), time: '19h30 - 22h', place: 'Paris 11e', men: 8, women: 12 },
  { slug: 'volley-champ-de-mars', title: 'Volley au Champ-de-Mars', d: D(1), time: '18h00 - 20h00', place: 'Paris 7e', men: 10, women: 6 },
  { slug: 'atelier-poterie', title: 'Atelier poterie', d: D(2), time: '14h', place: 'Paris 20e', men: 3, women: 9 },
];

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  // chevauche le speed dating
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Dîner chez Paul', `DTSTART;TZID=Europe/Paris:${ymd(D(0))}T200000`, `DTEND;TZID=Europe/Paris:${ymd(D(0))}T230000`, 'END:VEVENT',
  // finit 15 min avant le volley -> « serré »
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Réunion', `DTSTART;TZID=Europe/Paris:${ymd(D(1))}T160000`, `DTEND;TZID=Europe/Paris:${ymd(D(1))}T174500`, 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const layout = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:sans-serif;margin:0;background:#faf7f2}main{max-width:900px;margin:auto;padding:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
  .card{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 4px #0002}
  .card a{color:inherit;text-decoration:none}.btn{background:#e85d3f;color:#fff;border:0;padding:12px 18px;border-radius:10px;font-size:16px}</style>
  </head><body><header><nav><a href="/">Rendez-vous</a> <a href="/paris">Paris</a> <a href="/connexion">S'inscrire</a></nav></header><main>${body}</main>
  <footer><a href="/cgv">CGV</a></footer></body></html>`;

const href = e => (e.api ? '/event/' + e.slug : '/paris/' + e.slug);
const listing = () => layout('Paris', `<h1>Activités à Paris</h1><div class="grid">${EVENTS.map(e => `
  <article class="card"><a href="${href(e)}">
    <div class="date">${fr(e.d)} · ${e.time}</div>
    <h3>${e.title}</h3>
    <p class="lieu">${e.place}</p><p>15 €</p></a></article>`).join('')}</div>`);

const detail = e => layout(e.title, `<a href="/paris">← Retour</a>
  <h1>${e.title}</h1>
  <p>${fr(e.d)} · ${e.time}</p><p class="lieu">${e.place}</p>
  <p>Participants : ${e.men} hommes et ${e.women} femmes</p>
  <button class="btn">Prendre mon billet</button>`);

// Page /buy façon application monopage : tout vient de l'API (XHR avec en-tête).
const buyPage = e => layout(e.title, `<div id="app">Chargement…</div>
  <script>
    const x = new XMLHttpRequest();
    x.open('GET', '/api/prod/events/${e.id}');
    x.setRequestHeader('x-api-key', 'k');
    x.onload = () => {
      const ev = JSON.parse(x.responseText);
      document.getElementById('app').innerHTML = '<h1>' + ev.name + '</h1><p>${fr(e.d)} · ${e.time}</p>'
        + ev.rates.map(r => '<div>' + r.name + ' (' + r.gender_category + ') ' + r.price + ' €</div>').join('')
        + '<button class="btn">Payer</button>';
    };
    x.send();
  </script>`);

const apiEvent = e => ({
  id: e.id, name: e.title, cancellation_policy: 'normal',
  rates: [
    { id: 1, name: 'Tarif Regular', price: 45, gender_category: 'male', event_id: e.id, quantity: e.cap, remaining: e.cap - e.men },
    { id: 2, name: 'Tarif Regular', price: 45, gender_category: 'female', event_id: e.id, quantity: e.cap, remaining: e.cap - e.women },
  ],
  tickets_male: e.men, tickets_female: e.women,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const apiM = /^\/api\/prod\/events\/(\d+)$/.exec(url.pathname);
  if (apiM) {
    if (req.headers['x-api-key'] !== 'k') { res.writeHead(401); return res.end('{}'); }
    const e = EVENTS.find(x => x.id === +apiM[1]);
    res.writeHead(e ? 200 : 404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(e ? apiEvent(e) : {}));
  }
  const buy = EVENTS.find(x => x.api && (url.pathname === '/event/' + x.slug + '/buy' || url.pathname === '/event/' + x.slug));
  if (buy) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(buyPage(buy)); }
  if (url.pathname === '/cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(ICS); }
  if (url.pathname === '/paris') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(listing()); }
  const e = EVENTS.find(x => url.pathname === '/paris/' + x.slug);
  if (e) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(detail(e)); }
  res.writeHead(404); res.end('404');
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  page.on('pageerror', e => { console.error('Erreur page :', e); process.exitCode = 1; });

  // Réglages pré-remplis (repli localStorage quand l'API GM est absente).
  await page.addInitScript(({ cal }) => {
    if (!localStorage.getItem('rdvparis:settings')) {
      localStorage.setItem('rdvparis:settings', JSON.stringify({ calendars: [{ name: 'Test', url: cal }] }));
      localStorage.setItem('rdvparis:panelOpen', 'true');
    }
  }, { cal: base + '/cal.ics' });
  // Équivalent de @run-at document-start
  await page.addInitScript(SCRIPT);

  // ----- Page d'achat (application monopage, données via l'API) -----
  await page.goto(base + '/event/1889-soiree-oenologie/buy');
  await page.waitForSelector('.rdvp-ticket');
  const buyHint = await page.$eval('.rdvp-ticket', e => e.innerText);
  console.log('Page /buy, à côté du bouton :', buyHint);
  assert.match(buyHint, /♂ 0% · ♀ 100% \(0\/8 · 1\/8\)/);
  const buyPanel = await page.evaluate(() => document.querySelector('#rdvparis-host').shadowRoot.querySelector('.body').innerText);
  assert.match(buyPanel, /Places restantes : ♂ 8 · ♀ 7/);
  assert.match(buyPanel, /Soirée oenologie/);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'buy.png') });

  // ----- Liste -----
  await page.goto(base + '/paris');
  await page.waitForFunction(() => document.querySelectorAll('.rdvp-badge').length === 4);
  await page.waitForFunction(() => !document.body.innerText.includes('♂/♀ …') && document.body.innerText.includes('Conflit'), null, { timeout: 10000 });
  const all = await page.$$eval('.card .rdvp-badge', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  console.log('Soirée oenologie (via l\'API apprise) :', all[0]);
  assert.match(all[0], /Libre/);
  assert.match(all[0], /♂ 0% · ♀ 100% \(0\/8 · 1\/8\)/);
  const badges = all.slice(1);
  console.log('Badges :\n  ' + badges.join('\n  '));
  assert.match(badges[0], /Conflit : Dîner chez Paul/);
  assert.match(badges[0], /♂ 40% · ♀ 60%/);
  assert.match(badges[1], /Serré/);
  assert.match(badges[1], /♂ 63% · ♀ 38%|♂ 63% · ♀ 37%/);
  assert.match(badges[2], /Libre/);
  assert.match(badges[2], /♂ 25% · ♀ 75%/);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'liste.png') });

  // Ajouter l'atelier au planning puis vérifier l'onglet « Mon planning »
  await page.locator('.card').nth(3).locator('.rdvp-badge input').check();
  const sel = await page.evaluate(() => JSON.parse(localStorage.getItem('rdvparis:selection')));
  assert.equal(Object.keys(sel).length, 1);
  assert.equal(Object.values(sel)[0].title, 'Atelier poterie');

  // ----- Page d'activité -----
  await page.goto(base + '/paris/speed-dating-bastille');
  await page.waitForSelector('.rdvp-ticket');
  const hint = await page.$eval('.rdvp-ticket', e => e.innerText);
  console.log('À côté du bouton billet :', hint);
  assert.match(hint, /♂ 40% · ♀ 60% \(8 · 12\)/);
  const panel = await page.evaluate(() => document.querySelector('#rdvparis-host').shadowRoot.querySelector('.body').innerText);
  assert.match(panel, /Répartition hommes \/ femmes de cette activité/);
  assert.match(panel, /Speed dating à Bastille/);
  assert.match(panel, /Conflit : Dîner chez Paul/);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'activite.png') });

  // ----- Export .ics -----
  await page.evaluate(() => { const h = document.querySelector('#rdvparis-host').shadowRoot; h.querySelector('[data-tab="mine"]').click(); });
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => document.querySelector('#rdvparis-host').shadowRoot.querySelector('#exportIcs').click()),
  ]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  const back = C.parseIcs(ics, { rangeStart: Date.now() - C.DAY, rangeEnd: Date.now() + 30 * C.DAY });
  assert.equal(back.length, 1);
  assert.equal(back[0].title, 'Atelier poterie');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'planning.png') });

  await browser.close();
  server.close();
  console.log('E2E OK');
})().catch(e => { console.error(e); server.close(); process.exit(1); });
