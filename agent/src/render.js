// Rendu des documents (Handlebars -> HTML -> PDF avec Chromium)
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { chromium } from 'playwright';
import { ROOT } from './config.js';
import { formatMoney, formatNumber, formatPct, toNumber, round2 } from './money.js';
import { formatDateFr, formatDateShort } from './util.js';

const TEMPLATES = path.join(ROOT, 'templates');
const hb = Handlebars.create();

hb.registerHelper('money', (v) => formatMoney(v));
hb.registerHelper('num', (v) => formatNumber(v));
hb.registerHelper('pct', (v) => formatPct(v));
hb.registerHelper('dateFr', (v) => formatDateFr(v));
hb.registerHelper('dateShort', (v) => formatDateShort(v));
hb.registerHelper('inc', (v) => Number(v) + 1);
hb.registerHelper('add', (a, b) => round2(toNumber(a) + toNumber(b)));
hb.registerHelper('initial', (v) => String(v || '?').trim().charAt(0).toUpperCase());
hb.registerHelper('eq', (a, b) => a === b);

hb.registerPartial('head', fs.readFileSync(path.join(TEMPLATES, 'partials-head.hbs'), 'utf8'));
hb.registerPartial('footer', fs.readFileSync(path.join(TEMPLATES, 'partials-footer.hbs'), 'utf8'));

const cache = new Map();
function template(name) {
  // Relecture à chaque fois en développement : les modèles restent modifiables sans redémarrage
  const file = path.join(TEMPLATES, name);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.fn;
  const fn = hb.compile(fs.readFileSync(file, 'utf8'));
  cache.set(file, { mtime, fn });
  return fn;
}

export function renderTemplate(name, context) {
  return template(name)(context);
}

export function documentHtml(templateName, context, title) {
  const css = fs.readFileSync(path.join(TEMPLATES, 'document.css'), 'utf8');
  const body = renderTemplate(templateName, context);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${hb.Utils.escapeExpression(title || '')}</title><style>${css}</style></head><body>${body}</body></html>`;
}

// Mails : première ligne « Subject: … », le reste est le corps HTML
export function renderEmail(name, context) {
  const raw = renderTemplate(`emails/${name}.hbs`, context);
  const nl = raw.indexOf('\n');
  const first = raw.slice(0, nl).trim();
  const subject = first.replace(/^Subject:\s*/i, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x3D;/g, '=');
  const body = raw.slice(nl + 1);
  const html = renderTemplate('emails/layout.hbs', { ...context, body });
  const text = body
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2 : $1')
    .replace(/<li>/g, '- ').replace(/<\/(p|li|tr|h\d)>/g, '\n').replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { subject, html, text };
}

// Un seul navigateur partagé, lancé à la première génération de PDF
let browserPromise = null;
export function setChromiumPath(p) { chromiumPath = p; }
let chromiumPath;

async function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ executablePath: chromiumPath }).catch((e) => {
      browserPromise = null;
      throw new Error(`Impossible de lancer Chromium pour générer les PDF (${e.message}). Lancez « npm run install-browser ».`);
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close();
  }
}

export async function htmlToPdf(html, footerLabel = '') {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:7px;color:#8a94a3;padding:0 13mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif;"><span>${hb.Utils.escapeExpression(footerLabel)}</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
    });
  } finally {
    await page.close();
  }
}
