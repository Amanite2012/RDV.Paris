'use strict';
// Site web : unités (chiffrement, SSRF, Google, notifications) et parcours complet sur une fausse API.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-web-'));
process.env.XDG_CACHE_HOME = path.join(TMP, 'cache');
let apiPort = 0;
// L'adresse de l'API est lue au chargement de src/rvs.js : on la fixe avant tout require.
const fakeApi = http.createServer((req, res) => fakeApiHandler(req, res));
const ready = new Promise(r => fakeApi.listen(0, '127.0.0.1', () => { apiPort = fakeApi.address().port; process.env.RDV_API = `http://127.0.0.1:${apiPort}`; r(); }));

const C = require('../src/core.js');
const { createSecure } = require('../web/secure.js');
const { isPrivateAddress, normalizeIcalUrl } = require('../web/calendars.js');
const G = require('../web/google.js');
const { computeNotifications } = require('../web/notify.js');

const TEMPLATE = require('./fixtures/event-1889.json');
const paris = (d, h, mi = 0) => { const p = C.zonedParts(Date.now() + d * C.DAY, 'Europe/Paris'); return C.zonedTimeToUtc(p.y, p.mo, p.d, h, mi, 0, 'Europe/Paris'); };
const iso = ms => new Date(ms).toISOString();

// Activités construites à partir de la vraie réponse /event/1889, avec des dates relatives à aujourd'hui.
function makeEvent(id, title, start, { male = [8, 8], female = [8, 7], tm = 0, tf = 1, status = 'sale' } = {}) {
  const e = JSON.parse(JSON.stringify(TEMPLATE));
  const p = C.zonedParts(start, 'Europe/Paris');
  Object.assign(e, {
    id, title, status, event_datetime: iso(start),
    date: `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T00:00:00.000Z`,
    time_start: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:00`, time_end: null,
    tickets_male: tm, tickets_female: tf,
    rates: [{ gender_category: 'male', quantity: male[0], remaining: male[1] }, { gender_category: 'female', quantity: female[0], remaining: female[1] }],
  });
  return e;
}
let EVENTS = [];
function fakeApiHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/events') return res.end(JSON.stringify(EVENTS));
  const m = /^\/event\/(\d+)$/.exec(u.pathname);
  const e = m && EVENTS.find(x => x.id === +m[1]);
  if (e) return res.end(JSON.stringify(e));
  if (u.pathname === '/agenda.ics') {
    res.setHeader('Content-Type', 'text/calendar');
    const d = s => new Date(s).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return res.end(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Dîner chez Paul', `DTSTART:${d(paris(3, 20))}`, `DTEND:${d(paris(3, 23))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  }
  res.statusCode = 404; res.end('{}');
}

// ---------------------------------------------------------------------------

test('chiffrement : aller-retour, altération détectée, signature', () => {
  const s = createSecure('x'.repeat(40));
  const blob = s.encrypt('https://calendar.google.com/secret.ics');
  assert.ok(!blob.includes('calendar'));
  assert.equal(s.decrypt(blob), 'https://calendar.google.com/secret.ics');
  const raw = Buffer.from(blob.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
  assert.throws(() => s.decrypt('v1:' + raw.toString('base64url')));
  assert.throws(() => createSecure('y'.repeat(40)).decrypt(blob));
  assert.ok(s.verify('unsub:1', s.sign('unsub:1')));
  assert.ok(!s.verify('unsub:2', s.sign('unsub:1')));
});

test('SSRF : adresses internes refusées, liens normalisés', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['142.250.74.238', '2a00:1450:4007:80b::200e']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(normalizeIcalUrl('webcal://p01.icloud.com/published/2/abc'), 'https://p01.icloud.com/published/2/abc');
  assert.equal(normalizeIcalUrl('file:///etc/passwd'), null);
  assert.equal(normalizeIcalUrl('https://user:pass@example.com/a.ics'), null);
  assert.equal(normalizeIcalUrl('pas un lien'), null);
});

test('Google Agenda : évènements -> créneaux occupés', () => {
  const busy = G.eventsToBusy([
    { summary: 'Réunion', start: { dateTime: '2026-10-05T10:00:00+02:00' }, end: { dateTime: '2026-10-05T11:00:00+02:00' } },
    { summary: 'Annulé', status: 'cancelled', start: { dateTime: '2026-10-05T12:00:00+02:00' }, end: { dateTime: '2026-10-05T13:00:00+02:00' } },
    { summary: 'Refusé', attendees: [{ self: true, responseStatus: 'declined' }], start: { dateTime: '2026-10-05T14:00:00+02:00' }, end: { dateTime: '2026-10-05T15:00:00+02:00' } },
    { summary: 'Disponible', transparency: 'transparent', start: { dateTime: '2026-10-05T16:00:00+02:00' }, end: { dateTime: '2026-10-05T17:00:00+02:00' } },
    { summary: 'Vacances', start: { date: '2026-10-10' }, end: { date: '2026-10-12' } },
  ]);
  assert.deepEqual(busy.map(b => b.title), ['Réunion', 'Disponible', 'Vacances']);
  assert.equal(busy[0].start, Date.parse('2026-10-05T08:00:00Z'));
  assert.equal(busy[1].busy, false);
  assert.equal(busy[2].allDay, true);
  assert.equal(busy[2].end - busy[2].start, 2 * C.DAY);
});

test('Google : URL d’autorisation (PKCE, accès hors ligne seulement pour l’agenda)', () => {
  const cfg = { baseUrl: 'https://rdv.example', google: { clientId: 'id', clientSecret: 's' } };
  const login = new URL(G.authUrl(cfg, { state: 'st', challenge: 'ch' }));
  assert.equal(login.searchParams.get('scope'), 'openid email profile');
  assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(login.searchParams.get('redirect_uri'), 'https://rdv.example/auth/google/callback');
  assert.equal(login.searchParams.get('access_type'), null);
  const cal = new URL(G.authUrl(cfg, { state: 'st', challenge: 'ch', calendar: true }));
  assert.match(cal.searchParams.get('scope'), /calendar\.readonly/);
  assert.equal(cal.searchParams.get('access_type'), 'offline');
});

test('notifications : alertes, rappel, résumé, sans doublon', () => {
  const now = Date.now();
  const act = (id, h, extra) => Object.assign({ id, title: 'A' + id, url: 'u', start: now + h * C.HOUR, end: now + (h + 2) * C.HOUR, sale: true, status: 'free', conflicts: [], near: [], gender: { menRemaining: 5, womenRemaining: 5 } }, extra);
  const user = {
    settings: { gender: 'male', lowPlaces: 3, notify: { alerts: true, reminder: true, digest: true } },
    selections: { 1: {}, 2: {}, 3: {}, 9: { title: 'Disparue', start: now + 5 * C.DAY, end: now + 5 * C.DAY + C.HOUR } },
    notifyState: { initialized: true, seen: [1, 2, 3], sent: {} },
  };
  const acts = [
    act(1, 72, { status: 'conflict', conflicts: [{ title: 'Dîner', start: now, end: now + C.HOUR }] }),
    act(2, 72, { gender: { menRemaining: 2, womenRemaining: 5 } }),
    act(3, 20, { gender: { menRemaining: 0, womenRemaining: 5 } }),
    act(4, 48), // nouvelle et libre
    act(5, 48, { status: 'conflict' }), // nouvelle mais en conflit
  ];
  const r = computeNotifications(user, acts, now);
  assert.deepEqual(r.alerts.map(a => a.key.split(':')[0]).sort(), ['conflict', 'full', 'gone', 'low']);
  assert.deepEqual(r.reminders.map(a => a.activity.id), [3]);
  assert.deepEqual(r.digest.map(a => a.id), [4]);
  for (const x of [...r.alerts, ...r.reminders]) user.notifyState.sent[x.key] = now;
  user.notifyState.seen = r.seen;
  const again = computeNotifications(user, acts, now);
  assert.equal(again.alerts.length + again.reminders.length + again.digest.length, 0);
});

// ---------------------------------------------------------------------------
// Parcours complet
// ---------------------------------------------------------------------------

test('site : connexion, agenda, choix, flux iCal, e-mails, désinscription, suppression', async () => {
  await ready;
  const rvs = require('../src/rvs.js');
  const { createApp } = require('../web/server.js');
  const { loadConfig } = require('../web/config.js');
  EVENTS = [
    makeEvent(101, 'Soirée oenologie', paris(3, 19, 30)), // chevauche le dîner de l'agenda -> conflit
    makeEvent(102, 'Apéro jeux', paris(5, 19, 30), { male: [4, 2], tm: 2 }), // 2 places hommes -> alerte
    makeEvent(103, 'Rando', paris(6, 9)),
  ];
  const port = await new Promise(r => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const logs = [];
  const log = { log: m => logs.push(m), warn: () => {}, error: m => logs.push('ERR ' + m) };
  const app = createApp(loadConfig({
    PORT: String(port), BASE_URL: `http://localhost:${port}`, DATA_DIR: path.join(TMP, 'data'),
    DEV_LOGIN: '1', MAIL_TRANSPORT: 'console', ALLOW_PRIVATE_ICAL: '1',
  }), { log });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  const B = `http://127.0.0.1:${port}`;
  let jar = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(B + p, { method, redirect: 'manual', headers: Object.assign({ 'x-rdv': '1', Cookie: jar }, body ? { 'Content-Type': 'application/json' } : {}, headers), body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) jar = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* html / ics */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  try {
    assert.equal((await call('GET', '/api/activities')).status, 401);
    assert.equal((await call('POST', '/auth/dev', { email: 'a@b.fr' }, { 'x-rdv': '' })).status, 403, 'sans en-tête x-rdv');
    assert.equal((await call('POST', '/auth/dev', { email: 'Camille@Example.com' })).status, 200);
    const me = (await call('GET', '/api/me')).json.user;
    assert.equal(me.email, 'camille@example.com');

    // agenda iCal : chiffré sur le disque
    const agendaUrl = `http://127.0.0.1:${apiPort}/agenda.ics`;
    assert.equal((await call('POST', '/api/calendars/ical', { url: 'ftp://x/y.ics' })).status, 400);
    assert.equal((await call('POST', '/api/calendars/ical', { url: agendaUrl, label: 'Perso' })).status, 200);
    app.store.flush();
    assert.ok(!fs.readFileSync(path.join(TMP, 'data', 'db.json'), 'utf8').includes('agenda.ics'), 'lien d’agenda chiffré');

    await call('PUT', '/api/settings', { gender: 'male', notify: { digest: true } });
    let r = (await call('GET', '/api/activities')).json;
    assert.equal(r.agenda.sources, 1);
    const byId = id => r.activities.find(a => a.id === id);
    assert.equal(byId(101).status, 'conflict');
    assert.equal(byId(101).conflicts[0].title, 'Dîner chez Paul');
    assert.equal(byId(103).status, 'free');
    assert.equal(byId(101).buyUrl, 'https://rendez-vous.social/event/101-soiree-oenologie/buy');

    for (const id of [101, 102]) assert.equal((await call('PUT', `/api/selections/${id}`, { selected: true })).status, 200);
    assert.equal((await call('PUT', '/api/selections/999', { selected: true })).status, 404);

    // flux iCal (lien secret, sans session)
    const feedPath = new URL((await call('GET', '/api/me')).json.user.feedUrl).pathname;
    const feed = await fetch(B + feedPath).then(x => x.text());
    assert.equal(C.parseIcs(feed, { rangeStart: Date.now() - C.DAY, rangeEnd: Date.now() + 30 * C.DAY }).length, 2);
    assert.equal((await fetch(B + '/feed/inconnu-inconnu-inconnu.ics')).status, 404);

    // 1er passage : alertes (conflit + 2 places) ; le résumé démarre sur la liste actuelle
    await app.notifier.runOnce();
    let out = app.mailer.outbox;
    assert.equal(out.length, 1);
    assert.match(out[0].subject, /2 alertes/);
    assert.match(out[0].text, /conflit avec « Dîner chez Paul »/);
    assert.match(out[0].text, /plus que 2 places pour les hommes/);
    assert.ok(out[0].headers['List-Unsubscribe']);

    // 2e passage : rien de nouveau
    await app.notifier.runOnce();
    assert.equal(out.length, 1);

    // une nouvelle activité libre est publiée -> résumé
    EVENTS.push(makeEvent(104, 'Atelier poterie', paris(7, 14)));
    rvs.clearMemoryCache(); fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true });
    await app.notifier.runOnce();
    assert.equal(out.length, 2);
    assert.match(out[1].subject, /1 nouvelle activité libre/);
    assert.match(out[1].text, /Atelier poterie/);

    // désinscription depuis le lien de l'e-mail
    const unsub = /Ne plus recevoir ces e-mails : (\S+)/.exec(out[1].text)[1].replace(`http://localhost:${port}`, '');
    assert.match(await fetch(B + unsub).then(x => x.text()), /Me désinscrire/);
    assert.equal((await fetch(B + unsub, { method: 'POST' })).status, 200);
    assert.deepEqual((await call('GET', '/api/me')).json.user.settings.notify, { alerts: false, reminder: false, digest: false });
    assert.equal((await fetch(B + unsub.replace(/t=[^&]+/, 't=faux'), { method: 'POST' })).status, 400);

    // connexion par lien e-mail (GET = page de confirmation, POST = connexion)
    const saved = jar; jar = '';
    assert.equal((await call('POST', '/auth/email', { email: 'nouvelle@example.com' })).status, 200);
    const link = /(\/auth\/email\/verify\?token=\S+)/.exec(out[out.length - 1].text)[1];
    assert.match(await fetch(B + link).then(x => x.text()), /Se connecter/);
    const post = await fetch(B + '/auth/email/verify', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + new URL(B + link).searchParams.get('token') });
    assert.equal(post.status, 302);
    jar = post.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('GET', '/api/me')).json.user.email, 'nouvelle@example.com');
    const reuse = await fetch(B + link).then(x => x.status);
    assert.equal(reuse, 400, 'lien à usage unique');

    // suppression du compte
    jar = saved;
    assert.equal((await call('DELETE', '/api/account')).status, 200);
    jar = saved;
    assert.equal((await call('GET', '/api/activities')).status, 401);
    assert.ok(!logs.some(l => l.startsWith('ERR')), logs.join('\n'));
  } finally {
    await app.close();
    fakeApi.close();
  }
});

test('site : liens d’agenda internes refusés sans ALLOW_PRIVATE_ICAL', async () => {
  const { createApp } = require('../web/server.js');
  const { loadConfig } = require('../web/config.js');
  const app = createApp(loadConfig({ PORT: '0', DATA_DIR: path.join(TMP, 'data2'), DEV_LOGIN: '1' }), { log: { log() {}, warn() {}, error() {} } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(B + '/auth/dev', { method: 'POST', headers: { 'x-rdv': '1', 'Content-Type': 'application/json' }, body: '{"email":"x@y.fr"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:22/', 'http://localhost/x.ics', 'http://[::1]/a']) {
      const res = await fetch(B + '/api/calendars/ical', { method: 'POST', headers: { 'x-rdv': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ url }) });
      assert.equal(res.status, 400, url);
    }
  } finally { await app.close(); }
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
