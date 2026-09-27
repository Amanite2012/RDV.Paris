/*
 * Envoi d'e-mails : SMTP (nodemailer) ou affichage dans la console (développement, tests).
 */
'use strict';

function createMailer(cfg, log = console) {
  if (!cfg.mail) return null;
  if (cfg.mail.transport === 'console') {
    const outbox = [];
    return {
      outbox,
      async send(msg) {
        outbox.push(msg);
        log.log(`\n--- e-mail (console) ---\nÀ : ${msg.to}\nObjet : ${msg.subject}\n\n${msg.text}\n--- fin ---\n`);
      },
    };
  }
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(cfg.mail.smtp);
  return {
    async send(msg) { await transport.sendMail(Object.assign({ from: cfg.mail.from }, msg)); },
    verify: () => transport.verify(),
  };
}

module.exports = { createMailer };
