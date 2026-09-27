/*
 * Notifications par e-mail.
 *
 * Toutes les NOTIFY_INTERVAL_MIN minutes : une seule lecture de la liste des activités (en cache),
 * puis pour chaque utilisateur qui a activé les e-mails, au plus un message qui regroupe :
 *  - alertes sur les activités choisies : nouveau conflit d'agenda, peu de places pour son genre,
 *    complet pour son genre, vente fermée, activité disparue du site ;
 *  - rappel la veille ;
 *  - nouvelles activités libres dans son agenda (résumé, désactivé par défaut).
 * Chaque alerte n'est envoyée qu'une fois (clé mémorisée dans notifyState.sent).
 */
'use strict';
const crypto = require('node:crypto');
const C = require('../src/core.js');

const TZ = 'Europe/Paris';
const fmtDay = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const when = a => `${fmtDay.format(a.start)} à ${fmtTime.format(a.start)}`;

const GENDER_WORD = { male: 'les hommes', female: 'les femmes' };

// Clé anti-doublon d'un conflit : empreinte, pour ne jamais écrire le titre d'un évènement d'agenda sur le disque.
const fingerprint = c => crypto.createHash('sha256').update(`${c.title}@${c.start}`).digest('base64url').slice(0, 12);

function remainingFor(a, gender) {
  if (!a.gender || !gender) return null;
  const r = gender === 'male' ? a.gender.menRemaining : a.gender.womenRemaining;
  return r == null ? null : r;
}

/**
 * Calcule ce qu'il faut envoyer, sans rien envoyer.
 * `acts` : activités annotées pour cet utilisateur (statut d'agenda, `sale`, `gender`).
 * Retourne { alerts, reminders, digest, seen } ; `seen` = nouvel état des activités vues.
 */
function computeNotifications(user, acts, now, { hasAgenda = true } = {}) {
  const s = user.settings, n = s.notify || {};
  const st = user.notifyState || { initialized: false, seen: [], sent: {} };
  const sent = st.sent || {};
  const byId = new Map(acts.map(a => [a.id, a]));
  const alerts = [], reminders = [];
  const push = (list, key, activity, text) => { if (!sent[key]) list.push({ key, activity, text }); };

  for (const [id, sel] of Object.entries(user.selections || {})) {
    const a = byId.get(+id);
    if (!a) {
      if (n.alerts && sel.start > now) push(alerts, `gone:${id}`, sel, "n'apparaît plus sur rendez-vous.social (annulée, reportée ou masquée ?)");
      continue;
    }
    if (a.start <= now) continue;
    if (n.alerts) {
      if (hasAgenda && a.status === 'conflict') {
        for (const c of a.conflicts) push(alerts, `conflict:${id}:${fingerprint(c)}`, a, `conflit avec « ${c.title} » (${fmtTime.format(c.start)}–${fmtTime.format(c.end)})`);
      }
      const r = remainingFor(a, s.gender);
      if (r != null && r <= 0) push(alerts, `full:${id}`, a, `complet pour ${GENDER_WORD[s.gender]}`);
      else if (r != null && r <= (s.lowPlaces || 3)) push(alerts, `low:${id}`, a, `plus que ${r} place${r > 1 ? 's' : ''} pour ${GENDER_WORD[s.gender]}`);
      if (a.sale === false) push(alerts, `closed:${id}`, a, 'la vente est fermée');
    }
    if (n.reminder && a.start - now <= C.DAY) push(reminders, `reminder:${id}`, a, `c'est ${when(a)}`);
  }

  let digest = [];
  const ids = acts.map(a => a.id);
  if (n.digest && st.initialized) {
    const seen = new Set(st.seen || []);
    digest = acts.filter(a => !seen.has(a.id) && !user.selections[a.id] && (!hasAgenda || a.status === 'free') && a.sale !== false
      && a.start > now && (remainingFor(a, s.gender) == null || remainingFor(a, s.gender) > 0));
  }
  return { alerts, reminders, digest, seen: ids, hasAgenda };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ratio(a) {
  const g = a.gender;
  return g && g.pctMen != null ? `♂ ${g.pctMen} % · ♀ ${g.pctWomen} %` : '';
}

/** Met en forme un e-mail (texte + HTML) à partir du résultat de computeNotifications. */
function composeEmail(user, r, { baseUrl, unsubscribeUrl }) {
  const parts = [];
  if (r.alerts.length) parts.push(`${r.alerts.length} alerte${r.alerts.length > 1 ? 's' : ''}`);
  if (r.reminders.length) parts.push(`${r.reminders.length} rappel${r.reminders.length > 1 ? 's' : ''}`);
  if (r.digest.length) {
    const pl = r.digest.length > 1 ? 's' : '';
    parts.push(`${r.digest.length} nouvelle${pl} activité${pl}${r.hasAgenda === false ? '' : ` libre${pl}`}`);
  }
  const subject = `RDV.Paris : ${parts.join(', ')}`;

  const sections = [];
  const line = x => ({ title: x.activity.title, url: x.activity.url, detail: `${when(x.activity)} : ${x.text}` });
  if (r.alerts.length) sections.push({ heading: 'Vos activités choisies', rows: r.alerts.map(line) });
  if (r.reminders.length) sections.push({ heading: 'Rappel', rows: r.reminders.map(line) });
  if (r.digest.length) {
    sections.push({
      heading: r.hasAgenda === false ? 'Nouvelles activités' : 'Nouvelles activités libres dans votre agenda',
      rows: r.digest.slice(0, 20).map(a => ({ title: a.title, url: a.url, detail: [when(a), a.location, ratio(a)].filter(Boolean).join(' · ') })),
    });
  }

  const text = [
    `Bonjour${user.name ? ' ' + user.name.split(' ')[0] : ''},`, '',
    ...sections.flatMap(s => [s.heading.toUpperCase(), ...s.rows.map(x => `- ${x.title.trim()} — ${x.detail}\n  ${x.url}`), '']),
    `Votre planning : ${baseUrl}`,
    `Ne plus recevoir ces e-mails : ${unsubscribeUrl}`,
  ].join('\n');

  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f5f2;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p style="font-weight:700;font-size:18px;margin:0 0 16px">RDV.Paris</p>
${sections.map(s => `<h2 style="font-size:15px;margin:20px 0 8px">${esc(s.heading)}</h2>
${s.rows.map(x => `<div style="background:#fff;border-radius:10px;padding:12px 14px;margin:0 0 8px"><a href="${esc(x.url)}" style="color:#9f052e;font-weight:600;text-decoration:none">${esc(x.title.trim())}</a><br><span style="color:#55555c">${esc(x.detail)}</span></div>`).join('')}`).join('')}
<p style="margin:24px 0 0"><a href="${esc(baseUrl)}" style="color:#9f052e">Ouvrir mon planning</a></p>
<p style="color:#8a8a90;font-size:12px;margin:24px 0 0">Vous recevez cet e-mail car vous avez activé les notifications. <a href="${esc(unsubscribeUrl)}" style="color:#8a8a90">Ne plus recevoir ces e-mails</a>.</p>
</div></body></html>`;
  return { subject, text, html };
}

function createNotifier({ cfg, store, secure, planner, mailer, log = console }) {
  const unsubscribeUrl = user => `${cfg.baseUrl}/unsubscribe?u=${encodeURIComponent(user.id)}&t=${secure.sign('unsub:' + user.id)}`;

  async function runOnce(now = Date.now()) {
    if (!mailer) return { sent: 0 };
    let count = 0;
    for (const user of store.users()) {
      const n = user.settings.notify || {};
      if (!user.email || !(n.alerts || n.reminder || n.digest)) continue;
      try {
        const { acts, agenda } = await planner.forUser(user);
        const r = computeNotifications(user, acts, now, { hasAgenda: agenda.sources > 0 });
        const st = user.notifyState = user.notifyState || { initialized: false, seen: [], sent: {} };
        if (r.alerts.length || r.reminders.length || r.digest.length) {
          const mail = composeEmail(user, r, { baseUrl: cfg.baseUrl, unsubscribeUrl: unsubscribeUrl(user) });
          await mailer.send({
            to: user.email, subject: mail.subject, text: mail.text, html: mail.html,
            headers: { 'List-Unsubscribe': `<${unsubscribeUrl(user)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          });
          for (const x of [...r.alerts, ...r.reminders]) st.sent[x.key] = now;
          count++;
        }
        st.seen = r.seen;
        st.initialized = true;
        for (const [k, t] of Object.entries(st.sent)) if (now - t > 90 * C.DAY) delete st.sent[k];
        store.save();
      } catch (e) {
        log.error(`notifications ${user.id} : ${e.message}`);
      }
    }
    return { sent: count };
  }

  let timer = null;
  return {
    runOnce,
    unsubscribeUrl,
    start() {
      if (!mailer || timer) return;
      const tick = () => runOnce().catch(e => log.error('notifications : ' + e.message));
      setTimeout(tick, 60 * 1000).unref();
      timer = setInterval(tick, cfg.notifyIntervalMin * C.MINUTE);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { computeNotifications, composeEmail, createNotifier, remainingFor };
