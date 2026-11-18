import crypto from 'node:crypto';

// Date du jour à Paris, au format AAAA-MM-JJ
export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function formatDateFr(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

export function formatDateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// Date et heure à Paris pour les preuves de signature
export function formatDateTimeParis(isoDateTime) {
  const d = isoDateTime ? new Date(isoDateTime) : new Date();
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'medium'
  }).format(d) + ' (heure de Paris)';
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function slug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document';
}

// Nom affiché d'un client ou d'un prospect
export function partyName(p) {
  if (!p) return '';
  const person = [p.civility, p.first_name, p.last_name].filter(Boolean).join(' ');
  if (p.kind === 'professionnel' && p.company) return person ? `${p.company} (${person})` : p.company;
  return person || p.company || '';
}

export function partyAddress(p) {
  if (!p) return '';
  return [p.address, [p.postal_code, p.city].filter(Boolean).join(' ')].filter(Boolean).join('\n');
}

// Formule d'appel de la lettre : « Madame, », « Monsieur, », « Madame, Monsieur, »
export function defaultGreeting(p) {
  if (p?.civility === 'Mme') return 'Madame,';
  if (p?.civility === 'M.') return 'Monsieur,';
  return 'Madame, Monsieur,';
}

export function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}
