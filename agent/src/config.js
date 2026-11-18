// Configuration technique, lue dans les variables d'environnement (fichier .env).
// Les informations de l'entreprise (adresse, SIRET, textes du devis…) se règlent
// dans l'écran « Paramètres » et sont stockées en base (voir db.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Chargement minimal d'un fichier .env (sans dépendance)
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;

export function loadConfig(overrides = {}) {
  const port = Number(overrides.port ?? env.PORT ?? 3000);
  const dataDir = path.resolve(ROOT, overrides.dataDir ?? env.DATA_DIR ?? 'data');
  const smtpHost = overrides.smtpHost ?? env.SMTP_HOST ?? '';
  return {
    port,
    baseUrl: (overrides.baseUrl ?? env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir,
    adminPassword: overrides.adminPassword ?? env.ADMIN_PASSWORD ?? '',
    sessionSecret: overrides.sessionSecret ?? env.SESSION_SECRET ?? '',
    mail: {
      // « smtp » envoie réellement ; « outbox » écrit les mails dans data/outbox (essais)
      mode: overrides.mailMode ?? env.MAIL_MODE ?? (smtpHost ? 'smtp' : 'outbox'),
      host: smtpHost,
      port: Number(env.SMTP_PORT ?? 587),
      secure: (env.SMTP_SECURE ?? 'false') === 'true',
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
      from: overrides.mailFrom ?? env.MAIL_FROM ?? 'FRE2G <contact@fre2g.fr>',
      // Adresse FRE2G qui reçoit les notifications internes (devis signé, etc.)
      notify: overrides.mailNotify ?? env.MAIL_NOTIFY ?? '',
      // Copie cachée de tous les mails envoyés aux clients et fournisseurs
      bcc: overrides.mailBcc ?? env.MAIL_BCC ?? ''
    },
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    aiEnabled: overrides.aiEnabled ?? Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    chromiumPath: env.CHROMIUM_PATH || undefined
  };
}
