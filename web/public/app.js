/* RDV.Paris — interface (sans framework). */
'use strict';
(() => {
  const TZ = 'Europe/Paris';
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const fmtDay = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtKey = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const DAY = 86400000;
  const VIEWS = { activites: 'Activités', planning: 'Mon planning', agendas: 'Agendas', reglages: 'Réglages' };
  const ERRORS = {
    google: 'La connexion avec Google a échoué. Réessayez.',
    'google-annule': 'Connexion Google annulée.',
    'google-agenda-refuse': "Google Agenda n'a pas été autorisé : cochez l'accès à l'agenda sur l'écran Google.",
    'google-hors-ligne': "Google n'a pas donné d'accès durable à l'agenda. Réessayez « Connecter Google Agenda ».",
  };

  const state = { me: null, features: {}, data: null, loading: false, error: null, filters: loadFilters(), loginSent: null };

  // ---------------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------------

  function loadFilters() {
    const d = { days: 14, free: false, mine: false, q: '' };
    try { return Object.assign(d, JSON.parse(localStorage.getItem('rdv.filters') || '{}'), { q: '' }); } catch (e) { return d; }
  }
  function saveFilters() {
    try { const { days, free, mine } = state.filters; localStorage.setItem('rdv.filters', JSON.stringify({ days, free, mine })); } catch (e) { /* facultatif */ }
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hm = t => fmtTime.format(t);
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: Object.assign({ 'x-rdv': '1' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.me = null; render(); }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
  }

  const view = () => { const v = location.hash.slice(1); return VIEWS[v] ? v : 'activites'; };

  // ---------------------------------------------------------------------------
  // Données
  // ---------------------------------------------------------------------------

  async function loadMe() {
    const r = await api('GET', '/api/me');
    state.me = r.user; state.features = r.features;
  }

  async function loadActivities(refresh) {
    state.loading = true; state.error = null; render();
    try { state.data = await api('GET', '/api/activities' + (refresh ? '?refresh=1' : '')); } catch (e) { state.error = e.message; }
    state.loading = false; render();
  }

  function setUser(u) { state.me = u; }

  // ---------------------------------------------------------------------------
  // Connexion
  // ---------------------------------------------------------------------------

  const GOOGLE_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  function renderLogin() {
    const f = state.features;
    const err = new URLSearchParams(location.search).get('erreur');
    const methods = [];
    if (f.google) methods.push(`<a class="btn google" href="/auth/google">${GOOGLE_ICON} Continuer avec Google</a>`);
    if (f.email) {
      if (f.google) methods.push('<div class="divider">ou</div>');
      methods.push(state.loginSent
        ? `<div class="notice"><p>Lien envoyé à <b>${esc(state.loginSent)}</b>. Ouvrez l'e-mail pour vous connecter (valable 20 minutes).</p></div>`
        : `<form class="stack" data-form="email-login">
             <label class="field">Adresse e-mail<input type="email" name="email" required autocomplete="email" placeholder="vous@exemple.fr"></label>
             <button class="btn primary" type="submit">Recevoir un lien de connexion</button>
           </form>`);
    }
    if (f.dev) {
      methods.push(`<div class="divider">développement</div>
        <form class="stack" data-form="dev-login">
          <label class="field">E-mail de test <span>Sans vérification : réservé aux essais en local.</span><input type="email" name="email" required value="test@example.com"></label>
          <button class="btn" type="submit">Entrer (mode développement)</button>
        </form>`);
    }
    if (!methods.length) methods.push('<p class="notice warn">Aucune méthode de connexion n\'est configurée sur ce serveur (Google ou e-mail).</p>');

    $app.innerHTML = `<div class="hero">
      <section>
        <p class="brand">RDV<span>.Paris</span></p>
        <h1>Vos sorties rendez-vous.social, calées sur votre agenda.</h1>
        <p class="muted">Branchez vos agendas, voyez en un coup d'œil ce qui est libre et la répartition hommes/femmes, et choisissez vos activités.</p>
        <ul>
          <li><i>📅</i><div><b>Libre, serré ou en conflit</b><br><span class="muted small">Google Agenda, Outlook, Apple… comparés à chaque activité.</span></div></li>
          <li><i>⚖️</i><div><b>Hommes / femmes</b><br><span class="muted small">Billets vendus, places et places restantes pour vous.</span></div></li>
          <li><i>✉️</i><div><b>Alertes par e-mail</b><br><span class="muted small">Dernières places, nouveau conflit, rappel la veille.</span></div></li>
        </ul>
      </section>
      <section class="card">
        <h2>Se connecter</h2>
        <p class="muted small" style="margin-bottom:14px">Pas de mot de passe à retenir.</p>
        ${err && ERRORS[err] ? `<p class="notice error" style="margin-bottom:12px">${esc(ERRORS[err])}</p>` : ''}
        ${methods.join('')}
        <p class="fineprint">Outil indépendant, non affilié à rendez-vous.social. Vos liens d'agenda sont chiffrés et ne servent qu'à calculer vos disponibilités. <a href="/confidentialite">Confidentialité</a></p>
      </section>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Cadre
  // ---------------------------------------------------------------------------

  function renderShell(content) {
    const v = view(), me = state.me;
    const tabs = Object.entries(VIEWS).map(([k, label]) =>
      `<a class="tab" href="#${k}" ${k === v ? 'aria-current="page"' : ''}>${label}${k === 'planning' && me.selections ? `<span class="count">${me.selections}</span>` : ''}</a>`).join('');
    $app.innerHTML = `<header class="top"><div class="top-in">
        <a class="brand" href="#activites" style="text-decoration:none;color:inherit">RDV<span>.Paris</span></a>
        <nav class="tabs" aria-label="Sections">${tabs}</nav>
        <span class="who" title="${esc(me.email)}">${esc(me.name || me.email)}</span>
      </div></header>
      <main>${content}</main>
      <footer class="foot">Outil indépendant, non affilié à rendez-vous.social. Données : API publique du site, actualisées toutes les 5 minutes. <a href="/confidentialite">Confidentialité</a></footer>`;
  }

  // ---------------------------------------------------------------------------
  // Activités
  // ---------------------------------------------------------------------------

  const STATUS = { free: 'Libre', tight: 'Serré', conflict: 'Conflit', unknown: 'Agenda non branché' };

  function remainingFor(a) {
    const g = a.gender, gender = state.me.settings.gender;
    if (!g || !gender) return null;
    return gender === 'male' ? g.menRemaining : g.womenRemaining;
  }

  function actCard(a, { planning = false } = {}) {
    const g = a.gender;
    const why = a.status === 'conflict' ? `avec ${a.conflicts.slice(0, 2).map(c => `${esc(c.title)} (${hm(c.start)}–${hm(c.end)})`).join(', ')}`
      : a.status === 'tight' ? `moins de ${state.me.settings.bufferMin} min avec ${a.near.slice(0, 2).map(c => `${esc(c.title)} (${hm(c.start)}–${hm(c.end)})`).join(', ')}` : '';
    let ratio = '<p class="seats">Répartition inconnue</p>';
    if (g) {
      const has = g.pctMen != null;
      const seat = (n, cap) => (cap != null ? `${n}/${cap}` : n ? `${n}` : '—');
      ratio = `<div class="ratio-line"><span class="m">♂ ${has ? g.pctMen + ' %' : '—'}</span><span class="f">♀ ${has ? g.pctWomen + ' %' : '—'}</span></div>
        <div class="bar${has ? '' : ' none'}" role="img" aria-label="${has ? `${g.pctMen} % d'hommes, ${g.pctWomen} % de femmes` : 'Aucun billet vendu'}">${has ? `<i style="width:${g.pctMen}%"></i>` : ''}</div>
        <p class="seats">H ${seat(g.men, g.menCapacity)} · F ${seat(g.women, g.womenCapacity)}</p>`;
      const r = remainingFor(a);
      if (r != null && a.sale !== false) {
        const low = state.me.settings.lowPlaces || 3;
        ratio += r <= 0 ? '<p class="mine full">Complet pour vous</p>'
          : `<p class="mine ${r <= low ? 'low' : 'ok'}">${r <= low ? 'Plus que ' : ''}${plural(r, 'place')} pour vous</p>`;
      }
    }
    const gcal = planning ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(googleTemplate(a))}">+ Google Agenda</a>` : '';
    return `<article class="act${a.selected ? ' is-selected' : ''}${a.sale === false ? ' is-closed' : ''}">
      <div class="time"><b>${hm(a.start)}</b><span title="${a.endKnown ? '' : 'Heure de fin non publiée : durée estimée'}">${a.endKnown ? hm(a.end) : `≈ ${durationLabel(a.end - a.start)}`}</span></div>
      <div>
        <a class="act-title" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        ${a.sale === false ? ' <span class="tag">Vente fermée</span>' : ''}
        ${a.location ? `<p class="act-meta">${esc(a.location)}</p>` : ''}
        <span class="status ${a.status}">${STATUS[a.status] || ''}</span>
        ${why ? `<p class="why">${why}</p>` : ''}
      </div>
      <div class="ratio">${ratio}</div>
      <div class="act-actions">
        <button class="btn small pick" type="button" data-pick="${a.id}" aria-pressed="${a.selected}">${a.selected ? 'Choisie ✓' : 'Choisir'}</button>
        <a class="btn small" href="${esc(a.buyUrl)}" target="_blank" rel="noopener">Réserver ↗</a>
        ${gcal}
      </div>
    </article>`;
  }

  function durationLabel(ms) {
    const min = Math.round(ms / 60000), h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h${m ? String(m).padStart(2, '0') : ''}` : `${m} min`;
  }

  function googleTemplate(a) {
    const d = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const p = new URLSearchParams({ action: 'TEMPLATE', text: a.title, dates: `${d(a.start)}/${d(a.end)}`, details: `Réserver : ${a.buyUrl || a.url}`, location: a.location || '' });
    return `https://calendar.google.com/calendar/render?${p}`;
  }

  function grouped(list, opts) {
    let out = '', day = null;
    for (const a of list) {
      const k = fmtKey.format(a.start);
      if (k !== day) {
        if (day) out += '</div>';
        out += `<h2 class="day">${esc(fmtDay.format(a.start))}</h2><div class="acts">`;
        day = k;
      }
      out += actCard(a, opts);
    }
    return day ? out + '</div>' : out;
  }

  function agendaNotices() {
    const d = state.data, me = state.me;
    let out = '';
    if (!me.hasCalendars) {
      out += `<div class="notice" style="margin-bottom:14px"><p><b>Branchez un agenda</b> pour savoir quelles activités sont libres pour vous.</p><a class="btn primary small" href="#agendas">Brancher un agenda</a></div>`;
    }
    if (d && d.agenda.errors.length) {
      out += `<div class="notice error" style="margin-bottom:14px"><p>Agenda illisible : ${d.agenda.errors.map(e => `<b>${esc(e.label)}</b> (${esc(e.message)})`).join(', ')}</p><a class="btn small" href="#agendas">Vérifier</a></div>`;
    }
    return out;
  }

  function renderActivities() {
    const f = state.filters, d = state.data, gender = state.me.settings.gender;
    const toolbar = `<div class="toolbar">
        <input class="search" type="search" placeholder="Rechercher une activité, un quartier…" value="${esc(f.q)}" data-filter="q" aria-label="Rechercher">
        <div class="seg" role="group" aria-label="Période">${[[7, '7 j'], [14, '14 j'], [30, '30 j'], [0, 'Tout']].map(([n, l]) => `<button type="button" data-days="${n}" aria-pressed="${f.days === n}">${l}</button>`).join('')}</div>
        <label class="chip"><input type="checkbox" data-filter="free" ${f.free ? 'checked' : ''}> Libres</label>
        ${gender ? `<label class="chip"><input type="checkbox" data-filter="mine" ${f.mine ? 'checked' : ''}> Places pour moi</label>` : ''}
        <button class="btn ghost small" type="button" data-action="refresh" title="Relire les agendas">↻ Actualiser</button>
      </div>`;
    if (!d) {
      return renderShell(`${agendaNotices()}${toolbar}${state.error ? `<p class="notice error">${esc(state.error)}</p>` : '<p class="empty">Chargement des activités…</p>'}`);
    }
    const now = Date.now(), q = norm(f.q);
    const list = d.activities.filter(a => (!f.days || a.start < now + f.days * DAY)
      && (!f.free || a.status === 'free' || a.status === 'unknown')
      && (!f.mine || !gender || (remainingFor(a) == null || remainingFor(a) > 0))
      && (!q || norm(a.title + ' ' + (a.location || '')).includes(q)));
    const c = s => list.filter(a => a.status === s).length;
    const summary = `<div class="summary"><span><b>${list.length}</b> activités</span>${state.me.hasCalendars ? `<span><b>${c('free')}</b> libres</span><span><b>${c('tight')}</b> serrées</span><span><b>${c('conflict')}</b> en conflit</span>` : ''}${state.loading ? '<span>Actualisation…</span>' : ''}</div>`;
    const body = list.length ? grouped(list) : '<div class="empty"><h2>Aucune activité</h2><p>Élargissez la période ou retirez un filtre.</p></div>';
    renderShell(`${agendaNotices()}${toolbar}${summary}${body}`);
  }

  // ---------------------------------------------------------------------------
  // Mon planning
  // ---------------------------------------------------------------------------

  function renderPlanning() {
    const d = state.data, me = state.me;
    const chosen = d ? d.activities.filter(a => a.selected) : [];
    const gone = d ? d.gone : [];
    const exportCard = `<section class="card">
      <h2>Retrouver ces activités dans votre agenda</h2>
      <div class="stack">
        <p class="muted small">Abonnez votre agenda à ce lien : vos choix s'y ajoutent et s'y mettent à jour tout seuls. Google Agenda : « Autres agendas » → « + » → « À partir de l'URL ». Apple : Fichier → Nouvel abonnement. Outlook : Ajouter un calendrier → À partir d'Internet.</p>
        <div class="copy"><input type="text" readonly value="${esc(me.feedUrl)}" aria-label="Lien d'abonnement"><button class="btn small" type="button" data-action="copy-feed">Copier</button></div>
        <div class="row"><a class="btn small" href="/planning.ics">Télécharger (.ics)</a><button class="btn ghost small" type="button" data-action="reset-feed">Changer le lien secret</button></div>
      </div>
    </section>`;
    let body;
    if (!d) body = state.error ? `<p class="notice error">${esc(state.error)}</p>` : '<p class="empty">Chargement…</p>';
    else if (!chosen.length && !gone.length) body = '<div class="empty card"><h2>Aucune activité choisie</h2><p>Dans l\'onglet Activités, cliquez sur « Choisir » pour les ajouter ici.</p><p style="margin-top:14px"><a class="btn primary" href="#activites">Voir les activités</a></p></div>';
    else {
      body = gone.map(g => `<p class="notice warn" style="margin-bottom:10px"><span><b>${esc(g.title)}</b> (${esc(fmtDay.format(g.start))}) n'apparaît plus sur rendez-vous.social.</span><button class="btn small" type="button" data-pick="${g.id}" aria-pressed="true">Retirer</button></p>`).join('')
        + grouped(chosen, { planning: true });
    }
    renderShell(`<div class="row" style="justify-content:space-between;margin-bottom:6px"><h1>Mon planning</h1></div>
      <p class="muted" style="margin-bottom:8px">Choisir une activité ne réserve pas votre place : utilisez « Réserver » pour prendre votre billet sur rendez-vous.social.</p>
      ${body}<div style="margin-top:24px">${exportCard}</div>`);
  }

  // ---------------------------------------------------------------------------
  // Agendas
  // ---------------------------------------------------------------------------

  function renderAgendas() {
    const me = state.me, f = state.features, g = me.google;
    let google;
    if (!f.google) {
      google = '<p class="muted small">La connexion directe à Google n\'est pas configurée sur ce serveur : utilisez l\'« adresse secrète au format iCal » de Google Agenda ci-dessous.</p>';
    } else if (!g.connected) {
      google = `<p class="muted small" style="margin-bottom:12px">Lecture seule : RDV.Paris lit vos évènements pour détecter les conflits, sans jamais rien modifier.</p>
        <a class="btn google" href="/auth/google?calendar=1">${GOOGLE_ICON} Connecter Google Agenda</a>`;
    } else {
      google = `${g.error ? `<p class="notice error" style="margin-bottom:10px">${esc(g.error)} <a class="btn small" href="/auth/google?calendar=1">Reconnecter</a></p>` : ''}
        <p class="muted small">Agendas à prendre en compte :</p>
        <ul class="list">${g.calendars.map(c => `<li><label class="check" style="flex:1;padding:0"><input type="checkbox" data-gcal="${esc(c.id)}" ${c.selected ? 'checked' : ''}><span class="grow"><b>${esc(c.summary)}</b>${c.primary ? '<span class="muted small">Agenda principal</span>' : ''}</span></label></li>`).join('') || '<li class="muted">Aucun agenda trouvé.</li>'}</ul>
        <div class="row" style="margin-top:12px"><a class="btn small" href="/auth/google?calendar=1">Actualiser la liste</a><button class="btn small danger" type="button" data-action="google-disconnect">Déconnecter Google Agenda</button></div>`;
    }
    const icals = me.calendars.length
      ? `<ul class="list">${me.calendars.map(c => `<li><span class="grow"><b>${esc(c.label)}</b><span class="muted small">${esc(c.host)} · ajouté le ${esc(new Date(c.addedAt).toLocaleDateString('fr-FR'))}</span></span><button class="btn small danger" type="button" data-rmcal="${esc(c.id)}">Retirer</button></li>`).join('')}</ul>`
      : '';
    renderShell(`<h1 style="margin-bottom:14px">Mes agendas</h1>
      <section class="card"><h2>Google Agenda</h2>${google}</section>
      <section class="card">
        <h2>Lien iCal (Outlook, Apple, Google…)</h2>
        <p class="muted small">Collez le lien privé de votre agenda. Il est chiffré sur le serveur et n'est jamais affiché en entier.</p>
        <form class="stack" data-form="ical" style="margin-top:12px">
          <label class="field">Lien de l'agenda<input type="url" name="url" required placeholder="https://… ou webcal://…" inputmode="url" autocomplete="off"></label>
          <label class="field">Nom <span>facultatif, par ex. « Travail »</span><input type="text" name="label" maxlength="60"></label>
          <div><button class="btn primary" type="submit">Ajouter l'agenda</button></div>
        </form>
        ${icals}
        <details><summary>Où trouver ce lien ?</summary>
          <table class="help">
            <tr><td>Google Agenda</td><td>Paramètres → votre agenda → Intégrer l'agenda → <b>Adresse secrète au format iCal</b></td></tr>
            <tr><td>Outlook / Microsoft 365</td><td>Paramètres → Calendrier → Calendriers partagés → Publier un calendrier → lien <b>ICS</b></td></tr>
            <tr><td>Apple iCloud</td><td>Calendrier → partager → Calendrier public → lien <b>webcal://</b></td></tr>
          </table>
        </details>
      </section>`);
  }

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------

  function renderSettings() {
    const me = state.me, s = me.settings, mail = state.features.email;
    const radio = (v, l) => `<label><input type="radio" name="gender" value="${v}" ${String(s.gender) === v ? 'checked' : ''}> ${l}</label>`;
    const toggle = (k, title, desc) => `<label class="check"><input type="checkbox" data-notify="${k}" ${s.notify[k] ? 'checked' : ''} ${mail ? '' : 'disabled'}><span><b>${title}</b><span class="muted small">${desc}</span></span></label>`;
    renderShell(`<h1 style="margin-bottom:14px">Réglages</h1>
      <section class="card">
        <h2>Vous êtes</h2>
        <p class="muted small" style="margin-bottom:10px">Pour afficher les places restantes pour vous et vous prévenir quand il n'en reste plus beaucoup.</p>
        <div class="radio-row">${radio('male', 'Un homme')}${radio('female', 'Une femme')}${radio('null', 'Ne pas préciser')}</div>
      </section>
      <section class="card">
        <h2>Comparaison avec l'agenda</h2>
        <div class="grid2" style="margin-top:10px">
          <label class="field">Marge avant / après (minutes)<span>En dessous, l'activité est « serrée ».</span><input type="number" min="0" max="240" step="5" data-setting="bufferMin" value="${s.bufferMin}"></label>
          <label class="field">Durée si l'heure de fin est inconnue (minutes)<span>La plupart des activités n'ont pas d'heure de fin.</span><input type="number" min="30" max="600" step="15" data-setting="defaultDurationMin" value="${s.defaultDurationMin}"></label>
        </div>
        <label class="check"><input type="checkbox" data-setting="ignoreAllDay" ${s.ignoreAllDay ? 'checked' : ''}><span><b>Ignorer les évènements « toute la journée »</b><span class="muted small">Anniversaires, jours fériés, congés…</span></span></label>
      </section>
      <section class="card">
        <h2>E-mails</h2>
        ${mail ? `<p class="muted small">Envoyés à <b>${esc(me.email)}</b>, au plus un e-mail par vérification (toutes les 30 minutes environ).</p>`
          : '<p class="notice warn">L\'envoi d\'e-mails n\'est pas configuré sur ce serveur.</p>'}
        ${toggle('alerts', 'Alertes sur mes activités choisies', 'Nouveau conflit avec mon agenda, dernières places pour moi, complet, vente fermée.')}
        ${toggle('reminder', 'Rappel la veille', 'Pour chaque activité choisie.')}
        ${toggle('digest', 'Nouvelles activités libres', 'Quand une activité qui tient dans mon agenda est publiée.')}
        <div class="row" style="margin-top:6px">
          <label class="field" style="display:flex;align-items:center;gap:8px">Alerter à partir de <input type="number" min="1" max="20" data-setting="lowPlaces" value="${s.lowPlaces}" ${mail ? '' : 'disabled'}> places restantes</label>
          ${mail ? '<button class="btn small" type="button" data-action="test-mail">Envoyer un e-mail de test</button>' : ''}
        </div>
      </section>
      <section class="card">
        <h2>Compte</h2>
        <p class="muted small">Connecté en tant que <b>${esc(me.email)}</b>.</p>
        <div class="row" style="margin-top:12px"><button class="btn" type="button" data-action="logout">Se déconnecter</button><button class="btn danger" type="button" data-action="delete-account">Supprimer mon compte</button></div>
      </section>`);
  }

  // ---------------------------------------------------------------------------
  // Rendu et évènements
  // ---------------------------------------------------------------------------

  function render() {
    if (!state.me) return renderLogin();
    ({ activites: renderActivities, planning: renderPlanning, agendas: renderAgendas, reglages: renderSettings })[view()]();
  }

  async function run(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message); }
  }

  const refreshSoon = () => loadActivities(true);

  $app.addEventListener('click', e => {
    const t = e.target.closest('[data-pick],[data-days],[data-action],[data-rmcal]');
    if (!t) return;
    if (t.dataset.pick) {
      const id = +t.dataset.pick, selected = t.getAttribute('aria-pressed') !== 'true';
      return run(async () => {
        const r = await api('PUT', `/api/selections/${id}`, { selected });
        state.me.selections = r.selections;
        const a = state.data && state.data.activities.find(x => x.id === id);
        if (a) a.selected = selected;
        if (!selected && state.data) state.data.gone = state.data.gone.filter(g => g.id !== id);
        render();
      }, selected ? 'Ajoutée à votre planning' : 'Retirée de votre planning');
    }
    if (t.dataset.days) { state.filters.days = +t.dataset.days; saveFilters(); return render(); }
    if (t.dataset.rmcal) {
      return run(async () => { setUser((await api('DELETE', `/api/calendars/ical/${t.dataset.rmcal}`)).user); render(); refreshSoon(); }, 'Agenda retiré');
    }
    const act = t.dataset.action;
    if (act === 'refresh') return loadActivities(true);
    if (act === 'copy-feed') {
      const input = t.parentElement.querySelector('input');
      return run(async () => { await navigator.clipboard.writeText(input.value); }, 'Lien copié');
    }
    if (act === 'reset-feed') {
      if (!confirm("L'ancien lien cessera de fonctionner. Continuer ?")) return;
      return run(async () => { setUser((await api('POST', '/api/feed/reset')).user); render(); }, 'Nouveau lien créé');
    }
    if (act === 'google-disconnect') {
      return run(async () => { setUser((await api('DELETE', '/api/calendars/google')).user); render(); refreshSoon(); }, 'Google Agenda déconnecté');
    }
    if (act === 'test-mail') return run(() => api('POST', '/api/notifications/test'), 'E-mail de test envoyé');
    if (act === 'logout') return run(async () => { await api('POST', '/auth/logout'); state.me = null; state.data = null; location.hash = ''; render(); });
    if (act === 'delete-account') {
      if (!confirm('Supprimer votre compte, vos agendas et votre planning ? Cette action est définitive.')) return;
      return run(async () => { await api('DELETE', '/api/account'); state.me = null; state.data = null; location.hash = ''; render(); }, 'Compte supprimé');
    }
  });

  let searchTimer;
  $app.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.filter === 'q') {
      state.filters.q = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const pos = t.selectionStart;
        render();
        const again = $app.querySelector('[data-filter="q"]');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 150);
    }
  });

  let settingsTimer;
  $app.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.filter === 'free' || t.dataset.filter === 'mine') { state.filters[t.dataset.filter] = t.checked; saveFilters(); return render(); }
    if (t.dataset.gcal !== undefined) {
      const ids = [...$app.querySelectorAll('[data-gcal]')].filter(x => x.checked).map(x => x.dataset.gcal);
      return run(async () => { setUser((await api('PUT', '/api/calendars/google', { selected: ids })).user); refreshSoon(); }, 'Agendas mis à jour');
    }
    let patch = null;
    if (t.name === 'gender') patch = { gender: t.value === 'null' ? null : t.value };
    else if (t.dataset.notify) patch = { notify: { [t.dataset.notify]: t.checked } };
    else if (t.dataset.setting) patch = { [t.dataset.setting]: t.type === 'checkbox' ? t.checked : +t.value };
    if (!patch) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => run(async () => {
      setUser((await api('PUT', '/api/settings', patch)).user);
      if (!('notify' in patch)) refreshSoon();
    }, 'Réglage enregistré'), t.type === 'number' ? 400 : 0);
  });

  $app.addEventListener('submit', e => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const done = () => { if (button) button.disabled = false; };
    const kind = form.dataset.form;
    if (kind === 'email-login') {
      return run(async () => { await api('POST', '/auth/email', { email: data.email }); state.loginSent = data.email; render(); }).finally(done);
    }
    if (kind === 'dev-login') {
      return run(async () => { await api('POST', '/auth/dev', { email: data.email }); await start(); }).finally(done);
    }
    if (kind === 'ical') {
      return run(async () => {
        setUser((await api('POST', '/api/calendars/ical', { url: data.url, label: data.label })).user);
        render(); await loadActivities(true);
        const errs = state.data && state.data.agenda.errors;
        if (errs && errs.length) toast(`Agenda ajouté, mais illisible : ${errs[0].message}`);
      }, 'Agenda ajouté').finally(done);
    }
  });

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  async function start() {
    try { await loadMe(); } catch (e) { $app.innerHTML = `<p class="boot">Serveur injoignable : ${esc(e.message)}</p>`; return; }
    const err = new URLSearchParams(location.search).get('erreur');
    if (state.me && err) { toast(ERRORS[err] || 'Erreur'); history.replaceState(null, '', '/' + location.hash); }
    render();
    if (state.me) loadActivities(false);
  }
  start();
})();
