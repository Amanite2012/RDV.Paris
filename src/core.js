/*
 * RDV.Paris — logique métier (sans DOM) :
 *  - lecture de calendriers iCalendar (.ics), y compris les récurrences simples
 *  - lecture des dates/heures écrites en français sur rendez-vous.social
 *  - détection des conflits avec le calendrier personnel
 *  - extraction du nombre d'hommes / de femmes inscrits
 *
 * Fonctionne dans Node (tests) et dans le navigateur (userscript).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RDVCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const DEFAULT_TZ = 'Europe/Paris';

  // ---------------------------------------------------------------------------
  // Fuseaux horaires
  // ---------------------------------------------------------------------------

  const dtfCache = {};
  function tzFormatter(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
    return dtfCache[tz];
  }

  // Décalage (ms) du fuseau `tz` à l'instant `utcMs`.
  function tzOffset(utcMs, tz) {
    const parts = {};
    for (const p of tzFormatter(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }

  // Heure murale dans `tz` -> instant UTC (ms).
  function zonedTimeToUtc(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
    let tzName = tz || DEFAULT_TZ;
    try { tzFormatter(tzName); } catch (e) { tzName = DEFAULT_TZ; }
    const off1 = tzOffset(guess, tzName);
    const off2 = tzOffset(guess - off1, tzName);
    return guess - off2;
  }

  // Composantes (année, mois, jour, jour de semaine…) d'un instant dans `tz`.
  function zonedParts(utcMs, tz) {
    const parts = {};
    for (const p of tzFormatter(tz || DEFAULT_TZ).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const y = +parts.year, mo = +parts.month, d = +parts.day;
    return { y, mo, d, h: +parts.hour, mi: +parts.minute, s: +parts.second, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
  }

  // ---------------------------------------------------------------------------
  // iCalendar (.ics)
  // ---------------------------------------------------------------------------

  function unfoldIcs(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  }

  function parseIcsLine(line) {
    // NOM;PARAM=VAL;PARAM2="V:AL":VALEUR
    let i = 0, inQuote = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ':' && !inQuote) break;
    }
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const segs = head.split(';');
    const params = {};
    for (const seg of segs.slice(1)) {
      const eq = seg.indexOf('=');
      if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name: segs[0].toUpperCase(), params, value };
  }

  function unescapeIcsText(v) {
    return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  }

  // Retourne { ms, allDay, floating, parts } ou null.
  function parseIcsDate(value, params, defaultTz) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    const parts = { y: +y, mo: +mo, d: +d, h: +(h || 0), mi: +(mi || 0), s: +(s || 0) };
    if (!h || (params && params.VALUE === 'DATE')) {
      return { ms: zonedTimeToUtc(parts.y, parts.mo, parts.d, 0, 0, 0, defaultTz), allDay: true, parts, tz: defaultTz };
    }
    if (z) return { ms: Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s), allDay: false, parts, tz: 'UTC' };
    const tz = (params && params.TZID) || defaultTz;
    return { ms: zonedTimeToUtc(parts.y, parts.mo, parts.d, parts.h, parts.mi, parts.s, tz), allDay: false, parts, tz };
  }

  function parseIcsDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * HOUR + (+m[5] || 0) * MINUTE + (+m[6] || 0) * 1000);
  }

  function parseRrule(v) {
    const r = {};
    for (const kv of String(v).split(';')) {
      const [k, val] = kv.split('=');
      if (k && val !== undefined) r[k.toUpperCase()] = val;
    }
    return r;
  }

  const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /**
   * Lit un fichier .ics et renvoie la liste des créneaux occupés
   * [{ start, end, title, allDay, busy }] (ms UTC), récurrences développées
   * sur la fenêtre [rangeStart, rangeEnd].
   */
  function parseIcs(text, opts) {
    opts = opts || {};
    const tz = opts.timeZone || DEFAULT_TZ;
    const rangeStart = opts.rangeStart != null ? opts.rangeStart : Date.now() - 7 * DAY;
    const rangeEnd = opts.rangeEnd != null ? opts.rangeEnd : Date.now() + 365 * DAY;
    const lines = unfoldIcs(text).split('\n');
    const raw = [];
    let cur = null, depth = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const p = parseIcsLine(line);
      if (p.name === 'BEGIN') {
        if (p.value.toUpperCase() === 'VEVENT' && !cur) { cur = { exdates: [] }; depth = 0; }
        else if (cur) depth++;
        continue;
      }
      if (p.name === 'END') {
        if (cur && depth > 0) { depth--; continue; }
        if (cur && p.value.toUpperCase() === 'VEVENT') { raw.push(cur); cur = null; }
        continue;
      }
      if (!cur || depth > 0) continue; // on ignore VALARM etc.
      switch (p.name) {
        case 'SUMMARY': cur.title = unescapeIcsText(p.value); break;
        case 'LOCATION': cur.location = unescapeIcsText(p.value); break;
        case 'UID': cur.uid = p.value; break;
        case 'DTSTART': cur.start = parseIcsDate(p.value, p.params, tz); break;
        case 'DTEND': cur.end = parseIcsDate(p.value, p.params, tz); break;
        case 'DURATION': cur.duration = parseIcsDuration(p.value); break;
        case 'RRULE': cur.rrule = parseRrule(p.value); break;
        case 'RECURRENCE-ID': cur.recurrenceId = parseIcsDate(p.value, p.params, tz); break;
        case 'EXDATE':
          for (const v of p.value.split(',')) {
            const d = parseIcsDate(v, p.params, tz);
            if (d) cur.exdates.push(d.ms);
          }
          break;
        case 'STATUS': cur.status = p.value.toUpperCase(); break;
        case 'TRANSP': cur.transp = p.value.toUpperCase(); break;
      }
    }

    // Occurrences modifiées (RECURRENCE-ID) : elles remplacent l'occurrence d'origine.
    const overrides = {};
    for (const ev of raw) {
      if (ev.recurrenceId && ev.uid) (overrides[ev.uid] = overrides[ev.uid] || []).push(ev.recurrenceId.ms);
    }

    const out = [];
    for (const ev of raw) {
      if (!ev.start) continue;
      if (ev.status === 'CANCELLED') continue;
      let dur;
      if (ev.end) dur = ev.end.ms - ev.start.ms;
      else if (ev.duration != null) dur = ev.duration;
      else dur = ev.start.allDay ? DAY : 0;
      const base = {
        title: ev.title || '(sans titre)',
        location: ev.location || '',
        allDay: ev.start.allDay,
        busy: ev.transp !== 'TRANSPARENT',
      };
      const skip = new Set(ev.exdates.concat(ev.recurrenceId ? [] : (overrides[ev.uid] || [])));
      const starts = ev.rrule && !ev.recurrenceId
        ? expandRrule(ev.start, ev.rrule, rangeStart - Math.max(dur, 0), rangeEnd)
        : [ev.start.ms];
      for (const s of starts) {
        if (skip.has(s)) continue;
        const e = s + dur;
        if (e < rangeStart || s > rangeEnd) continue;
        out.push(Object.assign({ start: s, end: e }, base));
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Développe une RRULE (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY).
  function expandRrule(start, rule, rangeStart, rangeEnd) {
    const freq = rule.FREQ;
    const interval = Math.max(1, +rule.INTERVAL || 1);
    const count = rule.COUNT ? +rule.COUNT : Infinity;
    let until = Infinity;
    if (rule.UNTIL) {
      const u = parseIcsDate(rule.UNTIL, {}, start.tz === 'UTC' ? 'UTC' : start.tz);
      if (u) until = u.allDay ? u.ms + DAY - 1 : u.ms;
    }
    const tz = start.tz || DEFAULT_TZ;
    const p = start.parts;
    const make = (y, mo, d) => start.tz === 'UTC'
      ? Date.UTC(y, mo - 1, d, p.h, p.mi, p.s)
      : zonedTimeToUtc(y, mo, d, p.h, p.mi, p.s, tz);
    const byDay = rule.BYDAY
      ? rule.BYDAY.split(',').map(x => ICS_DAYS[x.replace(/^[+-]?\d+/, '')]).filter(x => x !== undefined)
      : null;

    const out = [];
    let n = 0;
    const MAX_ITER = 5000;
    const push = ms => {
      if (ms < start.ms) return true;
      if (ms > until || n >= count) return false;
      n++;
      if (ms >= rangeStart && ms <= rangeEnd) out.push(ms);
      return ms <= rangeEnd;
    };

    if (freq === 'DAILY') {
      for (let i = 0; i < MAX_ITER; i++) {
        const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d + i * interval));
        if (byDay && !byDay.includes(dt.getUTCDay())) continue;
        if (!push(make(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) break;
      }
    } else if (freq === 'WEEKLY') {
      const days = byDay && byDay.length ? byDay.slice() : [new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
      // Semaine commençant le lundi (WKST=MO par défaut).
      const startDow = (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;
      const order = days.map(d => (d + 6) % 7).sort((a, b) => a - b);
      outer: for (let w = 0; w < MAX_ITER; w++) {
        for (const od of order) {
          const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d - startDow + w * 7 * interval + od));
          if (!push(make(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) break outer;
        }
      }
    } else if (freq === 'MONTHLY') {
      for (let i = 0; i < MAX_ITER; i++) {
        const dt = new Date(Date.UTC(p.y, p.mo - 1 + i * interval, 1));
        const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1;
        const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        if (rule.BYDAY) {
          // ex. BYDAY=2TH (2e jeudi) ou -1FR (dernier vendredi)
          const cands = [];
          for (const tok of rule.BYDAY.split(',')) {
            const mm = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
            if (!mm) continue;
            const wd = ICS_DAYS[mm[2]];
            const all = [];
            for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) all.push(d);
            if (mm[1]) { const k = +mm[1]; const d = k > 0 ? all[k - 1] : all[all.length + k]; if (d) cands.push(d); }
            else cands.push(...all);
          }
          cands.sort((a, b) => a - b);
          let stop = false;
          for (const d of cands) if (!push(make(y, mo, d))) { stop = true; break; }
          if (stop) break;
        } else {
          const d = rule.BYMONTHDAY ? +rule.BYMONTHDAY : p.d;
          if (d > dim) continue;
          if (!push(make(y, mo, d))) break;
        }
      }
    } else if (freq === 'YEARLY') {
      for (let i = 0; i < MAX_ITER; i++) {
        const y = p.y + i * interval;
        if (new Date(Date.UTC(y, p.mo - 1, p.d)).getUTCMonth() !== p.mo - 1) continue; // 29 février
        if (!push(make(y, p.mo, p.d))) break;
      }
    } else {
      out.push(start.ms);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Dates en français
  // ---------------------------------------------------------------------------

  const MONTHS = {
    janvier: 1, janv: 1, jan: 1,
    fevrier: 2, fevr: 2, fev: 2, 'février': 2, 'févr': 2, 'fév': 2,
    mars: 3, mar: 3,
    avril: 4, avr: 4,
    mai: 5,
    juin: 6,
    juillet: 7, juil: 7,
    aout: 8, 'août': 8,
    septembre: 9, sept: 9, sep: 9,
    octobre: 10, oct: 10,
    novembre: 11, nov: 11,
    decembre: 12, dec: 12, 'décembre': 12, 'déc': 12,
  };
  const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const TIME_RE = '(\\d{1,2})\\s*(?:h|:)\\s*(\\d{2})?';

  function stripAccents(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function parseTimes(text) {
    const times = [];
    const re = new RegExp('(?:^|[^\\d])' + TIME_RE + '(?![\\d])', 'gi');
    let m;
    while ((m = re.exec(text))) {
      const h = +m[1], mi = +(m[2] || 0);
      if (h < 24 && mi < 60) times.push({ h, mi, index: m.index });
    }
    return times;
  }

  /**
   * Trouve une date (et éventuellement une heure de début/fin) dans un texte
   * libre en français. `now` sert à deviner l'année si elle est absente.
   * Renvoie { start, end, hasTime } (ms UTC) ou null.
   */
  function parseFrenchDate(text, opts) {
    opts = opts || {};
    const now = opts.now != null ? opts.now : Date.now();
    const tz = opts.timeZone || DEFAULT_TZ;
    const defaultDuration = opts.defaultDurationMs != null ? opts.defaultDurationMs : 2 * HOUR;
    if (!text) return null;
    const src = String(text).replace(/\s+/g, ' ');
    const t = stripAccents(src.toLowerCase());

    let y, mo, d, idx = -1, len = 0;
    let m;
    // 2026-10-04 ou 2026-10-04T19:30
    if ((m = /(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/.exec(t))) {
      y = +m[1]; mo = +m[2]; d = +m[3]; idx = m.index; len = m[0].length;
      if (m[4]) {
        const start = zonedTimeToUtc(y, mo, d, +m[4], +m[5], 0, tz);
        return { start, end: start + defaultDuration, hasTime: true };
      }
    } else if ((m = /(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d\/])/.exec(t))) {
      d = +m[1]; mo = +m[2]; y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : undefined; idx = m.index; len = m[0].length;
    } else if ((m = new RegExp('(?:^|[^\\d])(1er|\\d{1,2})\\s+(' + stripAccents(MONTH_RE) + ')\\.?(?:\\s+(\\d{4}))?(?![a-z])', 'i').exec(t))) {
      d = m[1] === '1er' ? 1 : +m[1];
      mo = MONTHS[m[2]] || MONTHS[stripAccents(m[2])];
      y = m[3] ? +m[3] : undefined; idx = m.index; len = m[0].length;
    } else if (/\baujourd'?hui\b/.test(t) || /\bce soir\b/.test(t)) {
      const p = zonedParts(now, tz); y = p.y; mo = p.mo; d = p.d; idx = 0;
    } else if (/\bdemain\b/.test(t)) {
      const p = zonedParts(now + DAY, tz); y = p.y; mo = p.mo; d = p.d; idx = 0;
    }
    if (!mo || !d || mo > 12 || d > 31) return null;

    if (y === undefined) {
      const p = zonedParts(now, tz);
      y = p.y;
      // Date déjà passée de plus de 2 mois -> année suivante.
      const cand = Date.UTC(y, mo - 1, d);
      if (cand < Date.UTC(p.y, p.mo - 1, p.d) - 60 * DAY) y++;
    }

    // Heures : on privilégie celles qui suivent la date.
    const after = t.slice(Math.max(0, idx + len));
    let times = parseTimes(after);
    if (!times.length) times = parseTimes(t);
    if (!times.length) {
      const start = zonedTimeToUtc(y, mo, d, 0, 0, 0, tz);
      return { start, end: start + DAY, hasTime: false };
    }
    const start = zonedTimeToUtc(y, mo, d, times[0].h, times[0].mi, 0, tz);
    let end = start + defaultDuration;
    if (times[1]) {
      let e = zonedTimeToUtc(y, mo, d, times[1].h, times[1].mi, 0, tz);
      if (e <= start) e += DAY; // se termine après minuit
      if (e - start <= 16 * HOUR) end = e;
    }
    return { start, end, hasTime: true };
  }

  // ---------------------------------------------------------------------------
  // Conflits
  // ---------------------------------------------------------------------------

  /**
   * Compare une activité { start, end } aux créneaux du calendrier.
   * opts.bufferMs : marge avant/après (trajet). opts.ignoreAllDay : ignorer les
   * évènements « toute la journée » (anniversaires, jours fériés…).
   * Renvoie { status: 'free' | 'tight' | 'conflict', conflicts, near }.
   */
  function checkConflicts(activity, busy, opts) {
    opts = opts || {};
    const buffer = opts.bufferMs != null ? opts.bufferMs : 30 * MINUTE;
    const ignoreAllDay = opts.ignoreAllDay !== false;
    const conflicts = [], near = [];
    for (const b of busy) {
      if (!b.busy && b.busy !== undefined) continue;
      if (b.allDay && ignoreAllDay) continue;
      if (b.start < activity.end && b.end > activity.start) conflicts.push(b);
      else if (b.start < activity.end + buffer && b.end > activity.start - buffer) near.push(b);
    }
    return { status: conflicts.length ? 'conflict' : near.length ? 'tight' : 'free', conflicts, near };
  }

  // ---------------------------------------------------------------------------
  // Export .ics des activités choisies
  // ---------------------------------------------------------------------------

  function icsStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function escapeIcsText(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function foldIcs(line) {
    const out = [];
    while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
    out.push(line);
    return out.join('\r\n');
  }

  function buildIcs(activities, opts) {
    opts = opts || {};
    const now = icsStamp(opts.now != null ? opts.now : Date.now());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RDV.Paris//Planificateur//FR', 'CALSCALE:GREGORIAN'];
    for (const a of activities) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + (a.id || icsStamp(a.start) + '-' + Math.abs(hash(a.title || ''))) + '@rdv-paris');
      lines.push('DTSTAMP:' + now);
      lines.push('DTSTART:' + icsStamp(a.start));
      lines.push('DTEND:' + icsStamp(a.end));
      lines.push('SUMMARY:' + escapeIcsText(a.title));
      if (a.location) lines.push('LOCATION:' + escapeIcsText(a.location));
      if (a.url) lines.push('URL:' + a.url);
      if (a.description) lines.push('DESCRIPTION:' + escapeIcsText(a.description));
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldIcs).join('\r\n') + '\r\n';
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // ---------------------------------------------------------------------------
  // Répartition hommes / femmes
  // ---------------------------------------------------------------------------

  const MEN_WORDS = 'hommes?|garcons?|mecs?|messieurs|gars|masculins?';
  const WOMEN_WORDS = 'femmes?|filles?|dames?|mesdames|feminines?';

  function normText(s) {
    return stripAccents(String(s || '').toLowerCase()).replace(/\s+/g, ' ');
  }

  // Cherche « <nb> <mot> », « <mot> : <nb>[/<cap>] », « <nb> ♂ », « ♂ <nb> ».
  function findGenderCount(t, words, symbols, letter, otherWords) {
    const res = [];
    const num = '(\\d{1,4})(?!\\d)';
    // Un nombre précédé de « Femmes : » appartient aux femmes, pas aux hommes.
    const otherBefore = new RegExp('(?:' + otherWords + ')(?:\\s+(?:inscrit\\w*|participant\\w*))?\\s*[:=\\-]?\\s*$');
    const cap = '(?:\\s*(?:places?)?\\s*(?:restantes?|disponibles?|libres?)?\\s*(?:\\/|sur)\\s*(\\d{1,4}))?';
    const pats = [
      // "Hommes : 8/10", "hommes inscrits : 8", "places hommes : 8 / 10"
      { re: new RegExp('(?:' + words + ')(?:\\s+(?:inscrits?|inscrites?|participants?|participantes?|presents?|presentes?))?\\s*[:=\\-]?\\s*' + num + cap + '(?!\\s*(?:%|' + words + '))', 'g'), n: 1, c: 2 },
      // "8 hommes", "8 hommes inscrits", "8/10 hommes"
      { re: new RegExp(num + cap + '\\s+(?:' + words + ')\\b', 'g'), n: 1, c: 2, numFirst: true },
      // "♂ 8", "8 ♂", "👨 8"
      { re: new RegExp('(?:' + symbols + ')\\s*[:x]?\\s*' + num + cap, 'g'), n: 1, c: 2 },
      { re: new RegExp(num + cap + '\\s*(?:' + symbols + ')', 'g'), n: 1, c: 2, numFirst: true },
      // "H : 8", "H 8/10" (lettre seule, mot isolé)
      { re: new RegExp('(?:^|[^a-z0-9])' + letter + '\\s*[:=]\\s*' + num + cap, 'g'), n: 1, c: 2 },
    ];
    for (const p of pats) {
      let m;
      while ((m = p.re.exec(t))) {
        if (p.numFirst && otherBefore.test(t.slice(Math.max(0, m.index - 25), m.index))) continue;
        if (p.numFirst && m.index > 0 && /\d/.test(t[m.index - 1])) continue;
        const ctx = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 25);
        const remaining = /restante?s?|disponibles?|libres?|dispo\b|il reste|reste\b/.test(ctx);
        res.push({ count: +m[p.n], capacity: m[p.c] ? +m[p.c] : null, remaining, match: m[0].trim(), index: m.index });
      }
    }
    return res;
  }

  function pickBest(list) {
    if (!list.length) return null;
    // Préférence : inscrits (pas « restantes »), avec capacité, première occurrence.
    const scored = list.map(x => ({ x, s: (x.remaining ? 0 : 2) + (x.capacity != null ? 1 : 0) - x.index / 1e6 }));
    scored.sort((a, b) => b.s - a.s);
    return scored[0].x;
  }

  function toRegistered(x) {
    if (!x) return null;
    if (x.remaining) {
      if (x.capacity != null) return { registered: Math.max(0, x.capacity - x.count), capacity: x.capacity, remaining: x.count };
      return { registered: null, capacity: null, remaining: x.count };
    }
    return { registered: x.count, capacity: x.capacity, remaining: x.capacity != null ? Math.max(0, x.capacity - x.count) : null };
  }

  /**
   * Extrait le nombre d'hommes et de femmes d'un texte (page d'activité ou de
   * billetterie). Renvoie null si rien n'est trouvé, sinon
   * { men, women, menCapacity, womenCapacity, menRemaining, womenRemaining,
   *   total, pctMen, pctWomen, source, evidence }.
   */
  function extractGenderFromText(text) {
    const t = normText(text);
    const men = pickBest(findGenderCount(t, MEN_WORDS, '♂|👨|🙋‍♂️|🧔', 'h', WOMEN_WORDS + '|(?<![a-z])f|♀'));
    const women = pickBest(findGenderCount(t, WOMEN_WORDS, '♀|👩|🙋‍♀️', 'f', MEN_WORDS + '|(?<![a-z])h|♂'));
    if (!men && !women) {
      // Pourcentages directs : "60 % d'hommes", "hommes 45%"
      const pm = new RegExp('(\\d{1,3})\\s*%\\s*(?:d\'|de\\s+)?(?:' + MEN_WORDS + ')|(?:' + MEN_WORDS + ')\\s*:?\\s*(\\d{1,3})\\s*%').exec(t);
      const pw = new RegExp('(\\d{1,3})\\s*%\\s*(?:d\'|de\\s+)?(?:' + WOMEN_WORDS + ')|(?:' + WOMEN_WORDS + ')\\s*:?\\s*(\\d{1,3})\\s*%').exec(t);
      if (pm || pw) {
        let pctMen = pm ? +(pm[1] || pm[2]) : 100 - +(pw[1] || pw[2]);
        pctMen = Math.max(0, Math.min(100, pctMen));
        return finalize({ men: null, women: null, pctMen, pctWomen: 100 - pctMen, source: 'texte (%)', evidence: [pm && pm[0], pw && pw[0]].filter(Boolean) });
      }
      return null;
    }
    const m = toRegistered(men) || {};
    const w = toRegistered(women) || {};
    return finalize({
      men: m.registered != null ? m.registered : null,
      women: w.registered != null ? w.registered : null,
      menCapacity: m.capacity != null ? m.capacity : null,
      womenCapacity: w.capacity != null ? w.capacity : null,
      menRemaining: m.remaining != null ? m.remaining : null,
      womenRemaining: w.remaining != null ? w.remaining : null,
      source: 'texte',
      evidence: [men && men.match, women && women.match].filter(Boolean),
    });
  }

  const JSON_MEN_KEYS = /^(?:nb_?|nombre_?|count_?|num_?|total_?)?(?:men|males?|hommes?|man|homme|boys?|garcons?)(?:_?(?:count|nb|number|registered|inscrits?|participants?|attendees?|total))?$/i;
  const JSON_WOMEN_KEYS = /^(?:nb_?|nombre_?|count_?|num_?|total_?)?(?:women|females?|femmes?|woman|femme|girls?|filles?)(?:_?(?:count|nb|number|registered|inscrites?|participantes?|attendees?|total))?$/i;
  const JSON_GENDER_FIELD = /^(?:gender|genre|sexe|sex|civilite|civility)$/i;

  function genderOfValue(v) {
    const s = normText(v);
    if (/^(?:m|h|male|man|men|homme|masculin|monsieur|mr|m\.)$/.test(s)) return 'men';
    if (/^(?:f|w|female|woman|women|femme|feminin|madame|mme|mlle)$/.test(s)) return 'women';
    return null;
  }

  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return +v;
    return null;
  }

  /**
   * Format de l'API rendez-vous.social (réponse de /event/<id>) :
   *   tickets_male / tickets_female : billets vendus par genre
   *   rates[] : { gender_category: 'male' | 'female', quantity, remaining }
   * Les billets vendus priment ; à défaut on les déduit de quantity - remaining.
   */
  function genderFromEventObject(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const acc = { men: { cap: null, rem: null }, women: { cap: null, rem: null } };
    if (Array.isArray(o.rates)) {
      for (const r of o.rates) {
        if (!r || typeof r !== 'object') continue;
        const g = genderOfValue(r.gender_category != null ? r.gender_category : (r.gender || ''));
        if (!g) continue;
        const q = num(r.quantity), rem = num(r.remaining);
        if (q != null) acc[g].cap = (acc[g].cap || 0) + q;
        if (rem != null) acc[g].rem = (acc[g].rem || 0) + rem;
      }
    }
    const sold = g => (acc[g].cap != null && acc[g].rem != null ? Math.max(0, acc[g].cap - acc[g].rem) : null);
    const tm = num(o.tickets_male), tf = num(o.tickets_female);
    const men = tm != null ? tm : sold('men');
    const women = tf != null ? tf : sold('women');
    if (men == null && women == null) return null;
    const remaining = (g, n) => (acc[g].rem != null ? acc[g].rem : acc[g].cap != null && n != null ? Math.max(0, acc[g].cap - n) : null);
    return finalize({
      men: men != null ? men : 0,
      women: women != null ? women : 0,
      menCapacity: acc.men.cap, womenCapacity: acc.women.cap,
      menRemaining: remaining('men', men), womenRemaining: remaining('women', women),
      source: 'billetterie rendez-vous.social',
      evidence: [],
    });
  }

  const START_KEYS = /^(?:starts?(?:_?(?:at|date|time|datetime))?|date(?:_?(?:start|debut))?|begins?_?at|debut|date_?time)$/i;
  const END_KEYS = /^(?:ends?(?:_?(?:at|date|time|datetime))?|date_?(?:end|fin)|fin)$/i;

  function isoDate(v) {
    if (typeof v !== 'string' || v.length < 10 || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
    const ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }

  const HHMM = /^(\d{1,2}):(\d{2})/;

  /**
   * Horaires au format de l'API rendez-vous.social :
   *   event_datetime (instant UTC du début), date (jour local à minuit « Z »),
   *   time_start / time_end (« 19:30:00 », heure locale, time_end souvent null), timezone.
   * Le champ `date` seul n'est pas une heure de début : il ne sert qu'à dater time_start/time_end.
   */
  function rvsTimes(o) {
    const day = typeof o.date === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(o.date);
    const hasRvs = o.event_datetime != null || (day && (typeof o.time_start === 'string' || typeof o.time_end === 'string'));
    if (!hasRvs) return null;
    const tz = typeof o.timezone === 'string' ? o.timezone : DEFAULT_TZ;
    const at = t => {
      const m = day && typeof t === 'string' && HHMM.exec(t);
      return m ? zonedTimeToUtc(+day[1], +day[2], +day[3], +m[1], +m[2], 0, tz) : null;
    };
    let start = isoDate(o.event_datetime);
    if (start == null) start = at(o.time_start);
    let end = at(o.time_end);
    if (start != null && end != null) {
      while (end <= start) end += DAY; // se termine après minuit
      if (end - start > DAY) end = null;
    }
    return { start, end };
  }

  /** Chemin d'une activité sur le site (même règle que l'application : /event/<id>-<titre-slugifié>). */
  function eventPath(id, title) {
    const slug = String(title || 'event').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `/event/${id}-${slug || 'event'}`;
  }

  /**
   * Repère les évènements dans une réponse JSON (liste d'activités ou détail) :
   * [{ id, title, slug, start, end, gender, status, location }].
   */
  function extractEventsFromJson(obj) {
    const out = new Map();
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 25 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) { for (const it of o) walk(it, depth + 1); return; }
      const id = num(o.id);
      if (id != null) {
        let start = null, end = null;
        const rvs = rvsTimes(o);
        if (rvs) ({ start, end } = rvs);
        else {
          for (const k of Object.keys(o)) {
            if (start == null && START_KEYS.test(k)) start = isoDate(o[k]);
            else if (end == null && END_KEYS.test(k)) end = isoDate(o[k]);
          }
        }
        const gender = genderFromEventObject(o);
        const title = typeof o.name === 'string' ? o.name : typeof o.title === 'string' ? o.title : null;
        if ((start != null && title) || gender) {
          const prev = out.get(id) || {};
          out.set(id, {
            id,
            title: title || prev.title || null,
            slug: typeof o.slug === 'string' ? o.slug : prev.slug || null,
            start: start != null ? start : prev.start != null ? prev.start : null,
            end: end != null ? end : prev.end != null ? prev.end : null,
            gender: gender || prev.gender || null,
            status: typeof o.status === 'string' ? o.status : prev.status || null,
            location: placeOf(o) || prev.location || null,
          });
        }
      }
      for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && k !== 'rates') walk(o[k], depth + 1);
    })(obj, 0);
    return Array.from(out.values());
  }

  function placeOf(o) {
    const p = Array.isArray(o.places) ? o.places.find(x => x && typeof x === 'object' && x.name) : null;
    if (!p) return typeof o.location === 'string' ? o.location : null;
    return p.postal_code ? `${p.name} (${p.postal_code})` : p.name;
  }

  /**
   * Parcourt un objet JSON (données embarquées dans la page, réponse d'API…)
   * à la recherche de compteurs hommes/femmes ou d'une liste de participants
   * avec un champ « gender ».
   */
  function extractGenderFromJson(obj) {
    const direct = (function find(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return null;
      const r = genderFromEventObject(o);
      if (r) return r;
      if (Array.isArray(o)) return null; // une liste d'évènements : pas de ratio unique
      for (const k of Object.keys(o)) {
        if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
          const x = find(o[k], depth + 1);
          if (x) return x;
        }
      }
      return null;
    })(obj, 0);
    if (direct) return direct;
    let men = null, women = null;
    const listCounts = { men: 0, women: 0, seen: 0 };
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 25 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        for (const it of o) {
          if (it && typeof it === 'object' && !Array.isArray(it)) {
            for (const k of Object.keys(it)) {
              if (JSON_GENDER_FIELD.test(k) && typeof it[k] === 'string') {
                const g = genderOfValue(it[k]);
                if (g) { listCounts[g]++; listCounts.seen++; }
              }
            }
          }
          walk(it, depth + 1);
        }
        return;
      }
      for (const k of Object.keys(o)) {
        const v = o[k];
        const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : null);
        if (n != null) {
          if (men == null && JSON_MEN_KEYS.test(k)) men = n;
          else if (women == null && JSON_WOMEN_KEYS.test(k)) women = n;
        } else if (v && typeof v === 'object') {
          // { gender: { male: 3, female: 5 } } ou { hommes: { inscrits: 3 } }
          if (JSON_MEN_KEYS.test(k) && men == null) { const c = firstNumber(v); if (c != null) men = c; }
          else if (JSON_WOMEN_KEYS.test(k) && women == null) { const c = firstNumber(v); if (c != null) women = c; }
          walk(v, depth + 1);
        }
      }
    })(obj, 0);
    if (men != null || women != null) return finalize({ men, women, source: 'données JSON', evidence: [] });
    if (listCounts.seen) return finalize({ men: listCounts.men, women: listCounts.women, source: 'liste des participants', evidence: [] });
    return null;
  }

  function firstNumber(o) {
    for (const k of ['count', 'registered', 'inscrits', 'inscrites', 'nb', 'total', 'value']) {
      if (typeof o[k] === 'number') return o[k];
    }
    return null;
  }

  function finalize(r) {
    const out = Object.assign({
      men: null, women: null, menCapacity: null, womenCapacity: null,
      menRemaining: null, womenRemaining: null, pctMen: null, pctWomen: null,
    }, r);
    if (out.men != null && out.women != null) {
      out.total = out.men + out.women;
      if (out.total > 0) {
        out.pctMen = Math.round(out.men / out.total * 100);
        out.pctWomen = 100 - out.pctMen;
      }
    } else if (out.total == null) {
      out.total = null;
    }
    return out;
  }

  return {
    MINUTE, HOUR, DAY,
    zonedTimeToUtc, zonedParts,
    parseIcs, parseIcsDate, parseIcsDuration, expandRrule,
    parseFrenchDate, parseTimes,
    checkConflicts, buildIcs,
    extractGenderFromText, extractGenderFromJson, extractEventsFromJson, genderFromEventObject,
    rvsTimes, eventPath,
    normText,
  };
});
