'use strict';
// Construit la démo en ligne : une page autonome où le serveur (src/) tourne dans le navigateur.
// Usage : cd demo && npm install && npm run build
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const APP = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'dist', 'facturation-demo.html');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const PAGE_FILES = ['index.html', 'tableau-de-bord.html', 'documents.html', 'document.html', 'clients.html', 'catalogue.html', 'modeles.html', 'parametres.html'];
const pages = {};
const scripts = [];
for (const f of PAGE_FILES) {
  const html = read('public/' + f);
  const main = html.match(/<main[\s\S]*?<\/main>/)[0];
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
  let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  script = script.replace(/location\.reload\(\)/g, "go(currentPage())");
  pages[f] = { main, style, title };
  scripts.push(`/* ${f} */\n${script}`);
}

const backend = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'entry.js')],
  bundle: true, format: 'iife', platform: 'browser', write: false, minify: true, target: 'es2020',
  absWorkingDir: __dirname,
  alias: {
    APP, 'better-sqlite3': './shims/sqlite.js', express: './shims/express.js', fs: './shims/fs.js',
    path: './shims/path.js', handlebars: './shims/handlebars.js'
  },
  define: { 'process.env.DB_FILE': 'undefined', 'process.env.NO_SEED': 'undefined', __dirname: '"/app/src"' }
}).outputFiles[0].text;

// Polices intégrées en data: URI (la page doit être autonome)
const fontsCss = read('public/css/fonts.css').replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (_, f) =>
  `url(data:font/woff2;base64,${fs.readFileSync(path.join(APP, 'public/fonts', f)).toString('base64')})`);

const files = { 'classique.hbs': read('templates/classique.hbs'), 'classique.css': read('templates/classique.css') };

const demoCss = `
#app { flex: 1; min-width: 0; }
#nav { top: env(safe-area-inset-top, 0px); }
.demo-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 8px 28px; background: var(--info-bg); color: var(--text); font-size: 13px; border-bottom: 1px solid var(--border); }
.demo-bar strong { color: var(--info); }
.demo-bar span { flex: 1 1 280px; min-width: 0; }
.print-modal .preview-frame { height: 76vh; }
@media (max-width: 760px) { .demo-bar { padding: 8px 16px; } }
`;

const out = `<title>FRE2G Facturation</title>
<style>
${fontsCss}
${read('public/css/app.css')}
${demoCss}
</style>
<nav id="nav" aria-label="Menu principal"></nav>
<div id="app">
  <div class="demo-bar" role="note"><strong>Démo en ligne</strong><span>Vos essais sont enregistrés dans ce navigateur uniquement. L'impression PDF et les téléchargements fonctionnent dans la version installée.</span><button type="button" id="demo-reset" class="small">Réinitialiser la démo</button></div>
  <div id="boot" class="empty">Chargement du logiciel…</div>
</div>
<script>
${read('public/js/common.js')}
</script>
<script>
${read('public/js/calc.js')}
</script>
<script>
${read('public/js/ai.js')}
</script>
<script>
${safe(scripts.join('\n'))}
</script>
<script>
window.__DEMO_FILES = ${safe(JSON.stringify(files))};
window.__PAGES = ${safe(JSON.stringify(pages))};
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/4.7.8/handlebars.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-asm.js"></script>
<script>
${safe(backend)}
</script>
<script>
${fs.readFileSync(path.join(__dirname, 'shell.js'), 'utf8')}
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/alpinejs/3.14.1/cdn.min.js"></script>
`;
fs.writeFileSync(OUT, out);
console.log('écrit', OUT, Math.round(out.length / 1024) + ' Ko');
