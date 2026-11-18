// Page publique de signature, ouverte par le client depuis le lien reçu par e-mail.
import Handlebars from 'handlebars';
import { formatMoney } from './money.js';
import { formatDateFr } from './util.js';

const esc = Handlebars.Utils.escapeExpression;

function shell(title, company, body, script = '') {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--navy:#0f2747;--red:#d62839;--bg:#f1f3f6;--line:#dfe3e9;--muted:#6b7686;--ok:#17885a;--ok-bg:#e1f4ea;--err:#d33a4a;--err-bg:#fde7ea}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#16202e;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:var(--navy);color:#fff;padding:14px 16px}header .in{max-width:880px;margin:0 auto;display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px}
header .logo{width:32px;height:32px;border-radius:9px;background:var(--red);display:grid;place-items:center;font-style:italic}
main{max-width:880px;margin:0 auto;padding:18px 16px 60px}
.card{background:#fff;border-radius:16px;padding:18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(15,39,71,.08)}
h1{font-size:22px;margin:0 0 6px;color:var(--navy)}h2{font-size:17px;margin:0 0 10px;color:var(--navy)}
.muted{color:var(--muted)}.big{font-size:24px;font-weight:800;color:var(--navy)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}.kv div:nth-child(odd){color:var(--muted)}
iframe.pdf{width:100%;height:70vh;border:1px solid var(--line);border-radius:12px;background:#e5e5e5;margin-top:8px}
@media (max-width:700px){iframe.pdf{display:none}}
table.sum{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}table.sum th{text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);padding:6px 4px}
table.sum td{padding:6px 4px;border-bottom:1px solid #eef1f5;vertical-align:top}table.sum .r{text-align:right;white-space:nowrap}table.sum tfoot td{border:0;padding:3px 4px}table.sum tr.g td{font-weight:800;color:var(--navy);font-size:16px}
label{display:block;font-weight:600;margin:12px 0 4px}input[type=text],input[type=tel]{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px}
.check{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-weight:500}.check input{width:20px;height:20px;margin-top:2px}
canvas{width:100%;height:190px;border:1.5px dashed #9aa6b6;border-radius:12px;background:#fbfcfd;touch-action:none;display:block}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:999px;padding:12px 22px;cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--red);color:#fff}.secondary{background:#fff;color:var(--navy);border:1.5px solid var(--line)}
button:disabled{opacity:.55;cursor:not-allowed}
.msg{padding:10px 14px;border-radius:12px;margin-top:12px;display:none}.msg.err{display:block;background:var(--err-bg);color:var(--err)}.msg.ok{display:block;background:var(--ok-bg);color:var(--ok)}
.small{font-size:13px}
</style></head><body><header><div class="in"><div class="logo">${esc(String(company.name || 'F').charAt(0))}</div>${esc(company.name)}</div></header><main>${body}</main>${script}</body></html>`;
}

export function signerMessagePage(company, title, text, extra = '') {
  return shell(title, company, `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}</div>`);
}

export function signerPage({ company, quote, totals, schedule, clientName, token, otp, maskedEmail, nonce }) {
  const base = `/signer/${encodeURIComponent(token)}`;
  const body = `
<div class="card">
  <h1>Devis N° ${esc(quote.number)}</h1>
  <p class="muted">${esc(quote.object || '')}</p>
  <div class="kv">
    <div>Client</div><div>${esc(clientName)}</div>
    <div>Date du devis</div><div>${esc(formatDateFr(quote.date))}</div>
    <div>Montant</div><div><span class="big">${esc(formatMoney(totals.ttc))}</span> TTC <span class="muted">(${esc(formatMoney(totals.ht))} HT)</span></div>
    ${schedule.deposit_pct > 0 ? `<div>Acompte à la commande</div><div>${esc(formatMoney(schedule.deposit_ttc))}</div>` : ''}
  </div>
</div>
<div class="card">
  <h2>1. Lisez le devis</h2>
  <p><a class="btn secondary" href="${base}/devis.pdf" target="_blank" rel="noopener">Ouvrir le devis complet (PDF)</a></p>
  <iframe class="pdf" src="${base}/devis.pdf" title="Devis N° ${esc(quote.number)}"></iframe>
  <table class="sum">
    <thead><tr><th>Poste</th><th class="r">Qté</th><th class="r">Total HT</th></tr></thead>
    <tbody>${totals.lines.map((l) => `<tr><td>${esc(l.designation)}</td><td class="r">${esc(String(l.qty).replace('.', ','))}</td><td class="r">${esc(formatMoney(l.total_ht))}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2">Total HT</td><td class="r">${esc(formatMoney(totals.ht))}</td></tr>
    ${totals.vat.map((g) => `<tr><td colspan="2">TVA ${esc(String(g.rate).replace('.', ','))} %</td><td class="r">${esc(formatMoney(g.amount))}</td></tr>`).join('')}
    <tr class="g"><td colspan="2">Total TTC</td><td class="r">${esc(formatMoney(totals.ttc))}</td></tr></tfoot>
  </table>
</div>
<form class="card" id="f" novalidate>
  <h2>2. Signez</h2>
  <label for="name">Vos nom et prénom</label>
  <input type="text" id="name" name="name" autocomplete="name" required>
  <label for="quality">Qualité <span class="muted">(si vous signez pour une société : gérant, directeur…)</span></label>
  <input type="text" id="quality" name="quality" autocomplete="organization-title">
  <label for="mention">Recopiez la mention « Bon pour accord »</label>
  <input type="text" id="mention" name="mention" autocomplete="off" required>
  <label>Votre signature <span class="muted">(avec le doigt ou la souris)</span></label>
  <canvas id="pad" aria-label="Zone de signature"></canvas>
  <div class="row" style="margin-top:6px"><button type="button" class="secondary" id="clear">Effacer</button></div>
  <label class="check"><input type="checkbox" id="accept" name="accept"> <span>J'ai lu le devis N° ${esc(quote.number)} et je l'accepte, ainsi que ses conditions (montant, échéancier, délai, garantie).</span></label>
  ${otp ? `
  <label for="code">Code de vérification reçu par e-mail</label>
  <div class="row"><input type="tel" id="code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="max-width:180px">
  <button type="button" class="secondary" id="sendcode">Recevoir mon code</button></div>
  <p class="small muted">Le code est envoyé à ${esc(maskedEmail)}.</p>` : ''}
  <div class="row" style="margin-top:14px"><button type="submit" class="primary" id="submit">Signer le devis</button></div>
  <div class="msg" id="msg" role="status"></div>
  <p class="small muted" style="margin-top:14px">En signant, vous apposez une signature électronique (art. 1367 du Code civil). Sont enregistrés : vos nom, la date et l'heure, votre adresse IP et votre navigateur. Une copie du devis signé vous est envoyée par e-mail.</p>
</form>`;

  const script = `<script nonce="${nonce}">
(function(){
  var base=${JSON.stringify(base)};
  var pad=document.getElementById('pad'),ctx=pad.getContext('2d'),drawing=false,drawn=false,last=null;
  function size(){var r=pad.getBoundingClientRect(),d=window.devicePixelRatio||1;var img=drawn?pad.toDataURL():null;pad.width=r.width*d;pad.height=r.height*d;ctx.scale(d,d);ctx.lineWidth=2.4;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#0f2747';if(img){var i=new Image();i.onload=function(){ctx.drawImage(i,0,0,r.width,r.height)};i.src=img;}}
  size();window.addEventListener('resize',size);
  function pos(e){var r=pad.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
  pad.addEventListener('pointerdown',function(e){drawing=true;last=pos(e);pad.setPointerCapture(e.pointerId)});
  pad.addEventListener('pointermove',function(e){if(!drawing)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;drawn=true});
  ['pointerup','pointercancel','pointerleave'].forEach(function(t){pad.addEventListener(t,function(){drawing=false})});
  document.getElementById('clear').onclick=function(){ctx.clearRect(0,0,pad.width,pad.height);drawn=false};
  var msg=document.getElementById('msg');
  function show(t,ok){msg.textContent=t;msg.className='msg '+(ok?'ok':'err')}
  async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});var j=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(j.error||'Erreur '+r.status);return j}
  var sc=document.getElementById('sendcode');
  if(sc){sc.onclick=async function(){sc.disabled=true;try{var j=await post(base+'/code');show('Code envoyé à '+j.sent_to+'. Vérifiez vos courriers indésirables si besoin.',true)}catch(e){show(e.message)}setTimeout(function(){sc.disabled=false},30000)}}
  document.getElementById('f').addEventListener('submit',async function(e){
    e.preventDefault();var b=document.getElementById('submit');
    if(!drawn){show('Tracez votre signature dans le cadre.');return}
    b.disabled=true;b.textContent='Signature en cours…';
    try{
      await post(base+'/sign',{name:document.getElementById('name').value,quality:document.getElementById('quality').value,mention:document.getElementById('mention').value,accept:document.getElementById('accept').checked,code:(document.getElementById('code')||{}).value||'',signature:pad.toDataURL('image/png')});
      location.reload();
    }catch(err){show(err.message);b.disabled=false;b.textContent='Signer le devis'}
  });
})();
</script>`;
  return shell(`Signature du devis N° ${quote.number}`, company, body, script);
}

export function signedPage({ company, quote, token, signedAtText }) {
  const base = `/signer/${encodeURIComponent(token)}`;
  return shell(`Devis N° ${quote.number} signé`, company, `
<div class="card">
  <h1>Merci, votre devis est signé ✅</h1>
  <p>Le devis N° ${esc(quote.number)} a été signé le ${esc(signedAtText)}. Vous allez recevoir par e-mail l'exemplaire signé, puis la facture d'acompte.</p>
  <p><a class="btn primary" href="${base}/signe.pdf">Télécharger le devis signé</a></p>
  <p class="muted">Nous planifions votre installation dès réception de l'acompte. À très bientôt !</p>
</div>`);
}
