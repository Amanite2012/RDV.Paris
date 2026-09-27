/*
 * Activités à venir, annotées pour un utilisateur (libre / serré / conflit selon ses agendas).
 */
'use strict';
const C = require('../src/core.js');
const rvs = require('../src/rvs.js');

function hasCalendars(user) {
  return user.calendars.length > 0 || !!(user.google && user.google.refresh && user.google.calendars.some(c => c.selected));
}

function createPlanner({ cfg, calendars, log = console }) {
  async function forUser(user, { fresh = false } = {}) {
    const s = user.settings;
    const acts = await rvs.fetchActivities({ city: cfg.city, defaultDurationMin: s.defaultDurationMin }, false, m => log.warn(m));
    const now = Date.now();
    const range = { rangeStart: now - C.DAY, rangeEnd: Math.max(now, ...acts.map(a => a.end)) + C.DAY };
    const { busy, errors, sources } = hasCalendars(user)
      ? await calendars.loadBusy(user, range, { fresh })
      : { busy: [], errors: [], sources: 0 };
    rvs.annotate(acts, busy, { bufferMin: s.bufferMin, ignoreAllDay: s.ignoreAllDay }, sources > 0);
    return { acts, agenda: { sources, errors, events: busy.length } };
  }
  return { forUser };
}

module.exports = { createPlanner, hasCalendars };
