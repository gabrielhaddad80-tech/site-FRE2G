// Envoi des e-mails : SMTP réel, ou « outbox » (fichiers .eml dans data/outbox) pour les essais.
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { renderEmail } from './render.js';

export function createMailer(config, db) {
  const outboxDir = path.join(config.dataDir, 'outbox');
  let transport;
  if (config.mail.mode === 'smtp') {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined
    });
  } else {
    fs.mkdirSync(outboxDir, { recursive: true });
    transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  }

  // Envoie le mail `template` à `to` ; journalise le résultat. Lève une erreur en cas d'échec.
  async function send({ template, to, context, attachments = [], quoteId = null, kind = template, bcc = true, replyTo }) {
    const { subject, html, text } = renderEmail(template, context);
    const message = {
      from: config.mail.from,
      to,
      bcc: bcc && config.mail.bcc ? config.mail.bcc : undefined,
      replyTo,
      subject,
      html,
      text,
      attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType || 'application/pdf' }))
    };
    try {
      const info = await transport.sendMail(message);
      let file = null;
      if (config.mail.mode !== 'smtp') {
        file = path.join(outboxDir, `${Date.now()}-${kind}-${String(to).replace(/[^a-z0-9@.]+/gi, '_')}.eml`);
        fs.writeFileSync(file, info.message);
      }
      db.prepare('INSERT INTO emails (quote_id, kind, recipient, subject, status, message_id, file) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(quoteId, kind, String(to), subject, 'envoye', info.messageId || null, file);
      return { subject, messageId: info.messageId, file };
    } catch (e) {
      db.prepare('INSERT INTO emails (quote_id, kind, recipient, subject, status, error) VALUES (?, ?, ?, ?, ?, ?)')
        .run(quoteId, kind, String(to), subject, 'erreur', e.message);
      throw new Error(`Envoi du mail « ${subject} » à ${to} impossible : ${e.message}`);
    }
  }

  async function verify() {
    if (config.mail.mode !== 'smtp') return { ok: true, mode: 'outbox', dir: outboxDir };
    await transport.verify();
    return { ok: true, mode: 'smtp', host: config.mail.host };
  }

  return { send, verify, mode: config.mail.mode, outboxDir };
}
