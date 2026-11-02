'use strict';

// Conversion HTML → PDF avec un navigateur Chrome / Edge / Chromium installé sur la machine (sans téléchargement).
const fs = require('fs');

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: [
    '/opt/facturation-chrome/chrome-headless-shell',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium'
  ]
};

const NO_BROWSER = 'Export PDF indisponible : aucun navigateur Chrome, Edge ou Chromium n\'a été trouvé sur le serveur. ' +
  'Installez Google Chrome (ou indiquez son chemin avec la variable CHROME_PATH), ' +
  'ou utilisez « Aperçu » puis « Imprimer » → « Enregistrer au format PDF ».';

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const list = (CANDIDATES[process.platform] || CANDIDATES.linux).slice();
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    list.push(process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe');
  }
  return list.find((p) => fs.existsSync(p)) || null;
}

let browserPromise = null;
let idleTimer = null;
let active = 0;
const IDLE_MS = 5 * 60 * 1000; // le navigateur est fermé après 5 min sans export (mémoire du serveur)

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
    browserPromise = null;
  }
  const executablePath = findChrome();
  if (!executablePath) {
    const err = new Error(NO_BROWSER);
    err.status = 503;
    throw err;
  }
  const puppeteer = require('puppeteer-core');
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check']
  });
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active > 0 || !browserPromise) return;
    const p = browserPromise;
    browserPromise = null;
    try { (await p).close(); } catch { /* déjà fermé */ }
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/** Transforme une page HTML complète (pageHtml sans barre d'outils) en PDF A4. */
async function htmlToPdf(html) {
  active++;
  clearTimeout(idleTimer);
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    // Le document ne doit rien charger d'extérieur ni exécuter de script (modèles modifiables par l'utilisateur)
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') req.continue();
      else req.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 30000 });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => {});
    active--;
    scheduleClose();
  }
}

async function closeBrowser() {
  clearTimeout(idleTimer);
  const p = browserPromise;
  browserPromise = null;
  if (p) { try { (await p).close(); } catch { /* ignoré */ } }
}

module.exports = { htmlToPdf, findChrome, closeBrowser };
