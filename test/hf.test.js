'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const { buildRows } = require('../src/hf.js');

const LIST = require('./fixtures/events-paris.json');
const NOW = C.zonedTimeToUtc(2026, 9, 27, 12, 0, 0, 'Europe/Paris');

test('hf : activités à venir, triées, avec CP et % H/F', () => {
  const rows = buildRows(LIST, { now: NOW });
  assert.ok(rows.length > 30);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].start <= rows[i].start);
  assert.ok(rows.every(r => r.start > NOW), 'pas d’activité déjà commencée');
  assert.equal(rows.some(r => r.id === 1485), false); // 11h ce jour-là : déjà passée
  const oeno = rows.find(r => r.id === 1889);
  assert.deepEqual([oeno.pctMen, oeno.pctWomen, oeno.men, oeno.women, oeno.dept], [0, 100, 0, 1, '75']);
  assert.match(oeno.postalCode, /^75\d{3}$/);
  assert.equal(oeno.url, 'https://rendez-vous.social/event/1889-soiree-oenologie');
  assert.ok(rows.every(r => r.pctMen == null || r.pctMen + r.pctWomen === 100));
  assert.ok(rows.every(r => !/\s{2}/.test(r.title)));
  // hors Paris intramuros
  assert.ok(new Set(rows.map(r => r.dept)).size > 1);
});

test('hf : filtre par département', () => {
  const rows = buildRows(LIST, { now: NOW, depts: ['77', '91'] });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => ['77', '91'].includes(r.dept)));
});
