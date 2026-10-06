'use strict';

/*
 * Découpage des catalogues PDF par paquets de pages, sans bloquer le logiciel.
 * - qpdf (installé sur le serveur) : programme externe rapide et économe en mémoire ; lève aussi les
 *   restrictions « copie / impression » posées par les éditeurs de catalogues.
 * - à défaut (installation locale sans qpdf) : pdf-lib, réservé aux fichiers de taille raisonnable,
 *   car il charge tout le document en mémoire.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FALLBACK_MAX = 25 * 1024 * 1024;

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // qpdf : code 3 = avertissements (fichier un peu abîmé mais traité)
      if (err && err.code !== 3) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}

let qpdfAvailable = null;
async function hasQpdf() {
  if (qpdfAvailable === null) qpdfAvailable = await run('qpdf', ['--version'], 10000).then(() => true, () => false);
  return qpdfAvailable;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const PROTECTED = 'Ce PDF est protégé par un mot de passe. Ouvrez-le puis « Imprimer » → « Microsoft Print to PDF » '
  + '(ou « Enregistrer au format PDF ») pour en faire une copie lisible, et importez cette copie.';

/** Nombre de pages d'un PDF enregistré sur disque. */
async function countPages(file) {
  if (await hasQpdf()) {
    try {
      return parseInt(await run('qpdf', ['--show-npages', file], 60000), 10);
    } catch (e) {
      if (/password/i.test(e.stderr)) throw httpError(422, PROTECTED);
      throw httpError(400, 'PDF illisible : ' + (e.stderr || e.message).split('\n')[0].slice(0, 160));
    }
  }
  const size = fs.statSync(file).size;
  if (size > FALLBACK_MAX) {
    throw httpError(413, 'Ce PDF est trop volumineux pour cet ordinateur (25 Mo maximum sans l\'outil qpdf). Découpez-le ou installez qpdf.');
  }
  const { PDFDocument } = require('pdf-lib');
  try {
    return (await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false })).getPageCount();
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw httpError(422, PROTECTED);
    throw httpError(400, 'PDF illisible : ' + e.message.slice(0, 160));
  }
}

/** Pages from..to (incluses, à partir de 1) en PDF, encodé en base64. */
async function extractPages(file, from, to) {
  if (await hasQpdf()) {
    const out = path.join(os.tmpdir(), `fre2g-pages-${crypto.randomBytes(8).toString('hex')}.pdf`);
    try {
      await run('qpdf', ['--decrypt', '--object-streams=generate', file, '--pages', '.', `${from}-${to}`, '--', out]);
      return fs.readFileSync(out).toString('base64');
    } catch (e) {
      throw httpError(502, 'Découpage du PDF impossible : ' + (e.stderr || e.message).split('\n')[0].slice(0, 160));
    } finally {
      fs.rm(out, { force: true }, () => {});
    }
  }
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false });
  const doc = await PDFDocument.create();
  const idx = [];
  for (let i = from; i <= to; i++) idx.push(i - 1);
  for (const page of await doc.copyPages(src, idx)) doc.addPage(page);
  return Buffer.from(await doc.save()).toString('base64');
}

module.exports = { countPages, extractPages, hasQpdf };
