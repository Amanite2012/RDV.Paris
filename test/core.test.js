'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

const paris = (y, mo, d, h = 0, mi = 0) => C.zonedTimeToUtc(y, mo, d, h, mi, 0, 'Europe/Paris');
const NOW = paris(2026, 9, 27, 12, 0);

test('fuseau Europe/Paris : heure d’été et d’hiver', () => {
  assert.equal(new Date(paris(2026, 7, 1, 19, 30)).toISOString(), '2026-07-01T17:30:00.000Z');
  assert.equal(new Date(paris(2026, 12, 1, 19, 30)).toISOString(), '2026-12-01T18:30:00.000Z');
});

test('parseIcs : évènement simple, UTC, journée entière, TZID', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Dîner\\, chez Paul', 'DTSTART;TZID=Europe/Paris:20261003T200000', 'DTEND;TZID=Europe/Paris:20261003T230000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:2', 'SUMMARY:Réunion', 'DTSTART:20261005T080000Z', 'DURATION:PT1H30M',
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:3', 'SUMMARY:Anniv', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:4', 'SUMMARY:Annulé', 'STATUS:CANCELLED', 'DTSTART:20261006T080000Z', 'DTEND:20261006T090000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = C.parseIcs(ics, { rangeStart: NOW, rangeEnd: NOW + 60 * C.DAY });
  assert.equal(ev.length, 3);
  assert.equal(ev[0].title, 'Dîner, chez Paul');
  assert.equal(ev[0].start, paris(2026, 10, 3, 20));
  assert.equal(ev[0].end, paris(2026, 10, 3, 23));
  assert.equal(ev[1].end - ev[1].start, 90 * C.MINUTE);
  assert.equal(ev[2].allDay, true);
});

test('parseIcs : lignes repliées', () => {
  const ics = 'BEGIN:VEVENT\r\nSUMMARY:Un titre très\r\n  long\r\nDTSTART:20261005T080000Z\r\nDTEND:20261005T090000Z\r\nEND:VEVENT';
  const ev = C.parseIcs(ics, { rangeStart: NOW, rangeEnd: NOW + 30 * C.DAY });
  assert.equal(ev[0].title, 'Un titre très long');
});

test('parseIcs : récurrence hebdomadaire avec EXDATE et occurrence modifiée', () => {
  const ics = [
    'BEGIN:VEVENT', 'UID:yoga', 'SUMMARY:Yoga',
    'DTSTART;TZID=Europe/Paris:20260901T190000', 'DTEND;TZID=Europe/Paris:20260901T200000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261031T000000Z',
    'EXDATE;TZID=Europe/Paris:20261001T190000',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:yoga', 'SUMMARY:Yoga (déplacé)', 'RECURRENCE-ID;TZID=Europe/Paris:20261006T190000',
    'DTSTART;TZID=Europe/Paris:20261007T190000', 'DTEND;TZID=Europe/Paris:20261007T200000', 'END:VEVENT',
  ].join('\n');
  const ev = C.parseIcs(ics, { rangeStart: paris(2026, 9, 28), rangeEnd: paris(2026, 10, 9) });
  const starts = ev.map(e => new Date(e.start).toISOString());
  assert.deepEqual(starts, [
    '2026-09-29T17:00:00.000Z', // mar 29/09
    // jeu 01/10 exclu
    '2026-10-07T17:00:00.000Z', // occurrence déplacée (mar 06 -> mer 07)
    '2026-10-08T17:00:00.000Z', // jeu 08/10
  ]);
});

test('parseIcs : récurrence mensuelle (2e jeudi) avec COUNT', () => {
  const ics = 'BEGIN:VEVENT\nUID:m\nSUMMARY:Club\nDTSTART:20260910T170000Z\nDTEND:20260910T190000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TH;COUNT=3\nEND:VEVENT';
  const ev = C.parseIcs(ics, { rangeStart: paris(2026, 1, 1), rangeEnd: paris(2027, 12, 1) });
  assert.deepEqual(ev.map(e => new Date(e.start).toISOString().slice(0, 10)), ['2026-09-10', '2026-10-08', '2026-11-12']);
});

test('parseFrenchDate : formats courants', () => {
  const opts = { now: NOW };
  let r = C.parseFrenchDate('Samedi 4 octobre 2026 · 19h30 - 22h', opts);
  assert.equal(r.start, paris(2026, 10, 4, 19, 30));
  assert.equal(r.end, paris(2026, 10, 4, 22, 0));

  r = C.parseFrenchDate('sam. 4 oct. à 19h', opts);
  assert.equal(r.start, paris(2026, 10, 4, 19));
  assert.equal(r.end - r.start, 2 * C.HOUR);

  r = C.parseFrenchDate('04/10/2026 de 20:00 à 01:00', opts);
  assert.equal(r.start, paris(2026, 10, 4, 20));
  assert.equal(r.end, paris(2026, 10, 5, 1));

  r = C.parseFrenchDate('Jeudi 1er janvier, 18h', opts); // année suivante
  assert.equal(r.start, paris(2027, 1, 1, 18));

  r = C.parseFrenchDate('2026-10-12T10:00:00+02:00', opts);
  assert.equal(r.start, paris(2026, 10, 12, 10));

  r = C.parseFrenchDate('Mercredi 15 décembre', opts);
  assert.equal(r.hasTime, false);

  assert.equal(C.parseFrenchDate('Volley au parc', opts), null);
});

test('checkConflicts : libre, serré, conflit, journée entière ignorée', () => {
  const busy = [
    { start: paris(2026, 10, 4, 18), end: paris(2026, 10, 4, 19), title: 'Sport', busy: true },
    { start: paris(2026, 10, 4), end: paris(2026, 10, 5), title: 'Anniv', allDay: true, busy: true },
  ];
  const act = (h1, h2) => ({ start: paris(2026, 10, 4, h1), end: paris(2026, 10, 4, h2) });
  assert.equal(C.checkConflicts(act(18, 20), busy).status, 'conflict');
  assert.equal(C.checkConflicts(act(19, 21), busy).status, 'tight');
  assert.equal(C.checkConflicts(act(20, 22), busy).status, 'free');
  assert.equal(C.checkConflicts(act(20, 22), busy, { ignoreAllDay: false }).status, 'conflict');
});

test('buildIcs : export relisible', () => {
  const a = { title: 'Speed dating, Bastille', start: paris(2026, 10, 4, 19), end: paris(2026, 10, 4, 21), location: 'Paris 11e', url: 'https://rendez-vous.social/paris/x' };
  const ics = C.buildIcs([a]);
  const back = C.parseIcs(ics, { rangeStart: NOW, rangeEnd: NOW + 30 * C.DAY });
  assert.equal(back.length, 1);
  assert.equal(back[0].title, a.title);
  assert.equal(back[0].start, a.start);
});

test('extractGenderFromText : formats variés', () => {
  let r = C.extractGenderFromText('Participants : 8 hommes et 12 femmes');
  assert.equal(r.men, 8); assert.equal(r.women, 12); assert.equal(r.pctMen, 40); assert.equal(r.pctWomen, 60);

  r = C.extractGenderFromText('Hommes 8/10 Femmes 6/10');
  assert.deepEqual([r.men, r.menCapacity, r.women, r.womenCapacity], [8, 10, 6, 10]);

  r = C.extractGenderFromText('Hommes : 3 places restantes sur 10 — Femmes : 1 place restante sur 10');
  assert.equal(r.men, 7); assert.equal(r.women, 9); assert.equal(r.menRemaining, 3);

  r = C.extractGenderFromText('♂ 5 ♀ 7');
  assert.equal(r.men, 5); assert.equal(r.women, 7);

  r = C.extractGenderFromText('H : 4 · F : 6 · 19h30');
  assert.equal(r.men, 4); assert.equal(r.women, 6);

  r = C.extractGenderFromText('Public : 55 % de femmes');
  assert.equal(r.pctWomen, 55); assert.equal(r.pctMen, 45);

  assert.equal(C.extractGenderFromText('Tournoi de volley, 19h, 12 €'), null);
});

test('extractGenderFromJson : compteurs et liste de participants', () => {
  let r = C.extractGenderFromJson({ props: { event: { id: 3, stats: { male_count: 9, female_count: 11 } } } });
  assert.equal(r.men, 9); assert.equal(r.women, 11);

  r = C.extractGenderFromJson({ attendees: [{ name: 'A', gender: 'female' }, { name: 'B', gender: 'M' }, { name: 'C', gender: 'F' }] });
  assert.equal(r.men, 1); assert.equal(r.women, 2);

  assert.equal(C.extractGenderFromJson({ foo: 1, bar: [1, 2] }), null);
});

// Réponse réelle (abrégée) de l'API rendez-vous.social pour /event/1889-soiree-oenologie/buy
const RVS_EVENT = {
  id: 1889, name: 'Soirée oenologie', cancellation_policy: 'normal',
  rates: [
    { id: 6430, name: 'Tarif Regular', price: 45, gender_category: 'male', event_id: 1889, quantity: 8, remaining: 8, type: null },
    { id: 6431, name: 'Tarif Regular', price: 45, gender_category: 'female', event_id: 1889, quantity: 8, remaining: 7, type: null },
  ],
  places: [{}], tickets_male: 0, tickets_female: 1,
  waitlist: { enabled: true, open: true, deadline_at: '2026-10-06T11:30:00.000+00:00' },
};

test('API rendez-vous.social : tickets_male/female + rates', () => {
  const r = C.extractGenderFromJson(RVS_EVENT);
  assert.deepEqual(
    [r.men, r.women, r.menCapacity, r.womenCapacity, r.menRemaining, r.womenRemaining, r.pctMen, r.pctWomen],
    [0, 1, 8, 8, 8, 7, 0, 100]);
  // imbriqué dans une enveloppe { data: { event } }
  assert.equal(C.extractGenderFromJson({ data: { event: RVS_EVENT } }).women, 1);
});

test('API rendez-vous.social : déduit des rates sans tickets_*', () => {
  const ev = { id: 1, rates: [
    { gender_category: 'male', quantity: 10, remaining: 4 },
    { gender_category: 'male', quantity: 2, remaining: 2 },
    { gender_category: 'female', quantity: 10, remaining: 1 },
  ] };
  const r = C.extractGenderFromJson(ev);
  assert.deepEqual([r.men, r.women, r.menCapacity, r.womenCapacity], [6, 9, 12, 10]);
  assert.equal(r.pctMen, 40);
});

test('extractEventsFromJson : liste d’activités', () => {
  const list = { events: [
    Object.assign({}, RVS_EVENT, { starts_at: '2026-10-08T17:30:00.000+00:00', ends_at: '2026-10-08T19:00:00.000+00:00', slug: '1889-soiree-oenologie' }),
    { id: 1900, name: 'Volley', start_date: '2026-10-09T16:00:00Z', tickets_male: 5, tickets_female: 5 },
    { id: 7, name: 'Sans date ni billets' },
  ] };
  const evs = C.extractEventsFromJson(list);
  assert.equal(evs.length, 2);
  const oeno = evs.find(e => e.id === 1889);
  assert.equal(oeno.start, Date.parse('2026-10-08T17:30:00Z'));
  assert.equal(oeno.end, Date.parse('2026-10-08T19:00:00Z'));
  assert.equal(oeno.gender.women, 1);
  assert.equal(evs.find(e => e.id === 1900).gender.pctMen, 50);
});

// Réponses réelles de l'API (test/fixtures, données personnelles retirées) :
//   GET /events?city_id=paris  -> tableau d'activités
//   GET /event/1889            -> détail d'une activité
const LIST = require('./fixtures/events-paris.json');
const DETAIL = require('./fixtures/event-1889.json');

test('API réelle : horaires = event_datetime (pas le champ date à minuit)', () => {
  const evs = C.extractEventsFromJson(LIST);
  assert.equal(evs.length, LIST.length);
  const oeno = evs.find(e => e.id === 1889);
  assert.equal(oeno.title, 'Soirée oenologie');
  assert.equal(oeno.start, paris(2026, 10, 6, 19, 30));
  assert.equal(oeno.end, paris(2026, 10, 6, 21, 0));
  assert.equal(oeno.status, 'sale');
  assert.match(oeno.location, /\S/);
  // time_end null -> fin inconnue
  const walk = evs.find(e => e.id === 1485);
  assert.equal(walk.start, paris(2026, 9, 27, 11, 0));
  assert.equal(walk.end, null);
  for (const e of evs) assert.equal(new Date(e.start).getUTCHours() === 0 && new Date(e.start).getUTCMinutes() === 0, false, e.title);
});

test('API réelle : répartition H/F depuis la liste et le détail', () => {
  const fromList = C.extractEventsFromJson(LIST).find(e => e.id === 1889).gender;
  const fromDetail = C.extractEventsFromJson(DETAIL)[0].gender;
  for (const g of [fromList, fromDetail]) {
    assert.deepEqual([g.men, g.women, g.menCapacity, g.womenCapacity, g.menRemaining, g.womenRemaining], [0, 1, 8, 8, 8, 7]);
  }
  assert.ok(C.extractEventsFromJson(LIST).every(e => e.gender), 'chaque activité de la liste a ses rates');
});

test('rvsTimes : fin après minuit, date seule sans event_datetime', () => {
  let r = C.rvsTimes({ date: '2026-10-10T00:00:00.000Z', time_start: '22:00:00', time_end: '02:00:00', timezone: 'Europe/Paris' });
  assert.equal(r.start, paris(2026, 10, 10, 22));
  assert.equal(r.end, paris(2026, 10, 11, 2));
  assert.equal(C.rvsTimes({ date: '2026-10-10' }), null);
});

test('eventPath : même slug que le site', () => {
  assert.equal(C.eventPath(1889, 'Soirée oenologie'), '/event/1889-soiree-oenologie');
  assert.equal(C.eventPath(1584, 'Balade "Montmartre au féminin"'), '/event/1584-balade-montmartre-au-feminin');
  assert.equal(C.eventPath(1, '!!!'), '/event/1-event');
});
