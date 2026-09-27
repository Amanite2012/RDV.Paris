#!/usr/bin/env node
/*
 * RDV.Paris — site web : chaque personne se connecte (Google ou lien par e-mail), branche ses
 * agendas (Google Agenda, liens iCal), choisit ses activités rendez-vous.social et reçoit des
 * alertes par e-mail.
 *
 *   npm start            (configuration : variables d'environnement, voir web/.env.example)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const C = require('../src/core.js');
const { loadConfig } = require('./config.js');
const { createSecure, token, sha256 } = require('./secure.js');
const { createStore } = require('./store.js');
const net = require('node:net');
const { createCalendars, normalizeIcalUrl, isPrivateAddress, hostOf } = require('./calendars.js');
const { createPlanner, hasCalendars } = require('./planner.js');
const { createMailer } = require('./mailer.js');
const { createNotifier } = require('./notify.js');
const G = require('./google.js');

const SESSION_DAYS = 30;
const LOGIN_TOKEN_MIN = 20;
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function createApp(cfg = loadConfig(), { log = console } = {}) {
  const secure = createSecure(cfg.secret);
  const store = createStore(cfg.dataDir);
  const calendars = createCalendars({ cfg, secure, store });
  const planner = createPlanner({ cfg, calendars, log });
  const mailer = createMailer(cfg, log);
  const notifier = createNotifier({ cfg, store, secure, planner, mailer, log });
  const oauthFlows = new Map(); // state -> { verifier, calendar, userId, expires }
  const hits = new Map(); // limitation de débit : clé -> [instants]
  const files = {};
  for (const [route, [file]] of Object.entries(STATIC)) files[route] = fs.readFileSync(path.join(PUBLIC, file));

  // -------------------------------------------------------------------------
  // Outils HTTP
  // -------------------------------------------------------------------------

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    }, headers));
    res.end(data);
  }
  const redirect = (res, to, headers = {}) => { res.writeHead(302, Object.assign({ Location: to, 'Cache-Control': 'no-store' }, headers)); res.end(); };

  function page(res, status, title, bodyHtml) {
    send(res, status, `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · RDV.Paris</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/style.css"></head>
<body><main class="standalone"><div class="card narrow"><p class="brand">RDV<span>.Paris</span></p>${bodyHtml}</div></main></body></html>`, 'text/html; charset=utf-8');
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function cookie(name, value, maxAgeSec) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secureCookies ? '; Secure' : ''}`;
  }

  async function body(req, limit = 64 * 1024) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Requête trop volumineuse'); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    if (/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw); } catch (e) { throw new HttpError(400, 'JSON invalide'); }
  }

  function clientIp(req) {
    if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  }
  function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) throw new HttpError(429, 'Trop de tentatives, réessayez plus tard.');
    list.push(now); hits.set(key, list);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  function currentUser(req) {
    const sid = cookies(req).rdv_sid;
    if (!sid) return null;
    const s = store.data.sessions[sha256(sid)];
    if (!s || s.expires < Date.now()) return null;
    return store.user(s.userId);
  }
  function startSession(res, user, headers = {}) {
    const sid = token();
    store.data.sessions[sha256(sid)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * C.DAY };
    store.save();
    return Object.assign({ 'Set-Cookie': cookie('rdv_sid', sid, SESSION_DAYS * 86400) }, headers);
  }
  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Connexion requise');
    return u;
  }

  // -------------------------------------------------------------------------
  // Présentation des données
  // -------------------------------------------------------------------------

  function publicUser(u) {
    return {
      email: u.email, name: u.name, settings: u.settings,
      calendars: u.calendars.map(c => ({ id: c.id, label: c.label, host: c.host, addedAt: c.addedAt })),
      google: u.google ? { connected: !!u.google.refresh, calendars: u.google.calendars, error: u.google.error || null } : { connected: false, calendars: [], error: null },
      hasCalendars: hasCalendars(u),
      selections: Object.keys(u.selections).length,
      feedUrl: `${cfg.baseUrl}/feed/${u.feedToken}.ics`,
    };
  }
  const features = () => ({ google: !!cfg.google, email: !!cfg.mail, dev: cfg.devLogin });

  function publicActivity(a, u) {
    const brief = x => ({ title: x.title, start: x.start, end: x.end });
    return {
      id: a.id, title: a.title.trim(), url: a.url, buyUrl: a.url + '/buy', location: a.location,
      start: a.start, end: a.end, endKnown: a.endKnown, sale: a.sale, status: a.status,
      conflicts: a.conflicts.map(brief), near: a.near.map(brief), gender: a.gender, selected: !!u.selections[a.id],
    };
  }

  async function planningIcs(u) {
    const { acts } = await planner.forUser(u);
    const byId = new Map(acts.map(a => [a.id, a]));
    const items = Object.entries(u.selections).map(([id, sel]) => byId.get(+id) || sel)
      .filter(a => a.end > Date.now() - 30 * C.DAY)
      .map(a => ({
        id: `rdv-${a.id}`, title: a.title.trim(), start: a.start, end: a.end, location: a.location, url: a.url,
        description: `Réserver : ${a.url}/buy`,
      }));
    return C.buildIcs(items);
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, cfg.baseUrl);
    const p = url.pathname, m = req.method;

    if (m === 'GET' && STATIC[p]) {
      return send(res, 200, files[p], STATIC[p][1], { 'Cache-Control': p === '/' ? 'no-store' : 'public, max-age=300' });
    }
    if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/confidentialite') {
      return page(res, 200, 'Confidentialité', `<h1>Confidentialité</h1>
<div class="stack small" style="margin-top:12px">
<p>RDV.Paris est un outil indépendant, non affilié à rendez-vous.social. Il compare les activités publiques du site à vos agendas.</p>
<p><b>Ce qui est conservé</b> : votre adresse e-mail et votre nom (connexion), vos réglages, les activités que vous choisissez, les liens de vos agendas iCal et l'accès à Google Agenda. Les liens d'agenda et l'accès Google sont chiffrés.</p>
<p><b>Google Agenda</b> : accès en lecture seule, utilisé uniquement pour détecter les conflits avec les activités. Les évènements ne sont pas enregistrés : ils sont relus au besoin et gardés au plus 10 minutes en mémoire. Rien n'est modifié dans votre agenda ni transmis à des tiers. L'usage des données reçues des API Google respecte la <a href="https://developers.google.com/terms/api-services-user-data-policy">politique relative aux données utilisateur des services d'API Google</a>, y compris les exigences d'usage limité.</p>
<p><b>E-mails</b> : uniquement les liens de connexion et les notifications que vous activez, avec un lien de désinscription dans chaque message.</p>
<p><b>Suppression</b> : « Réglages → Supprimer mon compte » efface toutes vos données et révoque l'accès Google.</p>
</div><p style="margin-top:16px"><a href="/">Retour</a></p>`);
    }

    // Toute requête qui modifie quelque chose doit venir de l'application (en-tête personnalisé :
    // un autre site ne peut pas l'envoyer sans autorisation CORS, que nous ne donnons jamais).
    const mutating = !['GET', 'HEAD'].includes(m);
    const formPost = m === 'POST' && ['/auth/email/verify', '/unsubscribe'].includes(p);
    if (mutating && !formPost && req.headers['x-rdv'] !== '1') throw new HttpError(403, 'Requête refusée');

    // --- connexion -----------------------------------------------------------
    if (m === 'GET' && p === '/api/me') {
      const u = currentUser(req);
      return send(res, 200, { user: u && publicUser(u), features: features() });
    }
    if (m === 'POST' && p === '/auth/logout') {
      const sid = cookies(req).rdv_sid;
      if (sid) { delete store.data.sessions[sha256(sid)]; store.save(); }
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('rdv_sid', '', 0) });
    }
    if (m === 'POST' && p === '/auth/dev') {
      if (!cfg.devLogin) throw new HttpError(404, 'Introuvable');
      const email = store.normEmail((await body(req)).email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Adresse e-mail invalide');
      const u = store.byEmail(email) || store.newUser({ email });
      return send(res, 200, { ok: true }, undefined, startSession(res, u));
    }
    if (m === 'POST' && p === '/auth/email') {
      if (!mailer) throw new HttpError(404, 'Connexion par e-mail indisponible');
      const email = store.normEmail((await body(req)).email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Adresse e-mail invalide');
      rateLimit('ip:' + clientIp(req), 10, 15 * C.MINUTE);
      rateLimit('mail:' + email, 3, 15 * C.MINUTE);
      const t = token();
      store.data.loginTokens[sha256(t)] = { email, expires: Date.now() + LOGIN_TOKEN_MIN * C.MINUTE };
      store.save();
      const link = `${cfg.baseUrl}/auth/email/verify?token=${t}`;
      await mailer.send({
        to: email, subject: 'Votre lien de connexion RDV.Paris',
        text: `Pour vous connecter à RDV.Paris, ouvrez ce lien (valable ${LOGIN_TOKEN_MIN} minutes) :\n\n${link}\n\nSi vous n'avez rien demandé, ignorez cet e-mail.`,
        html: `<p>Pour vous connecter à RDV.Paris, cliquez sur ce lien (valable ${LOGIN_TOKEN_MIN} minutes) :</p><p><a href="${esc(link)}">Se connecter</a></p><p style="color:#888">Si vous n'avez rien demandé, ignorez cet e-mail.</p>`,
      });
      return send(res, 200, { ok: true });
    }
    if (p === '/auth/email/verify') {
      const t = String(m === 'POST' ? (await body(req)).token : url.searchParams.get('token') || '');
      const entry = store.data.loginTokens[sha256(t)];
      if (!entry || entry.expires < Date.now()) {
        return page(res, 400, 'Lien expiré', '<h1>Lien expiré ou déjà utilisé</h1><p><a href="/">Demander un nouveau lien</a></p>');
      }
      // GET : simple page avec un bouton (les antivirus de messagerie ouvrent les liens tout seuls).
      if (m === 'GET') {
        return page(res, 200, 'Connexion', `<h1>Connexion</h1><p>Se connecter en tant que <b>${esc(entry.email)}</b> ?</p>
<form method="post" action="/auth/email/verify"><input type="hidden" name="token" value="${esc(t)}"><button class="btn primary" type="submit">Se connecter</button></form>`);
      }
      delete store.data.loginTokens[sha256(t)];
      const u = store.byEmail(entry.email) || store.newUser({ email: entry.email });
      return redirect(res, '/', startSession(res, u));
    }
    if (m === 'GET' && p === '/auth/google') {
      if (!cfg.google) throw new HttpError(404, 'Connexion Google indisponible');
      const calendar = url.searchParams.get('calendar') === '1';
      const u = currentUser(req);
      if (calendar && !u) return redirect(res, '/');
      const state = token(16), { verifier, challenge } = G.pkce();
      for (const [k, f] of oauthFlows) if (f.expires < Date.now()) oauthFlows.delete(k);
      oauthFlows.set(state, { verifier, calendar, userId: u && u.id, expires: Date.now() + 10 * C.MINUTE });
      return redirect(res, G.authUrl(cfg, { state, challenge, calendar, loginHint: u && u.email }));
    }
    if (m === 'GET' && p === '/auth/google/callback') {
      const flow = oauthFlows.get(url.searchParams.get('state') || '');
      oauthFlows.delete(url.searchParams.get('state') || '');
      if (!cfg.google || !flow || flow.expires < Date.now()) return redirect(res, '/?erreur=google');
      if (url.searchParams.get('error') || !url.searchParams.get('code')) return redirect(res, flow.calendar ? '/#agendas' : '/?erreur=google-annule');
      let g;
      try { g = await G.exchangeCode(cfg, url.searchParams.get('code'), flow.verifier); } catch (e) {
        log.error('Google : ' + e.message);
        return redirect(res, '/?erreur=google');
      }
      const email = store.normEmail(g.claims.email);
      if (flow.calendar) {
        const u = currentUser(req);
        if (!u || u.id !== flow.userId) return redirect(res, '/?erreur=google');
        if (!g.scope.includes(G.SCOPE_CALENDAR)) return redirect(res, '/?erreur=google-agenda-refuse#agendas');
        const prev = u.google && u.google.refresh ? secure.decrypt(u.google.refresh) : null;
        const refresh = g.refreshToken || prev;
        if (!refresh) return redirect(res, '/?erreur=google-hors-ligne#agendas');
        let list = [];
        try { list = await G.listCalendars(g.accessToken); } catch (e) { log.error(e.message); }
        const was = new Map(((u.google && u.google.calendars) || []).map(c => [c.id, c.selected]));
        u.google = {
          refresh: secure.encrypt(refresh), account: email, error: null,
          calendars: list.map(c => Object.assign(c, { selected: was.has(c.id) ? was.get(c.id) : c.primary })),
        };
        if (!u.googleSub) u.googleSub = g.claims.sub;
        calendars.forget(u.id);
        store.save();
        return redirect(res, '/#agendas');
      }
      let u = store.byGoogleSub(g.claims.sub) || store.byEmail(email);
      if (!u) u = store.newUser({ email, name: g.claims.name || null, googleSub: g.claims.sub });
      else { u.googleSub = g.claims.sub; if (!u.name && g.claims.name) u.name = g.claims.name; store.save(); }
      return redirect(res, '/', startSession(res, u));
    }

    // --- désinscription (lien dans chaque e-mail) -----------------------------
    if (p === '/unsubscribe') {
      const id = url.searchParams.get('u') || '', sig = url.searchParams.get('t') || '';
      const u = store.user(id);
      if (!u || !secure.verify('unsub:' + id, sig)) return page(res, 400, 'Lien invalide', '<h1>Lien invalide</h1>');
      if (m === 'POST') {
        u.settings.notify = { alerts: false, reminder: false, digest: false };
        store.save();
        return page(res, 200, 'Désinscription', '<h1>C\'est fait</h1><p>Vous ne recevrez plus d\'e-mails de RDV.Paris. Vous pouvez les réactiver dans les réglages.</p><p><a href="/">Retour au site</a></p>');
      }
      return page(res, 200, 'Désinscription', `<h1>Ne plus recevoir d'e-mails ?</h1><p>Les alertes et rappels pour <b>${esc(u.email)}</b> seront désactivés.</p>
<form method="post" action="/unsubscribe?u=${encodeURIComponent(id)}&amp;t=${encodeURIComponent(sig)}"><button class="btn primary" type="submit">Me désinscrire</button></form>`);
    }

    // --- flux iCal public (lien secret) ---------------------------------------
    const feed = /^\/feed\/([A-Za-z0-9_-]{16,})\.ics$/.exec(p);
    if (m === 'GET' && feed) {
      const u = store.byFeedToken(feed[1]);
      if (!u) throw new HttpError(404, 'Introuvable');
      return send(res, 200, await planningIcs(u), 'text/calendar; charset=utf-8');
    }

    // --- API (connecté) -------------------------------------------------------
    if (!p.startsWith('/api/') && p !== '/planning.ics') throw new HttpError(404, 'Introuvable');
    const u = requireUser(req);

    if (m === 'GET' && p === '/planning.ics') {
      return send(res, 200, await planningIcs(u), 'text/calendar; charset=utf-8', { 'Content-Disposition': 'attachment; filename="rdv-paris-planning.ics"' });
    }
    if (m === 'GET' && p === '/api/activities') {
      const { acts, agenda } = await planner.forUser(u, { fresh: url.searchParams.get('refresh') === '1' });
      const byId = new Set(acts.map(a => a.id));
      const gone = Object.entries(u.selections).filter(([id, s]) => !byId.has(+id) && s.end > Date.now())
        .map(([id, s]) => ({ id: +id, title: s.title, start: s.start, end: s.end, url: s.url }));
      return send(res, 200, { activities: acts.map(a => publicActivity(a, u)), gone, agenda, updatedAt: Date.now() });
    }
    const sel = /^\/api\/selections\/(\d+)$/.exec(p);
    if (m === 'PUT' && sel) {
      const id = +sel[1];
      const b = await body(req);
      if (b.selected) {
        const { acts } = await planner.forUser(u);
        const a = acts.find(x => x.id === id);
        if (!a) throw new HttpError(404, 'Activité introuvable');
        u.selections[id] = { title: a.title.trim(), start: a.start, end: a.end, url: a.url, location: a.location, addedAt: Date.now() };
      } else delete u.selections[id];
      store.save();
      return send(res, 200, { ok: true, selections: Object.keys(u.selections).length });
    }
    if (m === 'POST' && p === '/api/calendars/ical') {
      const b = await body(req);
      const norm = normalizeIcalUrl(b.url);
      if (!norm) throw new HttpError(400, 'Lien invalide : il doit commencer par https:// ou webcal://');
      const host = new URL(norm).hostname.replace(/^\[|\]$/g, '');
      if (!cfg.allowPrivateIcal && (isPrivateAddress(host) && net.isIP(host) || /^localhost$|\.local$|\.internal$/i.test(host))) {
        throw new HttpError(400, 'Adresse interne refusée : utilisez le lien public de votre agenda');
      }
      if (u.calendars.length >= 10) throw new HttpError(400, '10 agendas maximum');
      const label = String(b.label || '').trim().slice(0, 60) || hostOf(norm);
      u.calendars.push({ id: token(8), label, host: hostOf(norm), url: secure.encrypt(norm), addedAt: Date.now() });
      calendars.invalidate(u.id);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    const delCal = /^\/api\/calendars\/ical\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m === 'DELETE' && delCal) {
      u.calendars = u.calendars.filter(c => c.id !== delCal[1]);
      calendars.invalidate(u.id);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    if (m === 'PUT' && p === '/api/calendars/google') {
      if (!u.google) throw new HttpError(400, 'Google Agenda non connecté');
      const ids = new Set((await body(req)).selected || []);
      for (const c of u.google.calendars) c.selected = ids.has(c.id);
      calendars.invalidate(u.id);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    if (m === 'DELETE' && p === '/api/calendars/google') {
      if (u.google && u.google.refresh) await G.revoke(secure.decrypt(u.google.refresh));
      u.google = null;
      calendars.forget(u.id);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    if (m === 'PUT' && p === '/api/settings') {
      const b = await body(req), s = u.settings;
      const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
      if ('gender' in b) s.gender = ['male', 'female'].includes(b.gender) ? b.gender : null;
      if ('bufferMin' in b) s.bufferMin = clamp(b.bufferMin, 0, 240, s.bufferMin);
      if ('defaultDurationMin' in b) s.defaultDurationMin = clamp(b.defaultDurationMin, 30, 600, s.defaultDurationMin);
      if ('lowPlaces' in b) s.lowPlaces = clamp(b.lowPlaces, 1, 20, s.lowPlaces);
      if ('ignoreAllDay' in b) s.ignoreAllDay = !!b.ignoreAllDay;
      if (b.notify && typeof b.notify === 'object') {
        const before = s.notify.digest;
        for (const k of ['alerts', 'reminder', 'digest']) if (k in b.notify) s.notify[k] = !!b.notify[k];
        // En activant le résumé, on part de la liste actuelle : pas d'avalanche d'anciennes activités.
        if (s.notify.digest && !before) u.notifyState.initialized = false;
      }
      calendars.invalidate(u.id);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    if (m === 'POST' && p === '/api/notifications/test') {
      if (!mailer) throw new HttpError(400, "L'envoi d'e-mails n'est pas configuré sur ce serveur");
      rateLimit('test:' + u.id, 3, 60 * C.MINUTE);
      await mailer.send({
        to: u.email, subject: 'RDV.Paris : e-mail de test',
        text: `Les notifications fonctionnent. Vous les recevrez à cette adresse.\n\n${cfg.baseUrl}\n\nNe plus recevoir ces e-mails : ${notifier.unsubscribeUrl(u)}`,
      });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/feed/reset') {
      u.feedToken = token(18);
      store.save();
      return send(res, 200, { user: publicUser(u) });
    }
    if (m === 'DELETE' && p === '/api/account') {
      if (u.google && u.google.refresh) await G.revoke(secure.decrypt(u.google.refresh));
      calendars.forget(u.id);
      store.deleteUser(u.id);
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('rdv_sid', '', 0) });
    }
    throw new HttpError(404, 'Introuvable');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(e => {
      const status = e.status || 500;
      if (status >= 500) log.error(`${req.method} ${req.url.split('?')[0]} : ${e.stack || e.message}`);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Erreur du serveur' : e.message });
      else res.end();
    });
  });

  const cleanup = setInterval(() => store.cleanup(), 60 * C.MINUTE);
  cleanup.unref();

  return {
    cfg, server, store, mailer, notifier, planner,
    close() { notifier.stop(); clearInterval(cleanup); store.flush(); return new Promise(r => server.close(r)); },
  };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (require.main === module) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  app.server.listen(cfg.port, cfg.host, () => {
    console.log(`RDV.Paris sur ${cfg.baseUrl} (écoute ${cfg.host}:${cfg.port})`);
    console.log(`  Google : ${cfg.google ? 'activé' : 'non configuré'} · e-mails : ${cfg.mail ? cfg.mail.transport : 'non configurés'}${cfg.devLogin ? ' · connexion de développement ACTIVÉE' : ''}`);
  });
  app.notifier.start();
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createApp };
