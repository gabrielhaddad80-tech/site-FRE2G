// Serveur web de l'agent FRE2G : interface d'administration + page de signature client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig, ROOT } from './config.js';
import { openDatabase, getSettings, saveSettings, DEFAULT_SETTINGS } from './db.js';
import { createMailer } from './mailer.js';
import { createWorkflow, WorkflowError, STATUS } from './workflow.js';
import { createAi, AiError } from './ai.js';
import { closeBrowser, setChromiumPath } from './render.js';
import { signerPage, signedPage, signerMessagePage } from './signer-page.js';
import { computeQuoteTotals, computeSchedule } from './money.js';
import { partyName, formatDateTimeParis } from './util.js';

const SESSION_COOKIE = 'fre2g_session';
const SESSION_DAYS = 14;

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  if (!config.adminPassword) throw new Error("ADMIN_PASSWORD n'est pas défini : ajoutez-le dans le fichier .env (voir .env.example).");
  const sessionSecret = config.sessionSecret || crypto.randomBytes(32).toString('hex');
  setChromiumPath(config.chromiumPath);

  const db = openDatabase(config.dataDir);
  const mailer = overrides.mailer || createMailer(config, db);
  const wf = createWorkflow({ db, config, mailer });
  const ai = overrides.ai || createAi(config);

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  // --- Sessions administrateur (cookie signé HMAC) ----------------------------
  const sign = (v) => crypto.createHmac('sha256', sessionSecret).update(v).digest('base64url');
  function makeSession() {
    const payload = `${Date.now() + SESSION_DAYS * 86400000}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${sign(payload)}`;
  }
  function validSession(v) {
    if (typeof v !== 'string') return false;
    const i = v.lastIndexOf('.');
    if (i < 0) return false;
    const payload = v.slice(0, i);
    const expected = sign(payload);
    const given = v.slice(i + 1);
    if (expected.length !== given.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return false;
    return Number(payload.split('.')[0]) > Date.now();
  }
  const requireAdmin = (req, res, next) => (validSession(req.cookies[SESSION_COOKIE]) ? next() : res.status(401).json({ error: 'Connexion requise', code: 'auth' }));

  const attempts = new Map();
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const a = attempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives : réessayez dans quelques minutes.' });
    const given = Buffer.from(String(req.body?.password || ''));
    const expected = Buffer.from(config.adminPassword);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      a.n += 1;
      if (a.n >= 8) { a.until = Date.now() + 15 * 60000; a.n = 0; }
      attempts.set(key, a);
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    attempts.delete(key);
    res.cookie(SESSION_COOKIE, makeSession(), {
      httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://'), maxAge: SESSION_DAYS * 86400000, path: '/'
    });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { res.clearCookie(SESSION_COOKIE, { path: '/' }); res.json({ ok: true }); });

  const api = express.Router();
  api.use(requireAdmin);
  const h = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      const status = e instanceof WorkflowError || e instanceof AiError ? e.status : 500;
      if (status >= 500) console.error(e);
      res.status(status).json({ error: e.message });
    }
  };
  const sendPdf = (res, buffer, name, inline = true) => {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.end(buffer);
  };

  api.get('/me', h(() => ({
    ok: true, mail_mode: mailer.mode, ai_enabled: ai.enabled, base_url: config.baseUrl, statuses: STATUS,
    notify: config.mail.notify || null
  })));

  // --- Paramètres --------------------------------------------------------------
  api.get('/settings', h(() => getSettings(db)));
  api.put('/settings', h((req) => {
    const values = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in (req.body || {})) values[k] = req.body[k];
    saveSettings(db, values);
    return getSettings(db);
  }));

  // --- Tableau de bord ---------------------------------------------------------
  api.get('/dashboard', h(() => {
    const quotes = wf.listQuotes();
    const by = (s) => quotes.filter((q) => q.status === s);
    const sum = (rows, k) => Math.round(rows.reduce((t, r) => t + (r[k] || 0), 0) * 100) / 100;
    const unpaid = db.prepare("SELECT COALESCE(SUM(amount_due),0) AS s, COUNT(*) AS n FROM invoices WHERE status = 'emise'").get();
    const overdue = db.prepare("SELECT COALESCE(SUM(amount_due),0) AS s, COUNT(*) AS n FROM invoices WHERE status = 'emise' AND due_date < date('now')").get();
    const signed = quotes.filter((q) => q.signed_at);
    const lost = by('refuse').length;
    return {
      counts: Object.fromEntries(Object.keys(STATUS).map((s) => [s, by(s).length])),
      pending_signature_ht: sum(by('attente_signature'), 'total_ht'),
      signed_ht: sum(signed, 'total_ht'),
      signature_rate: signed.length + lost ? signed.length / (signed.length + lost) : null,
      unpaid_ttc: unpaid.s, unpaid_count: unpaid.n, overdue_ttc: overdue.s, overdue_count: overdue.n,
      automation_errors: quotes.filter((q) => q.automation_errors > 0).length,
      recent_events: db.prepare(`SELECT e.*, q.number FROM events e LEFT JOIN quotes q ON q.id = e.quote_id ORDER BY e.id DESC LIMIT 25`).all()
    };
  }));

  // --- Devis / dossiers --------------------------------------------------------
  api.get('/quotes', h(() => wf.listQuotes()));
  api.get('/quotes/defaults', h(() => wf.prefill(getSettings(db))));
  api.post('/quotes', h((req) => wf.createQuote(req.body || {})));
  api.get('/quotes/:id', h((req) => wf.getQuote(req.params.id)));
  api.put('/quotes/:id', h((req) => wf.updateQuote(req.params.id, req.body || {})));
  api.delete('/quotes/:id', h((req) => { wf.deleteQuote(req.params.id); return { ok: true }; }));
  api.post('/quotes/:id/duplicate', h((req) => wf.duplicateQuote(req.params.id)));
  api.get('/quotes/:id/preview.pdf', h(async (req, res) => {
    const q = wf.getQuote(req.params.id);
    sendPdf(res, await wf.previewQuotePdf(req.params.id), `Devis-${q.number}-apercu.pdf`);
  }));
  api.get('/quotes/:id/:kind(original|signe).pdf', h((req, res) => {
    const q = db.prepare('SELECT number, original_pdf, signed_pdf FROM quotes WHERE id = ?').get(Number(req.params.id));
    const file = req.params.kind === 'signe' ? q?.signed_pdf : q?.original_pdf;
    if (!file || !fs.existsSync(file)) throw new WorkflowError('Document indisponible', 404);
    sendPdf(res, fs.readFileSync(file), path.basename(file));
  }));
  api.post('/quotes/:id/send-for-signature', h((req) => wf.sendForSignature(req.params.id)));
  api.post('/quotes/:id/back-to-draft', h((req) => wf.backToDraft(req.params.id)));
  api.post('/quotes/:id/refuse', h((req) => wf.markRefused(req.params.id, req.body?.reason)));
  api.post('/quotes/:id/deposit-paid', h((req) => wf.recordDeposit(req.params.id, req.body || {})));
  api.post('/quotes/:id/installation-done', h((req) => wf.completeInstallation(req.params.id, req.body || {})));
  api.post('/quotes/:id/balance-paid', h((req) => wf.recordBalance(req.params.id, req.body || {})));
  api.post('/quotes/:id/retry', h((req) => wf.retryAutomation(req.params.id)));

  // --- Rédaction par Claude ----------------------------------------------------
  api.post('/ai/draft', h(async (req) => {
    const s = getSettings(db);
    return ai.draftQuote({ notes: req.body?.notes, priceList: s.ai_price_list, defaults: { delai: s.default_delai, non_compris: s.default_non_compris, garantie: s.default_garantie } });
  }));

  // --- Clients (fiches créées à la signature) ----------------------------------
  api.get('/clients', h((req) => {
    const status = ['en_cours', 'installe'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM quotes q WHERE q.client_id = c.id) AS quotes_count,
        (SELECT COALESCE(SUM(total_ttc),0) FROM quotes q WHERE q.client_id = c.id) AS signed_ttc,
        (SELECT COALESCE(SUM(amount_due),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'emise') AS due_ttc
      FROM clients c ${status ? 'WHERE c.status = ?' : ''} ORDER BY COALESCE(c.installed_at, c.created_at) DESC`).all(...(status ? [status] : []));
    return rows.map((c) => ({ ...c, name: partyName(c) }));
  }));
  api.get('/clients/:id', h((req) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id));
    if (!c) throw new WorkflowError('Client introuvable', 404);
    return {
      ...c, name: partyName(c),
      quotes: db.prepare('SELECT id, number, status, date, object, total_ttc FROM quotes WHERE client_id = ? ORDER BY id DESC').all(c.id).map((q) => ({ ...q, status_label: STATUS[q.status] })),
      invoices: db.prepare('SELECT id, number, kind, date, due_date, amount_due, status FROM invoices WHERE client_id = ? ORDER BY id DESC').all(c.id)
    };
  }));
  api.put('/clients/:id', h((req) => {
    const b = req.body || {};
    const fields = ['civility', 'first_name', 'last_name', 'company', 'email', 'phone', 'address', 'postal_code', 'city', 'siret', 'vat_number', 'notes'];
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id));
    if (!c) throw new WorkflowError('Client introuvable', 404);
    const next = Object.fromEntries(fields.map((f) => [f, f in b ? String(b[f] ?? '').trim().slice(0, 500) : c[f]]));
    db.prepare(`UPDATE clients SET ${fields.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({ ...next, id: c.id });
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id);
  }));

  // --- Fournisseurs ------------------------------------------------------------
  const supplierFields = ['name', 'email', 'contact', 'phone', 'account_number', 'notes'];
  const cleanSupplier = (b = {}) => Object.fromEntries(supplierFields.map((f) => [f, String(b[f] ?? '').trim().slice(0, 500)]));
  api.get('/suppliers', h(() => db.prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE').all()));
  api.post('/suppliers', h((req) => {
    const s = cleanSupplier(req.body);
    if (!s.name) throw new WorkflowError('Nom du fournisseur obligatoire');
    const r = db.prepare(`INSERT INTO suppliers (${supplierFields.join(', ')}) VALUES (${supplierFields.map((f) => `@${f}`).join(', ')})`).run(s);
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(r.lastInsertRowid));
  }));
  api.put('/suppliers/:id', h((req) => {
    const s = cleanSupplier(req.body);
    if (!s.name) throw new WorkflowError('Nom du fournisseur obligatoire');
    db.prepare(`UPDATE suppliers SET ${supplierFields.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({ ...s, id: Number(req.params.id) });
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.params.id));
  }));
  api.delete('/suppliers/:id', h((req) => {
    const used = db.prepare('SELECT COUNT(*) AS n FROM supplier_orders WHERE supplier_id = ?').get(Number(req.params.id)).n;
    if (used) throw new WorkflowError('Ce fournisseur a déjà reçu des commandes : il ne peut pas être supprimé.', 409);
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  }));

  // --- Factures et bons de commande -------------------------------------------
  api.get('/invoices', h(() => db.prepare(`SELECT i.*, q.number AS quote_number, c.code AS client_code, c.company, c.first_name, c.last_name, c.civility, c.kind AS client_kind
      FROM invoices i JOIN quotes q ON q.id = i.quote_id JOIN clients c ON c.id = i.client_id ORDER BY i.id DESC`).all()
    .map((i) => ({ ...i, details: undefined, client_name: partyName({ company: i.company, first_name: i.first_name, last_name: i.last_name, civility: i.civility, kind: i.client_kind }) }))));
  api.get('/invoices/:id/pdf', h((req, res) => {
    const { file, name } = wf.invoiceFile(req.params.id);
    sendPdf(res, fs.readFileSync(file), name);
  }));
  api.get('/orders/:id/pdf', h((req, res) => {
    const o = db.prepare('SELECT * FROM supplier_orders WHERE id = ?').get(Number(req.params.id));
    if (!o?.pdf_path || !fs.existsSync(o.pdf_path)) throw new WorkflowError('Bon de commande introuvable', 404);
    sendPdf(res, fs.readFileSync(o.pdf_path), `${o.number}.pdf`);
  }));
  api.get('/emails', h(() => db.prepare('SELECT e.id, e.quote_id, e.kind, e.recipient, e.subject, e.status, e.error, e.at, q.number FROM emails e LEFT JOIN quotes q ON q.id = e.quote_id ORDER BY e.id DESC LIMIT 200').all()));
  api.post('/mail/test', h(async (req) => {
    const to = String(req.body?.to || '').trim();
    if (!to) throw new WorkflowError('Indiquez une adresse e-mail.');
    await mailer.send({ template: 'signature_otp', to, kind: 'test', bcc: false, context: { company: wf.company(), quote: { number: 'TEST' }, code: '000000' } });
    return { ok: true, mode: mailer.mode };
  }));

  app.use('/api', api);

  // --- Page de signature du client (publique, protégée par le lien personnel) --
  const signer = express.Router();
  signer.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });
  const signerError = (res, e) => {
    const status = e instanceof WorkflowError ? e.status : 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ error: status >= 500 ? 'Une erreur est survenue. Réessayez ou contactez-nous.' : e.message });
  };
  signer.get('/:token', (req, res) => {
    const st = wf.signingState(req.params.token);
    const company = wf.company();
    if (st.state === 'signe') {
      const sig = st.quote.signature || {};
      return res.send(signedPage({ company, quote: st.quote, token: req.params.token, signedAtText: sig.signed_at_text || formatDateTimeParis(sig.signed_at) }));
    }
    if (st.state === 'expire') return res.status(410).send(signerMessagePage(company, 'Lien expiré', `Ce devis n'est plus valable à la signature. Contactez ${company.name} pour recevoir une version à jour.`));
    if (st.state !== 'ouvert') return res.status(404).send(signerMessagePage(company, 'Lien invalide', `Ce lien de signature n'est pas (ou plus) valable. Contactez ${company.name} si besoin.`));
    const q = st.quote;
    const totals = computeQuoteTotals(q.lines);
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'`);
    const email = q.prospect.email || '';
    const [u, d] = email.split('@');
    res.send(signerPage({
      company, quote: q, totals, schedule: computeSchedule(totals, q.deposit_pct), clientName: partyName(q.prospect),
      token: req.params.token, otp: st.otp, maskedEmail: d ? `${u.slice(0, 2)}•••@${d}` : '', nonce
    }));
  });
  signer.get('/:token/devis.pdf', (req, res) => {
    const q = wf.quoteByToken(req.params.token);
    if (!q?.original_pdf || !fs.existsSync(q.original_pdf)) return res.status(404).send('Document introuvable');
    sendPdf(res, fs.readFileSync(q.original_pdf), `Devis-${q.number}.pdf`);
  });
  signer.get('/:token/signe.pdf', (req, res) => {
    const q = wf.quoteByToken(req.params.token);
    if (!q?.signed_pdf || !fs.existsSync(q.signed_pdf)) return res.status(404).send('Le document signé est en cours de préparation : réessayez dans un instant.');
    sendPdf(res, fs.readFileSync(q.signed_pdf), `Devis-${q.number}-signe.pdf`, false);
  });
  signer.post('/:token/code', async (req, res) => {
    try { res.json(await wf.requestOtp(req.params.token)); } catch (e) { signerError(res, e); }
  });
  signer.post('/:token/sign', async (req, res) => {
    try {
      await wf.sign(req.params.token, req.body || {}, { ip: req.ip, userAgent: req.get('user-agent') });
      res.json({ ok: true });
    } catch (e) { signerError(res, e); }
  });
  app.use('/signer', signer);

  // --- Interface d'administration (fichiers statiques) ------------------------
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

  return { app, db, wf, config, mailer, close: async () => { await closeBrowser(); db.close(); } };
}

// Lancement direct : `npm start`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'src/server.js');
if (isMain) {
  let ctx;
  try {
    ctx = createApp();
  } catch (e) {
    console.error(`\n✖ ${e.message}\n`);
    process.exit(1);
  }
  const { app, config, mailer } = ctx;
  app.listen(config.port, () => {
    console.log(`\nAgent FRE2G démarré : ${config.baseUrl}`);
    console.log(`  E-mails : ${mailer.mode === 'smtp' ? `envoi réel via ${config.mail.host}` : `mode essai, écrits dans ${mailer.outboxDir}`}`);
    console.log(`  Rédaction par Claude : ${config.aiEnabled ? 'activée' : 'désactivée (ANTHROPIC_API_KEY absente)'}\n`);
  });
  const stop = async () => { await ctx.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

