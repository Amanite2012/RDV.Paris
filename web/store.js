/*
 * Stockage : un fichier JSON (DATA_DIR/db.json), réécrit de façon atomique.
 * Suffisant pour quelques centaines d'utilisateurs sur un seul processus.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { token } = require('./secure.js');

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'db.json');
  let data = { users: {}, sessions: {}, loginTokens: {} };
  if (fs.existsSync(file)) data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));

  let timer = null;
  function flush() {
    clearTimeout(timer); timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function save() { if (!timer) timer = setTimeout(flush, 200); }

  function newUser(fields) {
    const id = token(12);
    const user = Object.assign({
      id, email: null, name: null, googleSub: null, createdAt: Date.now(),
      settings: {
        gender: null, bufferMin: 30, defaultDurationMin: 120, ignoreAllDay: true,
        notify: { alerts: true, reminder: true, digest: false }, lowPlaces: 3,
      },
      calendars: [], // { id, type: 'ical', label, url (chiffré), addedAt }
      google: null, // { refresh (chiffré), scopes, calendars: [{ id, summary, primary, selected }], error }
      selections: {}, // id activité -> { title, start, end, url, addedAt }
      feedToken: token(18),
      notifyState: { initialized: false, seen: [], sent: {} },
    }, fields);
    data.users[id] = user;
    save();
    return user;
  }

  function cleanup(now = Date.now()) {
    for (const [k, s] of Object.entries(data.sessions)) if (s.expires < now) delete data.sessions[k];
    for (const [k, t] of Object.entries(data.loginTokens)) if (t.expires < now) delete data.loginTokens[k];
    save();
  }

  const normEmail = e => String(e || '').trim().toLowerCase();

  return {
    get data() { return data; },
    save, flush, newUser, cleanup,
    user: id => data.users[id] || null,
    users: () => Object.values(data.users),
    byEmail: email => Object.values(data.users).find(u => u.email && u.email === normEmail(email)) || null,
    byGoogleSub: sub => Object.values(data.users).find(u => u.googleSub === sub) || null,
    byFeedToken: t => Object.values(data.users).find(u => u.feedToken === t) || null,
    deleteUser(id) {
      delete data.users[id];
      for (const [k, s] of Object.entries(data.sessions)) if (s.userId === id) delete data.sessions[k];
      save();
    },
    normEmail,
  };
}

module.exports = { createStore };
