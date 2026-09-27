'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const CLI = require('../src/cli.js');

const LIST = require('./fixtures/events-paris.json');
const paris = (y, mo, d, h = 0, mi = 0) => C.zonedTimeToUtc(y, mo, d, h, mi, 0, 'Europe/Paris');
const NOW = paris(2026, 9, 27, 12, 0);
const CFG = { bufferMin: 30, defaultDurationMin: 120, ignoreAllDay: true };

test('prepareActivities : à venir, triées, fin par défaut, URL du site', () => {
  const acts = CLI.prepareActivities(JSON.parse(JSON.stringify(LIST)), CFG, NOW);
  // « Walk x Street Art » (11h, sans heure de fin) dure 2 h par défaut : encore en cours à midi.
  assert.ok(acts.length > 0 && acts.length <= LIST.length);
  for (let i = 1; i < acts.length; i++) assert.ok(acts[i - 1].start <= acts[i].start);
  assert.ok(acts.every(a => a.end > NOW));
  const walk = acts.find(a => a.id === 1485);
  assert.equal(walk.endKnown, false);
  assert.equal(walk.end - walk.start, 120 * C.MINUTE);
  const oeno = acts.find(a => a.id === 1889);
  assert.equal(oeno.url, 'https://rendez-vous.social/event/1889-soiree-oenologie');
  assert.equal(oeno.sale, true);
  assert.equal(acts.find(a => a.id === 1543).sale, false); // status "closed"
  // plus tard dans la journée : les activités passées disparaissent
  assert.equal(CLI.prepareActivities(JSON.parse(JSON.stringify(LIST)), CFG, paris(2026, 9, 27, 14)).some(a => a.id === 1485), false);
});

test('prepareActivities : hidden_at exclut l’activité', () => {
  const list = JSON.parse(JSON.stringify(LIST));
  list.find(e => e.id === 1889).hidden_at = '2026-09-20T00:00:00.000Z';
  assert.equal(CLI.prepareActivities(list, CFG, NOW).some(a => a.id === 1889), false);
});

test('annotate : libre / serré / conflit avec un agenda iCal', () => {
  const acts = CLI.prepareActivities(JSON.parse(JSON.stringify(LIST)), CFG, NOW);
  const ics = [
    'BEGIN:VCALENDAR',
    // chevauche la soirée oenologie (06/10 19h30–21h)
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Dîner chez Paul', 'DTSTART;TZID=Europe/Paris:20261006T200000', 'DTEND;TZID=Europe/Paris:20261006T230000', 'END:VEVENT',
    // finit 15 min avant le Comedy Club (29/09 19h)
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Sport', 'DTSTART;TZID=Europe/Paris:20260929T173000', 'DTEND;TZID=Europe/Paris:20260929T184500', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const busy = C.parseIcs(ics, { rangeStart: NOW, rangeEnd: NOW + 90 * C.DAY });
  CLI.annotate(acts, busy, CFG, true);
  const byId = id => acts.find(a => a.id === id);
  assert.equal(byId(1889).status, 'conflict');
  assert.equal(CLI.statusText(byId(1889)), '❌ Dîner chez Paul');
  assert.equal(byId(1534).status, 'tight');
  assert.equal(byId(1485).status, 'free');
  CLI.annotate(acts, [], CFG, false);
  assert.equal(byId(1889).status, 'unknown');
});

test('loadConfig : RDV_ICS + fichier de config, sans doublons', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ agendas: ['https://a.example/x.ics', 'b.ics'], margeMin: 45 }));
  const env = { ...process.env };
  process.env.RDV_CONFIG = file;
  process.env.RDV_ICS = 'https://a.example/x.ics, webcal://c.example/y';
  try {
    const cfg = CLI.loadConfig(['d.ics']);
    assert.deepEqual(cfg.agendas, ['https://a.example/x.ics', 'webcal://c.example/y', 'b.ics', 'd.ics']);
    assert.equal(cfg.bufferMin, 45);
    assert.equal(cfg.defaultDurationMin, 120);
  } finally { process.env = env; }
});

test('agendaLabel : ne révèle jamais le chemin secret du lien', () => {
  assert.equal(CLI.agendaLabel('https://calendar.google.com/calendar/ical/abc%40gmail.com/private-SECRET/basic.ics'), 'calendar.google.com');
  assert.equal(CLI.agendaLabel('webcal://p01-caldav.icloud.com/published/2/SECRET'), 'p01-caldav.icloud.com');
  assert.equal(CLI.agendaLabel('/home/moi/agenda.ics'), 'agenda.ics');
});

test('fit : largeur des emoji et troncature', () => {
  assert.equal(CLI.width('✅ libre'), 8);
  assert.equal(CLI.width('♂ / ♀'), 5);
  assert.equal(CLI.width('🔒 Rando'), 8);
  assert.equal(CLI.width('⚠️ serré'), 8);
  assert.equal(CLI.fit('abcdef', 4), 'abc…');
  assert.equal(CLI.width(CLI.fit('❌ Un très long évènement', 10)), 10);
});

test('buildHtml : échappe les titres', () => {
  const acts = CLI.prepareActivities(JSON.parse(JSON.stringify(LIST)), CFG, NOW).slice(0, 2);
  acts[0].title = '<script>alert(1)</script>';
  CLI.annotate(acts, [], CFG, true);
  const html = CLI.buildHtml(acts, 'meta');
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});
