/*
 * RDV.Paris — interface injectée dans rendez-vous.social.
 * Dépend de RDVCore (src/core.js), concaténé avant ce fichier au build.
 */
(function () {
  'use strict';
  const C = RDVCore;
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------------------------------------------------------------------------
  // Stockage & réseau (API Greasemonkey si dispo, sinon repli navigateur)
  // ---------------------------------------------------------------------------

  const hasGM = typeof GM_getValue === 'function';
  const store = {
    get(k, def) {
      try {
        if (hasGM) return GM_getValue(k, def);
        const v = localStorage.getItem('rdvparis:' + k);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try {
        if (hasGM) GM_setValue(k, v);
        else localStorage.setItem('rdvparis:' + k, JSON.stringify(v));
      } catch (e) { /* stockage indisponible */ }
    },
  };

  function httpGet(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 20000,
          onload: r => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('réseau')),
          ontimeout: () => reject(new Error('délai dépassé')),
        });
      });
    }
    return fetch(url, { credentials: 'include' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    calendars: [],          // [{ name, url }]
    importedIcs: '',        // contenu d'un .ics importé à la main
    bufferMin: 30,          // marge trajet avant/après
    defaultDurationMin: 120,
    ignoreAllDay: true,
    hideConflicts: false,
    prefetchGender: true,
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  let selection = store.get('selection', {}); // id -> activité choisie
  const saveSelection = () => store.set('selection', selection);

  // ---------------------------------------------------------------------------
  // Calendrier personnel
  // ---------------------------------------------------------------------------

  let busy = [];
  let calendarStatus = 'Aucun calendrier configuré';
  const CAL_CACHE_MS = 30 * C.MINUTE;

  async function loadCalendars(force) {
    const texts = [];
    const errors = [];
    const cache = store.get('calCache', {});
    for (const cal of settings.calendars) {
      const hit = cache[cal.url];
      if (!force && hit && Date.now() - hit.at < CAL_CACHE_MS) { texts.push(hit.text); continue; }
      try {
        const text = await httpGet(cal.url);
        if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('ce lien ne renvoie pas un fichier .ics');
        cache[cal.url] = { at: Date.now(), text };
        texts.push(text);
      } catch (e) {
        errors.push((cal.name || cal.url) + ' : ' + e.message);
        if (hit) texts.push(hit.text);
      }
    }
    store.set('calCache', cache);
    if (settings.importedIcs) texts.push(settings.importedIcs);
    const opts = { rangeStart: Date.now() - C.DAY, rangeEnd: Date.now() + 400 * C.DAY };
    busy = [];
    for (const t of texts) {
      try { busy = busy.concat(C.parseIcs(t, opts)); } catch (e) { errors.push('fichier illisible'); }
    }
    busy.sort((a, b) => a.start - b.start);
    const n = settings.calendars.length + (settings.importedIcs ? 1 : 0);
    calendarStatus = n
      ? `${n} calendrier(s), ${busy.length} créneau(x) chargé(s)` + (errors.length ? ` — erreurs : ${errors.join(' ; ')}` : '')
      : 'Aucun calendrier configuré';
  }

  // ---------------------------------------------------------------------------
  // Détection des activités dans la page
  // ---------------------------------------------------------------------------

  const MARK = 'data-rdvparis';
  let activities = [];

  const TICKET_RE = /billet|r[ée]serv|inscri|participer|ticket|acheter|payer|je viens|rejoindre|commander/i;

  function hasTicketButton(rootEl) {
    return Array.from(rootEl.querySelectorAll('button, a, input[type="submit"]')).some(b => {
      if (b.closest('header, nav, footer')) return false;
      const label = (b.innerText || b.value || '').trim();
      return label && label.length <= 40 && TICKET_RE.test(label);
    });
  }

  function sameSiteLinks(rootEl) {
    const here = location.href.split('#')[0];
    return Array.from(rootEl.querySelectorAll('a[href]')).filter(a => {
      if (a.closest('#rdvparis-host')) return false;
      if (a.closest('header, footer, nav')) return false;
      let u;
      try { u = new URL(a.href, location.href); } catch (e) { return false; }
      if (u.host !== location.host) return false;
      const clean = u.href.split('#')[0];
      return clean !== here && u.pathname.length > 1;
    });
  }

  // rendez-vous.social : /event/1889-soiree-oenologie et /event/1889-soiree-oenologie/buy
  const EVENT_PATH = /\/events?\/(\d+)(?:[-\/]|$)/;

  function eventIdOf(url) {
    const m = EVENT_PATH.exec(new URL(url, location.href).pathname);
    return m ? +m[1] : null;
  }

  function urlKey(url) {
    const u = new URL(url, location.href);
    const id = eventIdOf(u.href);
    return id != null ? u.origin + '/event/' + id : u.origin + u.pathname.replace(/\/$/, '');
  }

  function hrefKey(a) {
    return urlKey(a.href);
  }

  function eventUrl(a) {
    // Lien vers la page de l'activité (sans /buy)
    const u = new URL(a.href, location.href);
    return u.origin + u.pathname.replace(/\/buy\/?$/, '').replace(/\/$/, '');
  }

  // Texte visible d'un bloc, sans les badges ajoutés par l'outil.
  function visibleText(el) {
    let t = el.innerText || el.textContent || '';
    for (const own of el.querySelectorAll('.rdvp-badge, .rdvp-ticket-wrap')) {
      const o = own.innerText || own.textContent || '';
      if (o) t = t.replace(o, '');
    }
    return t;
  }

  // Date d'un bloc : <time datetime>, puis texte libre.
  function dateOf(el) {
    const opts = { defaultDurationMs: settings.defaultDurationMin * C.MINUTE };
    const times = el.querySelectorAll('time[datetime]');
    if (times.length) {
      const s = C.parseFrenchDate(times[0].getAttribute('datetime'), opts);
      if (s) {
        if (times[1]) {
          const e = C.parseFrenchDate(times[1].getAttribute('datetime'), opts);
          if (e && e.start > s.start) s.end = e.start;
        }
        if (s.hasTime) return s;
      }
    }
    return C.parseFrenchDate(visibleText(el), opts);
  }

  function titleOf(card, link) {
    const h = card.querySelector('h1, h2, h3, h4, h5, [class*="title" i], [class*="titre" i]');
    const txt = (h && h.innerText.trim()) || (link.innerText || '').trim() || (card.innerText || '').trim();
    return txt.split('\n').map(s => s.trim()).filter(Boolean)[0] || 'Activité';
  }

  function locationOf(card) {
    const el = card.querySelector('[class*="location" i], [class*="lieu" i], [class*="address" i], [class*="adresse" i], address');
    if (el) return el.innerText.trim().split('\n')[0];
    const m = /(paris\s*\d{1,2}(?:e|er|ème)?|\b750\d\d\b[^\n]*)/i.exec(visibleText(card));
    return m ? m[0].trim() : '';
  }

  function detectActivities() {
    const links = sameSiteLinks(document.body);
    const byKey = new Map();
    for (const a of links) {
      const k = hrefKey(a);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(a);
    }
    const found = [];
    const usedCards = new Set();
    for (const [key, anchors] of byKey) {
      const a = anchors[0];
      // On remonte tant que le bloc ne contient que ce lien-là (= la « carte »).
      let card = a;
      for (let i = 0; i < 8 && card.parentElement && card.parentElement !== document.body; i++) {
        const parent = card.parentElement;
        const keys = new Set(sameSiteLinks(parent).map(hrefKey));
        if (keys.size > 1) break;
        card = parent;
      }
      if (usedCards.has(card)) continue;
      const text = visibleText(card).trim();
      if (!text || text.length > 1500) continue;
      const eventId = eventIdOf(a.href);
      const api = eventId != null ? apiEvents.get(eventId) : null;
      const when = apiWhen(api) || dateOf(card);
      if (!when) continue;
      usedCards.add(card);
      found.push({
        id: key,
        eventId,
        url: eventUrl(a),
        card,
        title: titleOf(card, a),
        location: locationOf(card),
        start: when.start,
        end: when.end,
        hasTime: when.hasTime,
        gender: (api && api.gender) || C.extractGenderFromText(text),
        genderChecked: !!(api && api.gender),
      });
    }
    const self = currentPageActivity();
    if (self && !found.some(f => f.id === self.id)) found.unshift(self);
    // Données structurées schema.org (si la page en fournit)
    for (const ev of jsonLdEvents()) {
      if (found.some(f => f.id === ev.id)) continue;
      found.push(ev);
    }
    found.sort((x, y) => x.start - y.start);
    return found;
  }

  // Page de détail d'une activité : un titre <h1>, une date et un bouton de réservation.
  function currentPageActivity() {
    const main = document.querySelector('main') || document.body;
    const h1 = main.querySelector('h1');
    const isEventPage = eventIdOf(location.href) != null;
    if (!h1 || (!isEventPage && !hasTicketButton(main))) return null;
    // La date la plus proche du titre : on remonte depuis le <h1>.
    let box = h1.parentElement, when = null;
    for (let i = 0; i < 6 && box && !when; i++, box = box.parentElement) {
      if (visibleText(box).length > 3000) break;
      when = dateOf(box);
    }
    const eventId = eventIdOf(location.href);
    const api = eventId != null ? apiEvents.get(eventId) : null;
    when = apiWhen(api) || when;
    if (!when) return null;
    return {
      id: urlKey(location.href), eventId, url: eventUrl({ href: location.href }), card: null, isCurrentPage: true,
      title: h1.innerText.trim(), location: locationOf(main),
      start: when.start, end: when.end, hasTime: when.hasTime,
      gender: null, genderChecked: true,
    };
  }

  function jsonLdEvents() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (e) { continue; }
      const list = [].concat(data['@graph'] || data);
      for (const it of list) {
        if (!it || !/Event/.test([].concat(it['@type'] || '').join(' ')) || !it.startDate) continue;
        const start = Date.parse(it.startDate);
        if (isNaN(start)) continue;
        const end = it.endDate ? Date.parse(it.endDate) : start + settings.defaultDurationMin * C.MINUTE;
        const url = it.url ? new URL(it.url, location.href) : null;
        out.push({
          id: url ? url.origin + url.pathname.replace(/\/$/, '') : 'ld:' + it.name + start,
          url: url ? url.href : location.href,
          card: null,
          title: it.name || 'Activité',
          location: (it.location && (it.location.name || (it.location.address && (it.location.address.streetAddress || it.location.address)))) || '',
          start, end, hasTime: true,
          gender: C.extractGenderFromJson(it),
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Répartition H/F d'une page (courante ou récupérée)
  // ---------------------------------------------------------------------------

  const capturedJson = []; // réponses d'API interceptées (sites « SPA »)
  const apiEvents = new Map(); // id d'activité -> { title, start, end, gender }
  // hôte d'API -> en-têtes envoyés par le site. Seuls les en-têtes non sensibles
  // (clé d'application publique…) sont conservés d'une page à l'autre ; le jeton
  // de connexion éventuel reste en mémoire le temps de la page.
  const SENSITIVE_HEADER = /^(?:authorization|cookie|x-amz-security-token|x-csrf-token|x-xsrf-token)$/i;
  const apiHeaders = store.get('apiHeaders', {});
  let apiTemplate = store.get('apiTemplate', null); // ex. https://…amazonaws.com/prod/events/{id}

  function apiWhen(api) {
    if (!api || api.start == null) return null;
    return { start: api.start, end: api.end != null && api.end > api.start ? api.end : api.start + settings.defaultDurationMin * C.MINUTE, hasTime: true };
  }

  function onApiJson(json, url) {
    capturedJson.push(json);
    if (capturedJson.length > 30) capturedJson.shift();
    let evs = [];
    try { evs = C.extractEventsFromJson(json); } catch (e) { /* ignore */ }
    for (const ev of evs) {
      const prev = apiEvents.get(ev.id) || {};
      apiEvents.set(ev.id, {
        title: ev.title || prev.title, start: ev.start != null ? ev.start : prev.start,
        end: ev.end != null ? ev.end : prev.end, gender: ev.gender || prev.gender,
      });
    }
    // Apprend l'adresse de l'API « détail d'une activité » : …/<id> renvoyant tickets_male/female.
    if (url && evs.length === 1 && evs[0].gender) {
      try {
        const u = new URL(url, location.href);
        const re = new RegExp('/' + evs[0].id + '(?=/?$)');
        if (re.test(u.pathname)) {
          const tpl = u.origin + u.pathname.replace(re, '/{id}');
          if (tpl !== apiTemplate) { apiTemplate = tpl; store.set('apiTemplate', tpl); }
        }
      } catch (e) { /* ignore */ }
    }
    scheduleScan();
  }

  function rememberHeaders(url, headers) {
    try {
      const host = new URL(url, location.href).host;
      if (!headers) return;
      const h = {};
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) headers.forEach((v, k) => { h[k] = v; });
      else if (Array.isArray(headers)) headers.forEach(([k, v]) => { h[k] = v; });
      else Object.assign(h, headers);
      if (!Object.keys(h).length) return;
      const before = JSON.stringify(apiHeaders[host] || {});
      apiHeaders[host] = Object.assign(apiHeaders[host] || {}, h);
      if (JSON.stringify(apiHeaders[host]) === before) return;
      const persisted = {};
      for (const hh of Object.keys(apiHeaders)) {
        persisted[hh] = {};
        for (const k of Object.keys(apiHeaders[hh])) if (!SENSITIVE_HEADER.test(k)) persisted[hh][k] = apiHeaders[hh][k];
      }
      store.set('apiHeaders', persisted);
      // Nouveaux en-têtes : on retente les activités dont l'appel d'API avait échoué.
      let retry = false;
      for (const a of activities) if (a.apiFailed) { a.apiFailed = false; a.genderChecked = false; retry = true; }
      if (retry) scheduleScan();
    } catch (e) { /* ignore */ }
  }

  let pageFetch = null; // fetch d'origine de la page (non intercepté)

  // Interroge l'API du site pour une activité, avec les mêmes en-têtes que le site.
  async function fetchApiEvent(id) {
    if (!apiTemplate || !pageFetch) return null;
    const url = apiTemplate.replace('{id}', id);
    const headers = Object.assign({}, apiHeaders[new URL(url).host] || {});
    delete headers['content-type'];
    delete headers['Content-Type'];
    const r = await pageFetch.call(W, url, { headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    const evs = C.extractEventsFromJson(json);
    const ev = evs.find(e => e.id === id) || evs[0];
    if (ev) apiEvents.set(id, Object.assign(apiEvents.get(id) || {}, { title: ev.title, start: ev.start, end: ev.end, gender: ev.gender }));
    return (ev && ev.gender) || C.extractGenderFromJson(json);
  }

  function genderFromDocument(doc, bodyText) {
    // 1) données JSON embarquées
    for (const s of doc.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script#__NUXT_DATA__')) {
      try {
        const r = C.extractGenderFromJson(JSON.parse(s.textContent));
        if (r) return r;
      } catch (e) { /* JSON invalide */ }
    }
    // 2) texte visible
    const r = C.extractGenderFromText(bodyText);
    if (r) return r;
    return null;
  }

  function genderOfCurrentPage() {
    const id = eventIdOf(location.href);
    if (id != null && apiEvents.has(id) && apiEvents.get(id).gender) return apiEvents.get(id).gender;
    for (let i = capturedJson.length - 1; i >= 0; i--) {
      const r = C.extractGenderFromJson(capturedJson[i]);
      if (r) return Object.assign(r, { source: r.source + ' (API)' });
    }
    for (const k of ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__']) {
      if (W[k]) {
        try {
          const r = C.extractGenderFromJson(W[k]);
          if (r) return r;
        } catch (e) { /* ignore */ }
      }
    }
    const main = document.querySelector('main') || document.body;
    return genderFromDocument(document, visibleText(main));
  }

  const genderCache = {};
  const GENDER_TTL = 10 * C.MINUTE;

  async function fetchGender(url) {
    const hit = genderCache[url];
    if (hit && Date.now() - hit.at < GENDER_TTL) return hit.value;
    const html = await httpGet(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script:not([type]), style, noscript').forEach(n => n.remove());
    const main = doc.querySelector('main') || doc.body;
    const value = genderFromDocument(doc, main ? main.textContent : '');
    genderCache[url] = { at: Date.now(), value };
    return value;
  }

  async function prefetchGenders(list) {
    const queue = list.filter(a => !a.gender && a.url && a.url.startsWith(location.origin));
    const worker = async () => {
      while (queue.length) {
        const a = queue.shift();
        try {
          a.gender = null;
          if (a.eventId != null && apiTemplate) a.gender = await fetchApiEvent(a.eventId).catch(() => { a.apiFailed = true; return null; });
          if (!a.gender) a.gender = await fetchGender(a.url);
        } catch (e) { a.gender = null; }
        a.genderChecked = true;
        renderBadge(a);
        if (tab === 'planning' || tab === 'mine') renderPanel();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // Interception des réponses JSON (fetch / XHR) de la page elle-même.
  function hookNetwork() {
    try {
      const origFetch = W.fetch;
      pageFetch = origFetch;
      if (origFetch && !origFetch.__rdvparis) {
        const wrapped = function (input, init) {
          const url = typeof input === 'string' ? input : input && input.url;
          try { rememberHeaders(url, (init && init.headers) || (input && input.headers)); } catch (e) { /* ignore */ }
          const p = origFetch.apply(this, arguments);
          p.then(r => {
            const ct = r.headers && r.headers.get('content-type') || '';
            if (/json/.test(ct)) r.clone().json().then(j => onApiJson(j, url)).catch(() => {});
          }).catch(() => {});
          return p;
        };
        wrapped.__rdvparis = true;
        W.fetch = wrapped;
      }
      const XHR = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (XHR && !XHR.__rdvparis) {
        const origSend = XHR.send, origOpen = XHR.open, origSet = XHR.setRequestHeader;
        XHR.open = function (method, url) {
          this.__rdvUrl = String(url);
          return origOpen.apply(this, arguments);
        };
        XHR.setRequestHeader = function (k, v) {
          try { rememberHeaders(this.__rdvUrl, { [k]: v }); } catch (e) { /* ignore */ }
          return origSet.apply(this, arguments);
        };
        XHR.send = function () {
          this.addEventListener('load', function () {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              let body = null;
              if (this.responseType === 'json') body = this.response;
              else if ((this.responseType === '' || this.responseType === 'text') && (/json/.test(ct) || /^\s*[\[{]/.test(this.responseText))) body = JSON.parse(this.responseText);
              if (body && typeof body === 'object') onApiJson(body, this.responseURL || this.__rdvUrl);
            } catch (e) { /* ignore */ }
          });
          return origSend.apply(this, arguments);
        };
        XHR.__rdvparis = true;
      }
    } catch (e) { /* page qui refuse l'interception */ }
  }

  // ---------------------------------------------------------------------------
  // Affichage
  // ---------------------------------------------------------------------------

  const fmtDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
  const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const fmtRange = (s, e) => `${fmtTime.format(s)}–${fmtTime.format(e)}`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function statusOf(a) {
    if (!busy.length) return { status: 'unknown', conflicts: [], near: [] };
    return C.checkConflicts(a, busy, { bufferMs: settings.bufferMin * C.MINUTE, ignoreAllDay: settings.ignoreAllDay });
  }

  const STATUS_UI = {
    free: { icon: '✅', label: 'Libre', color: '#15803d', bg: '#dcfce7' },
    tight: { icon: '⚠️', label: 'Serré', color: '#a16207', bg: '#fef9c3' },
    conflict: { icon: '❌', label: 'Conflit', color: '#b91c1c', bg: '#fee2e2' },
    unknown: { icon: '📅', label: 'Agenda non chargé', color: '#475569', bg: '#e2e8f0' },
  };

  function genderHtml(g, compact) {
    if (!g) return '';
    if (g.total === 0 && g.men === 0 && g.women === 0) {
      const caps = g.menCapacity != null || g.womenCapacity != null ? ` (♂ 0/${g.menCapacity != null ? g.menCapacity : '?'} · ♀ 0/${g.womenCapacity != null ? g.womenCapacity : '?'})` : '';
      return `<span class="rdvp-g" title="Source : ${esc(g.source)}">Aucun billet vendu${caps}</span>`;
    }
    if (g.pctMen == null) {
      const parts = [];
      if (g.men != null) parts.push(`♂ ${g.men}`);
      if (g.women != null) parts.push(`♀ ${g.women}`);
      if (g.menRemaining != null && g.men == null) parts.push(`♂ ${g.menRemaining} pl. rest.`);
      if (g.womenRemaining != null && g.women == null) parts.push(`♀ ${g.womenRemaining} pl. rest.`);
      return parts.length ? `<span class="rdvp-g">${parts.join(' · ')}</span>` : '';
    }
    const cap = (n, c) => (c != null ? `${n}/${c}` : `${n != null ? n : '?'}`);
    const counts = g.men != null ? ` (${cap(g.men, g.menCapacity)} · ${cap(g.women, g.womenCapacity)})` : '';
    if (compact) return `<span class="rdvp-g" title="Source : ${esc(g.source)}">♂ ${g.pctMen}% · ♀ ${g.pctWomen}%${counts}</span>`;
    return `<div class="rdvp-bar" title="Source : ${esc(g.source)}">
        <div class="rdvp-bar-m" style="width:${g.pctMen}%">♂ ${g.pctMen}%</div>
        <div class="rdvp-bar-f" style="width:${g.pctWomen}%">♀ ${g.pctWomen}%</div>
      </div>
      <div class="rdvp-sub">Hommes ${cap(g.men, g.menCapacity)} · Femmes ${cap(g.women, g.womenCapacity)}${g.total != null ? ` · ${g.total} billet(s) vendu(s)` : ''}</div>
      ${g.menRemaining != null || g.womenRemaining != null ? `<div class="rdvp-sub">Places restantes : ♂ ${g.menRemaining != null ? g.menRemaining : '?'} · ♀ ${g.womenRemaining != null ? g.womenRemaining : '?'}</div>` : ''}`;
  }

  const BADGE_CSS = `
    .rdvp-badge{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;font:600 12px/1.3 system-ui,sans-serif}
    .rdvp-badge .rdvp-st{padding:3px 8px;border-radius:999px}
    .rdvp-badge .rdvp-g{padding:3px 8px;border-radius:999px;background:#ede9fe;color:#5b21b6}
    .rdvp-badge label{display:inline-flex;gap:4px;align-items:center;cursor:pointer;font-weight:500;color:#334155}
    .rdvp-hidden{opacity:.25;filter:grayscale(1)}
    .rdvp-ticket{display:inline-block;margin:4px 6px;padding:3px 8px;border-radius:999px;background:#ede9fe;color:#5b21b6;font:600 12px/1.3 system-ui,sans-serif;vertical-align:middle}
  `;

  function injectGlobalCss() {
    if (document.getElementById('rdvparis-css')) return;
    const st = document.createElement('style');
    st.id = 'rdvparis-css';
    st.textContent = BADGE_CSS;
    document.head.appendChild(st);
  }

  function renderBadge(a) {
    if (!a.card) return;
    let b = a.card.querySelector(':scope > .rdvp-badge, .rdvp-badge[' + MARK + '="' + CSS.escape(a.id) + '"]');
    if (!b) {
      b = document.createElement('div');
      b.className = 'rdvp-badge';
      b.setAttribute(MARK, a.id);
      // Les clics sur le badge ne doivent pas ouvrir le lien de la carte.
      b.addEventListener('click', e => e.stopPropagation(), true);
      a.card.appendChild(b);
    }
    const st = statusOf(a);
    const ui = STATUS_UI[st.status];
    const who = st.conflicts.concat(st.near).slice(0, 2).map(x => `${x.title} ${fmtRange(x.start, x.end)}`).join(', ');
    const g = a.gender ? genderHtml(a.gender, true) : (settings.prefetchGender && !a.genderChecked ? '<span class="rdvp-g">♂/♀ …</span>' : '');
    b.innerHTML = `<span class="rdvp-st" style="color:${ui.color};background:${ui.bg}" title="${esc(who)}">${ui.icon} ${ui.label}${who && st.status !== 'unknown' ? ' : ' + esc(who) : ''}</span>${g}
      <label><input type="checkbox" ${selection[a.id] ? 'checked' : ''}> Mon planning</label>`;
    b.querySelector('input').addEventListener('change', e => {
      e.stopPropagation();
      toggleSelection(a, e.target.checked);
    });
    a.card.classList.toggle('rdvp-hidden', settings.hideConflicts && st.status === 'conflict');
  }

  function toggleSelection(a, on) {
    if (on) selection[a.id] = { id: a.id, url: a.url, title: a.title, location: a.location, start: a.start, end: a.end };
    else delete selection[a.id];
    saveSelection();
    renderPanel();
    activities.forEach(renderBadge);
  }

  function gcalLink(a) {
    const d = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const p = new URLSearchParams({ action: 'TEMPLATE', text: a.title, dates: `${d(a.start)}/${d(a.end)}`, details: a.url || '', location: a.location || '' });
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }

  function downloadIcs(list) {
    const blob = new Blob([C.buildIcs(list)], { type: 'text/calendar;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = 'rdv-paris-planning.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }

  // ----- Encart H/F sur la page d'une activité / de réservation -----

  let pageGender = null;

  function renderTicketHints() {
    // Sur une liste d'activités, le texte global mélangerait plusieurs activités.
    const listing = activities.filter(a => !a.isCurrentPage && a.card).length > 1;
    pageGender = listing ? null : genderOfCurrentPage();
    const self = activities.find(a => a.isCurrentPage);
    if (self) self.gender = pageGender;
    const html = pageGender ? genderHtml(pageGender, true).replace('rdvp-g', 'rdvp-ticket') : '';
    for (const btn of document.querySelectorAll('button, a, input[type="submit"]')) {
      if (btn.closest('#rdvparis-host') || btn.closest('.rdvp-badge') || btn.closest('header, nav, footer')) continue;
      const label = (btn.innerText || btn.value || '').trim();
      if (!label || label.length > 40 || !TICKET_RE.test(label)) continue;
      let hint = btn.nextElementSibling;
      if (!hint || !hint.classList.contains('rdvp-ticket-wrap')) {
        if (!html) continue;
        hint = document.createElement('span');
        hint.className = 'rdvp-ticket-wrap';
        btn.insertAdjacentElement('afterend', hint);
      }
      hint.innerHTML = html;
    }
  }

  // ----- Panneau flottant (Shadow DOM) -----

  let host, shadow, panelOpen = store.get('panelOpen', false), tab = 'planning', onlyFree = false;

  const PANEL_CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .fab{position:fixed;right:16px;bottom:16px;z-index:2147483646;border:0;border-radius:999px;padding:10px 14px;background:#4f46e5;color:#fff;font:600 14px/1 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
    .panel{position:fixed;right:16px;bottom:64px;z-index:2147483647;width:min(420px,calc(100vw - 32px));max-height:min(75vh,680px);display:flex;flex-direction:column;background:#fff;color:#0f172a;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden;font-size:13px}
    header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#4f46e5;color:#fff}
    header b{font-size:14px}
    header button{background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer}
    nav{display:flex;border-bottom:1px solid #e2e8f0}
    nav button{flex:1;padding:8px;border:0;background:#fff;cursor:pointer;font-weight:600;color:#475569;border-bottom:2px solid transparent}
    nav button.on{color:#4f46e5;border-color:#4f46e5}
    .body{padding:10px 12px;overflow:auto}
    .gauge{margin-bottom:10px;padding:8px;border:1px solid #e2e8f0;border-radius:10px}
    .rdvp-bar{display:flex;height:22px;border-radius:6px;overflow:hidden;font:600 12px/22px system-ui;color:#fff}
    .rdvp-bar-m{background:#2563eb;padding-left:6px;white-space:nowrap;overflow:hidden}
    .rdvp-bar-f{background:#db2777;padding-right:6px;text-align:right;white-space:nowrap;overflow:hidden}
    .rdvp-sub{margin-top:4px;color:#475569;font-size:12px}
    .rdvp-g{padding:2px 6px;border-radius:999px;background:#ede9fe;color:#5b21b6;font-weight:600;font-size:11px;white-space:nowrap}
    .muted{color:#64748b}
    .row{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f5f9}
    .row .st{flex:none;width:20px;text-align:center}
    .row .main{flex:1;min-width:0}
    .row .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .row a{color:#4f46e5;text-decoration:none}
    .row .why{font-size:11px;color:#b91c1c}
    .row .why.tight{color:#a16207}
    .tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 4px}
    button.btn{border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:600;color:#0f172a}
    button.btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
    label.chk{display:inline-flex;gap:6px;align-items:center}
    input[type=text],input[type=url],input[type=number],textarea{width:100%;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px}
    textarea{height:140px;font-family:ui-monospace,monospace;font-size:11px}
    .field{margin:8px 0}
    .field > span{display:block;font-weight:600;margin-bottom:3px}
    .cal{display:flex;gap:6px;align-items:center;margin:4px 0}
    .cal code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;background:#f1f5f9;padding:3px 6px;border-radius:6px}
    h4{margin:12px 0 4px}
    small{color:#64748b}
  `;

  function ensurePanel() {
    if (host && document.body.contains(host)) return;
    host = document.createElement('div');
    host.id = 'rdvparis-host';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
  }

  function renderPanel() {
    ensurePanel();
    const selCount = Object.keys(selection).length;
    let body = '';
    if (tab === 'planning') body = planningTab();
    else if (tab === 'mine') body = mineTab();
    else if (tab === 'settings') body = settingsTab();
    else body = diagTab();

    shadow.innerHTML = `<style>${PANEL_CSS}</style>
      <button class="fab" id="fab">${panelOpen ? '✕' : '📅'} RDV.Paris${selCount ? ` (${selCount})` : ''}</button>
      ${panelOpen ? `<div class="panel">
        <header><b>RDV.Paris — planificateur</b><button id="close" title="Fermer">✕</button></header>
        <nav>
          <button data-tab="planning" class="${tab === 'planning' ? 'on' : ''}">Activités</button>
          <button data-tab="mine" class="${tab === 'mine' ? 'on' : ''}">Mon planning${selCount ? ` (${selCount})` : ''}</button>
          <button data-tab="settings" class="${tab === 'settings' ? 'on' : ''}">Agenda</button>
          <button data-tab="diag" class="${tab === 'diag' ? 'on' : ''}">Diagnostic</button>
        </nav>
        <div class="body">${body}</div>
      </div>` : ''}`;
    bindPanel();
  }

  function activityRow(a, withCheckbox) {
    const st = statusOf(a);
    const ui = STATUS_UI[st.status];
    const why = st.conflicts.length
      ? `<div class="why">Conflit : ${st.conflicts.slice(0, 3).map(x => esc(x.title) + ' ' + fmtRange(x.start, x.end)).join(', ')}</div>`
      : st.near.length ? `<div class="why tight">Moins de ${settings.bufferMin} min avec : ${st.near.slice(0, 2).map(x => esc(x.title) + ' ' + fmtRange(x.start, x.end)).join(', ')}</div>` : '';
    const g = a.gender ? genderHtml(a.gender, true) : '';
    return `<div class="row">
      <div class="st" title="${ui.label}">${ui.icon}</div>
      <div class="main">
        <div class="t"><a href="${esc(a.url)}" target="_self">${esc(a.title)}</a></div>
        <div class="muted">${fmtDay.format(a.start)} · ${a.hasTime === false ? 'horaire ?' : fmtRange(a.start, a.end)}${a.location ? ' · ' + esc(a.location) : ''}</div>
        ${why}${g ? `<div style="margin-top:3px">${g}</div>` : ''}
      </div>
      ${withCheckbox
        ? `<input type="checkbox" data-sel="${esc(a.id)}" ${selection[a.id] ? 'checked' : ''} title="Ajouter à mon planning">`
        : `<div style="display:flex;flex-direction:column;gap:4px"><a href="${esc(gcalLink(a))}" target="_blank" rel="noopener" title="Ajouter à Google Agenda">+ Google</a><a href="#" data-unsel="${esc(a.id)}">Retirer</a></div>`}
    </div>`;
  }

  function planningTab() {
    const g = pageGender;
    const gauge = g && g.pctMen != null
      ? `<div class="gauge"><b>Répartition hommes / femmes de cette activité</b>${genderHtml(g)}</div>`
      : g ? `<div class="gauge"><b>Sur cette page :</b> ${genderHtml(g, true)}</div>` : '';
    const list = activities.filter(a => !onlyFree || statusOf(a).status === 'free');
    const counts = { free: 0, tight: 0, conflict: 0 };
    activities.forEach(a => { const s = statusOf(a).status; if (s in counts) counts[s]++; });
    return `${gauge}
      <div class="muted">${esc(calendarStatus)}</div>
      ${busy.length ? `<div class="tools"><span>✅ ${counts.free}</span><span>⚠️ ${counts.tight}</span><span>❌ ${counts.conflict}</span></div>` : ''}
      <div class="tools">
        <label class="chk"><input type="checkbox" id="onlyFree" ${onlyFree ? 'checked' : ''}> Seulement libres</label>
        <label class="chk"><input type="checkbox" id="hideConf" ${settings.hideConflicts ? 'checked' : ''}> Griser les conflits dans la page</label>
      </div>
      ${list.length ? list.map(a => activityRow(a, true)).join('') : `<p class="muted">Aucune activité datée détectée sur cette page. Ouvrez la liste des activités (rendez-vous.social/paris) ou consultez l'onglet Diagnostic.</p>`}`;
  }

  function mineTab() {
    const list = Object.values(selection).sort((a, b) => a.start - b.start);
    const future = list.filter(a => a.end > Date.now());
    return `<p class="muted">Activités cochées, vérifiées contre votre agenda. Exportez-les vers votre calendrier.</p>
      <div class="tools">
        <button class="btn primary" id="exportIcs" ${future.length ? '' : 'disabled'}>Exporter (.ics)</button>
        <button class="btn" id="clearSel" ${list.length ? '' : 'disabled'}>Tout retirer</button>
      </div>
      ${future.length ? future.map(a => activityRow(a, false)).join('') : '<p class="muted">Rien pour le moment : cochez « Mon planning » sur les activités.</p>'}`;
  }

  function settingsTab() {
    return `<div class="muted">${esc(calendarStatus)}</div>
      <h4>Lien(s) iCal de votre agenda</h4>
      <small>Google Agenda : Paramètres → votre agenda → « Adresse secrète au format iCal ». Outlook : Calendrier → Partager → Publier → lien ICS. Apple iCloud : partage public → lien webcal:// (remplacez par https://).</small>
      ${settings.calendars.map((c, i) => `<div class="cal"><code title="${esc(c.url)}">${esc(c.name || c.url)}</code><button class="btn" data-rmcal="${i}">Retirer</button></div>`).join('')}
      <div class="field"><input type="url" id="calUrl" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"></div>
      <div class="tools"><button class="btn primary" id="addCal">Ajouter</button><button class="btn" id="reload">Recharger</button></div>
      <h4>…ou importer un fichier .ics</h4>
      <input type="file" id="icsFile" accept=".ics,text/calendar">
      ${settings.importedIcs ? `<div class="tools"><small>Fichier importé (${settings.importedIcs.length} caractères)</small><button class="btn" id="rmIcs">Supprimer</button></div>` : ''}
      <h4>Réglages</h4>
      <div class="field"><span>Marge avant/après (trajet), en minutes</span><input type="number" id="buffer" min="0" max="240" value="${settings.bufferMin}"></div>
      <div class="field"><span>Durée supposée si l'heure de fin n'est pas indiquée (minutes)</span><input type="number" id="dur" min="15" max="720" value="${settings.defaultDurationMin}"></div>
      <label class="chk"><input type="checkbox" id="ignoreAllDay" ${settings.ignoreAllDay ? 'checked' : ''}> Ignorer les évènements « toute la journée »</label><br>
      <label class="chk"><input type="checkbox" id="prefetch" ${settings.prefetchGender ? 'checked' : ''}> Récupérer la répartition H/F de chaque activité de la liste</label>
      <p><small>Vos liens et votre agenda restent dans votre navigateur (stockage de l'extension) ; rien n'est envoyé ailleurs qu'aux adresses que vous indiquez.</small></p>`;
  }

  function diagTab() {
    return `<p class="muted">Si les activités ou la répartition H/F ne sont pas détectées, copiez ce rapport et transmettez-le pour ajuster l'outil à la structure du site. Il ne contient pas votre agenda.</p>
      <div class="tools"><button class="btn primary" id="copyDiag">Copier le rapport</button></div>
      <textarea readonly id="diag">${esc(diagnostic())}</textarea>`;
  }

  function diagnostic() {
    const lines = [];
    lines.push('URL: ' + location.href);
    lines.push('Version: ' + (typeof GM_info !== 'undefined' ? GM_info.script.version : 'dev'));
    lines.push('Activités détectées: ' + activities.length);
    activities.slice(0, 5).forEach(a => lines.push(`  - ${a.title} | ${new Date(a.start).toISOString()} | ${a.url} | H/F: ${a.gender ? JSON.stringify({ m: a.gender.men, f: a.gender.women, pm: a.gender.pctMen, src: a.gender.source }) : '-'}`));
    lines.push('H/F page: ' + (pageGender ? JSON.stringify(pageGender) : 'non trouvé'));
    lines.push('JSON API captés: ' + capturedJson.length + ' | activités vues via l\'API: ' + apiEvents.size + ' | modèle d\'API: ' + (apiTemplate || 'pas encore appris (ouvrez une page /event/…/buy)'));
    lines.push('Hôtes d\'API (noms d\'en-têtes): ' + Object.keys(apiHeaders).map(h => h + ' [' + Object.keys(apiHeaders[h]).join(', ') + ']').join(' ; '));
    // Uniquement la structure (noms de champs), jamais les valeurs : pas de données de compte.
    capturedJson.slice(-5).forEach(j => lines.push('  JSON champs: ' + (Array.isArray(j) ? '[' + (j[0] && typeof j[0] === 'object' ? Object.keys(j[0]).join(',') : '') + ']' : Object.keys(j).join(',')).slice(0, 400)));
    const scripts = Array.from(document.querySelectorAll('script[type*="json"], script[id]')).map(s => `${s.id || ''}[${s.type}] ${s.textContent.length}c`);
    lines.push('Scripts de données: ' + (scripts.join(', ') || 'aucun'));
    lines.push('Globals: ' + ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APOLLO_STATE__'].filter(k => W[k]).join(', '));
    const text = (document.querySelector('main') || document.body).innerText;
    const snippets = [];
    const re = /[^\n]{0,60}(homme|femme|♂|♀|\bH\b|\bF\b|places?|inscrit|participant)[^\n]{0,60}/gi;
    let m;
    while ((m = re.exec(text)) && snippets.length < 15) snippets.push('  « ' + m[0].trim() + ' »');
    lines.push('Extraits pertinents:\n' + (snippets.join('\n') || '  aucun'));
    const links = sameSiteLinks(document.body).slice(0, 12).map(a => '  ' + a.getAttribute('href') + ' | ' + (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80));
    lines.push('Liens internes (12 premiers):\n' + links.join('\n'));
    const sample = activities[0] && activities[0].card ? activities[0].card : document.querySelector('main a[href]') && document.querySelector('main a[href]').parentElement;
    if (sample) lines.push('HTML d\'une carte (tronqué):\n' + sample.outerHTML.replace(/\s+/g, ' ').slice(0, 1500));
    return lines.join('\n');
  }

  function bindPanel() {
    const $ = s => shadow.querySelector(s);
    $('#fab').onclick = () => { panelOpen = !panelOpen; store.set('panelOpen', panelOpen); renderPanel(); };
    if (!panelOpen) return;
    $('#close').onclick = () => { panelOpen = false; store.set('panelOpen', false); renderPanel(); };
    shadow.querySelectorAll('nav button').forEach(b => { b.onclick = () => { tab = b.dataset.tab; renderPanel(); }; });
    shadow.querySelectorAll('[data-sel]').forEach(cb => {
      cb.onchange = () => { const a = activities.find(x => x.id === cb.dataset.sel); if (a) toggleSelection(a, cb.checked); };
    });
    shadow.querySelectorAll('[data-unsel]').forEach(l => {
      l.onclick = e => { e.preventDefault(); delete selection[l.dataset.unsel]; saveSelection(); renderPanel(); activities.forEach(renderBadge); };
    });
    const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
    on('#onlyFree', 'onchange', e => { onlyFree = e.target.checked; renderPanel(); });
    on('#hideConf', 'onchange', e => { settings.hideConflicts = e.target.checked; saveSettings(); activities.forEach(renderBadge); });
    on('#exportIcs', 'onclick', () => downloadIcs(Object.values(selection).filter(a => a.end > Date.now())));
    on('#clearSel', 'onclick', () => { if (confirm('Retirer toutes les activités de votre planning ?')) { selection = {}; saveSelection(); renderPanel(); activities.forEach(renderBadge); } });
    on('#addCal', 'onclick', async () => {
      let url = $('#calUrl').value.trim();
      if (!url) return;
      url = url.replace(/^webcal:\/\//i, 'https://');
      if (!/^https?:\/\//i.test(url)) { alert('Adresse invalide'); return; }
      let name;
      try { name = new URL(url).host; } catch (e) { alert('Adresse invalide'); return; }
      settings.calendars.push({ name, url });
      saveSettings();
      await refreshCalendars(true);
    });
    on('#reload', 'onclick', () => refreshCalendars(true));
    shadow.querySelectorAll('[data-rmcal]').forEach(b => {
      b.onclick = async () => { settings.calendars.splice(+b.dataset.rmcal, 1); saveSettings(); await refreshCalendars(false); };
    });
    on('#icsFile', 'onchange', e => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => { settings.importedIcs = String(r.result); saveSettings(); await refreshCalendars(false); };
      r.readAsText(f);
    });
    on('#rmIcs', 'onclick', async () => { settings.importedIcs = ''; saveSettings(); await refreshCalendars(false); });
    on('#buffer', 'onchange', e => { settings.bufferMin = Math.max(0, +e.target.value || 0); saveSettings(); refreshAll(); });
    on('#dur', 'onchange', e => { settings.defaultDurationMin = Math.max(15, +e.target.value || 120); saveSettings(); scan(); });
    on('#ignoreAllDay', 'onchange', e => { settings.ignoreAllDay = e.target.checked; saveSettings(); refreshAll(); });
    on('#prefetch', 'onchange', e => { settings.prefetchGender = e.target.checked; saveSettings(); scan(); });
    on('#copyDiag', 'onclick', async () => {
      const t = $('#diag');
      try { await navigator.clipboard.writeText(t.value); } catch (err) { t.select(); document.execCommand('copy'); }
      $('#copyDiag').textContent = 'Copié ✔';
    });
  }

  async function refreshCalendars(force) {
    calendarStatus = 'Chargement de l\'agenda…';
    renderPanel();
    await loadCalendars(force);
    refreshAll();
  }

  function refreshAll() {
    activities.forEach(renderBadge);
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Boucle principale
  // ---------------------------------------------------------------------------

  let scanTimer = null, scanning = false;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }

  function scan() {
    if (scanning) return;
    scanning = true;
    try {
      injectGlobalCss();
      const prev = new Map(activities.map(a => [a.id, a]));
      activities = detectActivities();
      for (const a of activities) {
        const p = prev.get(a.id);
        if (p && !a.gender && p.gender) a.gender = p.gender;
        if (p && p.genderChecked) a.genderChecked = true;
        if (p && p.apiFailed) a.apiFailed = true;
        // Tenir à jour les activités déjà choisies (horaires modifiés…)
        if (selection[a.id]) Object.assign(selection[a.id], { title: a.title, start: a.start, end: a.end, location: a.location });
        renderBadge(a);
      }
      saveSelection();
      renderTicketHints();
      renderPanel();
      if (settings.prefetchGender) prefetchGenders(activities.filter(a => !a.genderChecked));
    } finally {
      // Nos propres modifications du DOM déclenchent l'observer : on les ignore.
      setTimeout(() => { scanning = false; }, 50);
    }
  }

  function start() {
    const obs = new MutationObserver(muts => {
      if (scanning) return;
      const relevant = muts.some(m => !(m.target.closest && (m.target.closest('#rdvparis-host') || m.target.closest('.rdvp-badge') || m.target.closest('.rdvp-ticket-wrap'))));
      if (relevant) scheduleScan();
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    let lastUrl = location.href;
    setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; capturedJson.length = 0; scheduleScan(); } }, 800);
    scan();
    loadCalendars(false).then(refreshAll);
  }

  // Au plus tôt (@run-at document-start) pour voir les premières requêtes de la page.
  hookNetwork();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
