/*
 * Configuration du site, lue dans les variables d'environnement (voir web/.env.example).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function bool(v) { return /^(1|true|yes|oui|on)$/i.test(String(v || '')); }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

function loadConfig(env = process.env) {
  const port = int(env.PORT, 3100);
  const host = env.HOST || '127.0.0.1';
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);

  let secret = env.APP_SECRET;
  if (!secret) {
    // Clé générée une fois et gardée dans DATA_DIR : elle chiffre les liens d'agenda et les jetons Google.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('APP_SECRET doit faire au moins 32 caractères');

  let smtp = null;
  if (env.SMTP_URL) smtp = env.SMTP_URL;
  else if (env.SMTP_HOST) {
    smtp = {
      host: env.SMTP_HOST, port: int(env.SMTP_PORT, 465), secure: env.SMTP_SECURE ? bool(env.SMTP_SECURE) : int(env.SMTP_PORT, 465) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    };
  }
  const mailTransport = env.MAIL_TRANSPORT === 'console' ? 'console' : smtp ? 'smtp' : null;

  const devLogin = bool(env.DEV_LOGIN);
  if (devLogin && !local) throw new Error('DEV_LOGIN n\'est autorisé que si BASE_URL est http://localhost');

  return {
    port, host, baseUrl, dataDir, secret, local,
    secureCookies: baseUrl.startsWith('https://'),
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
    mail: mailTransport ? { transport: mailTransport, smtp, from: env.MAIL_FROM || 'RDV.Paris <no-reply@localhost>' } : null,
    devLogin,
    city: env.CITY || 'paris',
    trustProxy: bool(env.TRUST_PROXY), // derrière nginx : lire X-Forwarded-For
    notifyIntervalMin: Math.max(10, int(env.NOTIFY_INTERVAL_MIN, 30)),
    allowPrivateIcal: bool(env.ALLOW_PRIVATE_ICAL), // tests uniquement
  };
}

module.exports = { loadConfig };
