/*
 * Chiffrement des données sensibles (liens iCal, jetons Google) et jetons aléatoires.
 */
'use strict';
const crypto = require('node:crypto');

function createSecure(secret) {
  const derive = info => Buffer.from(crypto.hkdfSync('sha256', secret, 'rdv-paris', info, 32));
  const encKey = derive('encryption');
  const macKey = derive('signature');

  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
    },
    decrypt(blob) {
      if (typeof blob !== 'string' || !blob.startsWith('v1:')) throw new Error('donnée chiffrée invalide');
      const raw = Buffer.from(blob.slice(3), 'base64url');
      const d = crypto.createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
    sign(value) { return crypto.createHmac('sha256', macKey).update(String(value)).digest('base64url'); },
    verify(value, sig) {
      const a = Buffer.from(this.sign(value)), b = Buffer.from(String(sig || ''));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('base64url');

module.exports = { createSecure, token, sha256 };
