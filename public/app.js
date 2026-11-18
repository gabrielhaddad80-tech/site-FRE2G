// Interface ADV FRE2G (sans framework).
const $ = (s, r = document) => r.querySelector(s);
const C = $("#contenu");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const eur = (n) => Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const dfr = (iso) => (iso ? new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("fr-FR") : "");
const badge = (s) => `<span class="badge ${esc(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;

async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.body && typeof opts.body === "object" ? { "Content-Type": "application/json" } : {}), ...opts.headers } };
  if (o.body && typeof o.body === "object") o.body = JSON.stringify(o.body);
  const r = await fetch(url, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.erreur || r.statusText);
  return data;
}
const post = (url, body = {}) => api(url, { method: "POST", body });
const essai = (fn) => async (...a) => { try { await fn(...a); } catch (e) { alert(e.message); } };

function modal(html) { $("#modal-corps").innerHTML = html + `<p style="text-align:right"><button class="b sec" id="fermer">Fermer</button></p>`; $("#fermer").onclick = () => $("#modal").close(); $("#modal").showModal(); }

function tableau(cols, rows, onClick) {
  if (!rows.length) return `<div class="vide">Aucun élément.</div>`;
  return `<table><thead><tr>${cols.map((c) => `<th class="${c.n ? "n" : ""}">${c.t}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) =>
    `<tr class="${onClick ? "clic" : ""}" data-i="${i}">${cols.map((c) => `<td class="${c.n ? "n" : ""}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function brancherClics(el, rows, onClick) { if (onClick) el.querySelectorAll("tr.clic").forEach((tr) => (tr.onclick = () => onClick(rows[tr.dataset.i]))); }

// ---------------------------------------------------------------------------
const VUES = {};

VUES.tableau = async () => {
  const { kpi, vigilance: v } = await api("/api/tableau-de-bord");
  const k = (l, val) => `<div class="kpi"><div class="l">${l}</div><div class="v">${val}</div></div>`;
  const bloc = (titre, rows, cols) => rows.length ? `<h2>${titre} (${rows.length})</h2><div class="carte">${tableau(cols, rows)}</div>` : "";
  C.innerHTML = `<h1>Tableau de bord</h1><div class="kpis">
    ${k("CA facturé du mois (HT)", eur(kpi.ca_facture_mois_ht))}${k("Prises de commande du mois (HT)", eur(kpi.commandes_mois_ht))}
    ${k("Encours clients (TTC)", eur(kpi.encours_clients_ttc))}${k("Dont en retard (TTC)", eur(kpi.retard_ttc))}
    ${k("Devis en attente", `${kpi.devis_en_attente} · ${eur(kpi.devis_en_attente_ht)}`)}${k("Commandes en cours", kpi.commandes_en_cours)}
    ${k("Commandes à facturer", kpi.commandes_a_facturer)}${k("Taux de transformation devis", kpi.taux_transformation_devis_pct == null ? "—" : kpi.taux_transformation_devis_pct + " %")}
    ${k("E-mails à valider", kpi.emails_a_valider)}</div>
    <div class="barre" style="margin-top:16px"><button class="b" id="routine">Lancer la routine de l'agent maintenant</button>
    <span class="vide">L'agent analyse les retards, prépare les relances et fait la synthèse.</span></div>
    ${bloc("Factures en retard", v.factures_en_retard, [{ t: "Facture", k: "numero" }, { t: "Client", k: "client" }, { t: "Échéance", f: (r) => dfr(r.echeance) }, { t: "Retard", f: (r) => r.jours_retard + " j" }, { t: "Reste dû", n: 1, f: (r) => eur(r.reste) }, { t: "Relances", k: "nb_relances" }])}
    ${bloc("Devis sans réponse", v.devis_sans_reponse, [{ t: "Devis", k: "numero" }, { t: "Client", k: "client" }, { t: "Envoyé il y a", f: (r) => r.age_jours + " j" }, { t: "Montant HT", n: 1, f: (r) => eur(r.total_ht) }])}
    ${bloc("Commandes à confirmer", v.commandes_a_confirmer, [{ t: "Commande", k: "numero" }, { t: "Client", k: "client" }, { t: "Date", f: (r) => dfr(r.date) }, { t: "HT", n: 1, f: (r) => eur(r.total_ht) }])}
    ${bloc("Livraisons en retard", v.livraisons_en_retard, [{ t: "Commande", k: "numero" }, { t: "Client", k: "client" }, { t: "Prévue le", f: (r) => dfr(r.date_livraison_prevue) }, { t: "Statut", f: (r) => badge(r.statut) }])}
    ${bloc("Commandes livrées à facturer", v.commandes_a_facturer, [{ t: "Commande", k: "numero" }, { t: "Client", k: "client" }, { t: "TTC", n: 1, f: (r) => eur(r.total_ttc) }])}`;
  $("#routine").onclick = essai(async (e) => {
    e.target.disabled = true; e.target.textContent = "L'agent travaille…";
    try { const r = await post("/api/agent/routine"); ouvrirConversation = r.conversation_id; afficher("agent"); }
    finally { e.target.disabled = false; }
  });
};

// ---------- Agent ----------
let ouvrirConversation = null;
VUES.agent = async () => {
  let convId = ouvrirConversation; ouvrirConversation = null;
  let pieces = [];
  C.innerHTML = `<h1>Agent ADV</h1><div class="agent">
    <div class="carte convs" id="convs"></div>
    <div class="chat"><div id="fil"></div>
      <div class="suggestions">
        ${["Où en sommes-nous aujourd'hui ? Quelles sont les priorités ?", "Prépare les relances des factures en retard",
          "Fais un devis pour Client Démo SARL : 10 PRD-001 et la livraison", "Quelles commandes doivent être livrées cette semaine ?"].map((s) => `<button>${esc(s)}</button>`).join("")}
      </div>
      <div class="saisie">
        <label class="b sec" title="Joindre un bon de commande (PDF, image, texte)">📎<input type="file" id="fichier" hidden multiple accept=".pdf,image/*,.txt,.csv,.eml"></label>
        <textarea id="msg" rows="2" placeholder="Demandez à l'agent… ou collez un e-mail / bon de commande client (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"></textarea>
        <button class="b" id="envoyer">Envoyer</button>
      </div></div></div>`;
  const fil = $("#fil");
  const ajout = (m) => {
    const d = document.createElement("div");
    if (m.type === "action") { d.className = "msg action"; d.textContent = "⚙ " + m.outil.replace(/_/g, " ") + resumeEntree(m.entree); }
    else if (m.type === "erreur") { d.className = "msg erreur"; d.textContent = "⚠ " + m.texte; }
    else if (m.type === "piece_jointe") { d.className = "msg " + m.role; d.textContent = "📎 pièce jointe"; }
    else { d.className = "msg " + m.role; d.textContent = m.texte; }
    fil.appendChild(d); fil.scrollTop = fil.scrollHeight;
  };
  const chargerListe = async () => {
    const convs = await api("/api/conversations");
    $("#convs").innerHTML = `<button class="b" id="nouvelle" style="width:100%;margin-bottom:8px">+ Nouvelle conversation</button>` +
      convs.map((c) => `<div data-id="${c.id}" class="${c.id === convId ? "actif" : ""}">${esc(c.titre)}<small>${esc(c.origine)} · ${esc(c.updated_at)}</small></div>`).join("");
    $("#nouvelle").onclick = () => { convId = null; fil.innerHTML = accueil(); chargerListe(); };
    $("#convs").querySelectorAll("div[data-id]").forEach((d) => (d.onclick = () => charger(Number(d.dataset.id))));
  };
  const accueil = () => `<div class="vide">Bonjour 👋 Je suis l'agent ADV. Je peux créer devis, commandes et factures, suivre les livraisons, enregistrer les règlements, préparer les e-mails clients et les relances. Collez-moi un e-mail ou joignez un bon de commande.</div>`;
  const charger = async (id) => { convId = id; const c = await api("/api/conversations/" + id); fil.innerHTML = ""; c.messages.forEach(ajout); chargerListe(); };
  const envoyer = essai(async () => {
    const texte = $("#msg").value.trim();
    if (!texte && !pieces.length) return;
    ajout({ role: "user", type: "texte", texte: texte + (pieces.length ? `\n📎 ${pieces.map((p) => p.nom).join(", ")}` : "") });
    $("#msg").value = ""; $("#envoyer").disabled = true;
    const attente = document.createElement("div"); attente.className = "msg action"; attente.textContent = "L'agent travaille…"; fil.appendChild(attente);
    try {
      const r = await post("/api/agent", { conversation_id: convId, message: texte, pieces_jointes: pieces });
      pieces = []; convId = r.conversation_id; attente.remove();
      r.nouveaux.filter((m) => m.role !== "user").forEach(ajout);
      if (r.fin === "refus") ajout({ type: "erreur", texte: "Le modèle a refusé de traiter cette demande." });
      if (r.fin === "limite_tours") ajout({ type: "erreur", texte: "Tâche interrompue (trop d'étapes). Demandez à l'agent de continuer." });
      chargerListe(); majCompteur();
    } catch (e) { attente.remove(); throw e; } finally { $("#envoyer").disabled = false; }
  });
  $("#envoyer").onclick = envoyer;
  $("#msg").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); envoyer(); } };
  C.querySelectorAll(".suggestions button").forEach((b) => (b.onclick = () => { $("#msg").value = b.textContent; $("#msg").focus(); }));
  $("#fichier").onchange = async (e) => {
    for (const f of e.target.files) {
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.readAsDataURL(f); });
      pieces.push({ nom: f.name, type_mime: f.type || (f.name.endsWith(".eml") ? "text/plain" : ""), base64: b64 });
    }
    $("#msg").placeholder = `📎 ${pieces.map((p) => p.nom).join(", ")} — ajoutez une consigne (facultatif)`;
  };
  await chargerListe();
  if (convId) charger(convId); else fil.innerHTML = accueil();
};
function resumeEntree(e = {}) {
  const k = ["recherche", "raison_sociale", "devis", "commande", "facture", "document", "statut", "objet", "type"].filter((x) => e[x] !== undefined);
  return k.length ? " — " + k.map((x) => `${x}: ${e[x]}`).join(", ") : "";
}

// ---------- Boîte d'envoi ----------
VUES.envoi = async () => {
  const filtre = sessionStorage.getItem("filtre-envoi") ?? "a_valider";
  const mails = await api("/api/emails" + (filtre ? "?statut=" + filtre : ""));
  const statut = await api("/api/statut");
  C.innerHTML = `<h1>Boîte d'envoi</h1>
    ${statut.smtp_configure ? "" : `<div class="carte" style="color:var(--warn)">SMTP non configuré : les e-mails validés sont marqués « envoyés » sans partir réellement (mode simulation). Voir le guide.</div>`}
    <div class="barre"><select id="filtre">${[["a_valider", "À valider"], ["envoye", "Envoyés"], ["rejete", "Rejetés"], ["erreur", "En erreur"], ["", "Tous"]].map(([v, l]) => `<option value="${v}" ${v === filtre ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div id="mails">${mails.length ? "" : `<div class="vide">Aucun e-mail.</div>`}</div>`;
  $("#filtre").onchange = (e) => { sessionStorage.setItem("filtre-envoi", e.target.value); VUES.envoi(); };
  for (const m of mails) {
    const d = document.createElement("div"); d.className = "carte";
    const editable = m.statut === "a_valider" || m.statut === "erreur";
    d.innerHTML = `<div class="barre">${badge(m.statut)} <b>${esc(m.client || "")}</b> → <input value="${esc(m.destinataire)}" class="dest" ${editable ? "" : "disabled"} size="32">
      <span class="vide">${esc(m.motif || "")} · ${esc(m.created_at)}</span>
      ${m.doc_type ? `<a class="b sec" target="_blank" href="/doc/${m.doc_type}/${m.doc_id}">Voir le document joint</a>` : ""}</div>
      <input class="obj" value="${esc(m.objet)}" style="width:100%;margin-bottom:6px" ${editable ? "" : "disabled"}>
      <textarea class="corps" rows="9" ${editable ? "" : "disabled"}>${esc(m.corps)}</textarea>
      ${m.erreur ? `<div class="vide">${esc(m.erreur)}</div>` : ""}
      ${editable ? `<div class="barre" style="margin-top:8px"><button class="b ok">Valider et envoyer</button><button class="b sec rej">Rejeter</button></div>` : ""}`;
    if (editable) {
      d.querySelector(".ok").onclick = essai(async (e) => {
        e.target.disabled = true;
        await post(`/api/emails/${m.id}`, { objet: d.querySelector(".obj").value, corps: d.querySelector(".corps").value, destinataire: d.querySelector(".dest").value });
        await post(`/api/emails/${m.id}/envoyer`); VUES.envoi(); majCompteur();
      });
      d.querySelector(".rej").onclick = essai(async () => { await post(`/api/emails/${m.id}/rejeter`); VUES.envoi(); majCompteur(); });
    }
    $("#mails").appendChild(d);
  }
};

// ---------- Documents ----------
const STATUTS = {
  devis: ["", "brouillon", "envoye", "accepte", "refuse", "expire"],
  commandes: ["", "recue", "confirmee", "en_preparation", "expediee", "livree", "facturee", "annulee"],
  factures: ["", "emise", "partiellement_payee", "payee", "en_retard", "annulee"],
};
const SING = { devis: "devis", commandes: "commande", factures: "facture" };
function vueDocs(type, titre) {
  return async (q = "", statut = "") => {
    const rows = await api(`/api/${type}?q=${encodeURIComponent(q)}&statut=${statut}`);
    const cols = [{ t: "Numéro", k: "numero" }, { t: "Date", f: (r) => dfr(r.date) }, { t: "Client", k: "client" }, { t: "Statut", f: (r) => badge(r.statut) },
      ...(type === "commandes" ? [{ t: "Réf. client", k: "ref_client" }, { t: "Livraison prévue", f: (r) => dfr(r.date_livraison_prevue) }] : []),
      ...(type === "factures" ? [{ t: "Échéance", f: (r) => dfr(r.echeance) }, { t: "Réglé", n: 1, f: (r) => eur(r.montant_paye) }] : []),
      { t: "HT", n: 1, f: (r) => eur(r.total_ht) }, { t: "TTC", n: 1, f: (r) => eur(r.total_ttc) }];
    C.innerHTML = `<h1>${titre}</h1><div class="barre"><input id="q" placeholder="Numéro ou client…" value="${esc(q)}">
      <select id="st">${STATUTS[type].map((s) => `<option value="${s}" ${s === statut ? "selected" : ""}>${s ? s.replace(/_/g, " ") : "Tous statuts"}</option>`).join("")}</select>
      <span class="vide">Pour créer : demandez à l'agent (« fais un devis pour… », « enregistre la commande jointe »).</span></div>
      <div class="carte" id="liste">${tableau(cols, rows, true)}</div>`;
    brancherClics($("#liste"), rows, (r) => ficheDoc(SING[type], r.id, () => VUES[type](q, statut)));
    let t; $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => VUES[type](e.target.value, $("#st").value).then(() => { $("#q").focus(); $("#q").setSelectionRange(99, 99); }), 300); };
    $("#st").onchange = (e) => VUES[type]($("#q").value, e.target.value);
  };
}
VUES.devis = vueDocs("devis", "Devis");
VUES.commandes = vueDocs("commandes", "Commandes");
VUES.factures = vueDocs("factures", "Factures");

async function ficheDoc(type, id, rafraichir) {
  const url = { devis: "devis", commande: "commandes", facture: "factures" }[type];
  const d = await api(`/api/${url}/${id}`);
  const actions = [];
  if (type === "devis" && !d.commande_id) {
    if (d.statut === "brouillon") actions.push(["Marquer envoyé", () => post(`/api/devis/${id}/statut`, { statut: "envoye" })]);
    if (!["refuse", "expire"].includes(d.statut)) actions.push(["Accepté → créer la commande", () => post(`/api/devis/${id}/commande`, { ref_client: prompt("N° de commande du client (facultatif)") || undefined })]);
    if (!["refuse"].includes(d.statut)) actions.push(["Refusé", () => post(`/api/devis/${id}/statut`, { statut: "refuse" })]);
  }
  if (type === "commande") {
    const suiv = { recue: ["confirmee", "annulee"], confirmee: ["en_preparation", "expediee", "livree", "annulee"], en_preparation: ["expediee", "livree", "annulee"], expediee: ["livree"] }[d.statut] || [];
    suiv.forEach((s) => actions.push([`→ ${s.replace(/_/g, " ")}`, () => {
      const extra = s === "expediee" ? { transporteur: prompt("Transporteur ?") || undefined, numero_suivi: prompt("N° de suivi ?") || undefined } : {};
      return post(`/api/commandes/${id}/maj`, { statut: s, ...extra });
    }]));
    if (d.statut === "livree") actions.push(["Facturer", () => post(`/api/commandes/${id}/facturer`)]);
  }
  if (type === "facture" && !["payee", "annulee"].includes(d.statut)) {
    actions.push(["Enregistrer un règlement", () => {
      const m = prompt(`Montant reçu (TTC) — reste dû ${eur(d.reste_a_payer)}`, d.reste_a_payer);
      if (!m) return Promise.resolve();
      return post(`/api/factures/${id}/paiement`, { montant: Number(m.replace(",", ".")), mode: prompt("Mode (virement, chèque…)", "virement") || undefined });
    }]);
  }
  modal(`<h2 style="margin-top:0">${esc(d.numero)} ${badge(d.statut)}</h2>
    <p><b>${esc(d.client.raison_sociale)}</b> · ${esc(d.client.email || "")}<br>Date : ${dfr(d.date)}
    ${d.ref_client ? " · Réf. client : " + esc(d.ref_client) : ""}${d.date_livraison_prevue ? " · Livraison : " + dfr(d.date_livraison_prevue) : ""}
    ${d.echeance ? " · Échéance : " + dfr(d.echeance) : ""}${d.numero_suivi ? " · Suivi : " + esc(d.transporteur || "") + " " + esc(d.numero_suivi) : ""}</p>
    ${tableau([{ t: "Réf.", k: "reference" }, { t: "Désignation", k: "designation" }, { t: "Qté", n: 1, f: (l) => l.quantite + " " + l.unite }, { t: "PU HT", n: 1, f: (l) => eur(l.prix_ht) }, { t: "Remise", n: 1, f: (l) => (l.remise_pct ? l.remise_pct + " %" : "") }], d.lignes)}
    <p style="text-align:right">HT ${eur(d.total_ht)} · TVA ${eur(d.total_tva)} · <b>TTC ${eur(d.total_ttc)}</b>${d.reste_a_payer !== undefined ? `<br>Reste à payer : <b>${eur(d.reste_a_payer)}</b>` : ""}</p>
    ${d.notes ? `<p class="vide" style="white-space:pre-wrap">${esc(d.notes)}</p>` : ""}
    <div class="barre"><a class="b sec" target="_blank" href="/doc/${type}/${id}">Imprimer / PDF</a>${actions.map((a, i) => `<button class="b" data-a="${i}">${esc(a[0])}</button>`).join("")}</div>`);
  $("#modal-corps").querySelectorAll("button[data-a]").forEach((b) => (b.onclick = essai(async () => {
    await actions[b.dataset.a][1](); $("#modal").close(); rafraichir?.();
  })));
}

// ---------- Clients ----------
const CHAMPS_CLIENT = [["raison_sociale", "Raison sociale *"], ["contact", "Contact"], ["email", "E-mail"], ["telephone", "Téléphone"], ["adresse", "Adresse"],
  ["code_postal", "Code postal"], ["ville", "Ville"], ["pays", "Pays"], ["siret", "SIRET"], ["tva_intra", "TVA intracom."], ["delai_paiement_jours", "Délai de paiement (jours)"], ["remise_pct", "Remise par défaut (%)"], ["notes", "Notes"]];
function formulaire(champs, valeurs, onSave) {
  modal(`<div class="grille">${champs.map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(valeurs[k] ?? "")}"></label>`).join("")}</div>
    <p><button class="b" id="sauver">Enregistrer</button></p>`);
  $("#sauver").onclick = essai(async () => {
    const data = { ...valeurs };
    $("#modal-corps").querySelectorAll("input[name]").forEach((i) => { data[i.name] = i.value === "" ? null : i.value; });
    await onSave(data); $("#modal").close();
  });
}
function importCSV(type, apres) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".csv,text/csv";
  inp.onchange = essai(async () => {
    const r = await fetch(`/api/import/${type}`, { method: "POST", body: await inp.files[0].text(), headers: { "Content-Type": "text/csv" } }).then((x) => x.json());
    alert(`${r.importes} ligne(s) importée(s).` + (r.erreurs?.length ? "\n\nErreurs :\n" + r.erreurs.slice(0, 20).join("\n") : ""));
    apres();
  });
  inp.click();
}
VUES.clients = async (q = "") => {
  const rows = await api("/api/clients?q=" + encodeURIComponent(q));
  C.innerHTML = `<h1>Clients</h1><div class="barre"><input id="q" placeholder="Rechercher…" value="${esc(q)}"><button class="b" id="nouveau">+ Nouveau client</button>
    <button class="b sec" id="imp">Importer un CSV</button><a class="b sec" href="/modele-clients.csv" download>Modèle CSV</a></div>
    <div class="carte" id="liste">${tableau([{ t: "Code", k: "code" }, { t: "Raison sociale", k: "raison_sociale" }, { t: "Contact", k: "contact" }, { t: "E-mail", k: "email" }, { t: "Ville", k: "ville" }, { t: "Délai", f: (r) => r.delai_paiement_jours + " j" }], rows, true)}</div>`;
  const save = async (d) => { await post("/api/clients", d); VUES.clients(q); };
  brancherClics($("#liste"), rows, (r) => formulaire(CHAMPS_CLIENT, r, save));
  $("#nouveau").onclick = () => formulaire(CHAMPS_CLIENT, { delai_paiement_jours: 30, pays: "France" }, save);
  $("#imp").onclick = () => importCSV("clients", () => VUES.clients());
  let t; $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => VUES.clients(e.target.value).then(() => $("#q").focus()), 300); };
};

// ---------- Catalogue ----------
const CHAMPS_PRODUIT = [["reference", "Référence *"], ["designation", "Désignation *"], ["unite", "Unité"], ["prix_ht", "Prix HT *"], ["tva_taux", "TVA (%)"], ["stock", "Stock"], ["delai_jours", "Délai (jours)"]];
VUES.produits = async () => {
  const rows = await api("/api/produits");
  C.innerHTML = `<h1>Catalogue</h1><div class="barre"><button class="b" id="nouveau">+ Nouveau produit</button>
    <button class="b sec" id="imp">Importer un CSV</button><a class="b sec" href="/modele-produits.csv" download>Modèle CSV</a></div>
    <div class="carte" id="liste">${tableau([{ t: "Référence", k: "reference" }, { t: "Désignation", k: "designation" }, { t: "Unité", k: "unite" }, { t: "Prix HT", n: 1, f: (r) => eur(r.prix_ht) }, { t: "TVA", n: 1, f: (r) => r.tva_taux + " %" }, { t: "Stock", n: 1, k: "stock" }, { t: "Délai", n: 1, f: (r) => (r.delai_jours != null ? r.delai_jours + " j" : "") }], rows, true)}</div>`;
  const save = async (d) => { await post("/api/produits", { ...d, prix_ht: Number(String(d.prix_ht).replace(",", ".")), tva_taux: d.tva_taux == null ? 20 : Number(d.tva_taux), stock: d.stock == null ? null : Number(d.stock), delai_jours: d.delai_jours == null ? null : Number(d.delai_jours) }); VUES.produits(); };
  brancherClics($("#liste"), rows, (r) => formulaire(CHAMPS_PRODUIT, r, save));
  $("#nouveau").onclick = () => formulaire(CHAMPS_PRODUIT, { unite: "u", tva_taux: 20 }, save);
  $("#imp").onclick = () => importCSV("produits", () => VUES.produits());
};

// ---------- Journal ----------
VUES.journal = async () => {
  const rows = await api("/api/journal");
  C.innerHTML = `<h1>Journal d'activité</h1><div class="carte">${tableau([{ t: "Date", k: "date" }, { t: "Par", k: "acteur" }, { t: "Action", k: "action" }, { t: "Détails", f: (r) => `<span style="white-space:normal">${esc(r.details)}</span>` }], rows)}</div>`;
};

// ---------------------------------------------------------------------------
async function majCompteur() {
  try { const m = await api("/api/emails?statut=a_valider"); $("#nb-envoi").textContent = m.length || ""; } catch {}
}
async function afficher(vue) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("actif", b.dataset.vue === vue));
  try { sessionStorage.setItem("vue", vue); } catch {}
  C.innerHTML = `<div class="vide">Chargement…</div>`;
  try { await VUES[vue](); } catch (e) { C.innerHTML = `<div class="carte" style="color:var(--ko)">${esc(e.message)}</div>`; }
}
document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => afficher(b.dataset.vue)));
api("/api/statut").then((s) => {
  $("#etat").innerHTML = `Agent : ${s.agent_configure ? "✅ actif" : "❌ clé API manquante"}<br>E-mails : ${s.smtp_configure ? "✅ SMTP" : "⚠ simulation"}${s.envoi_auto ? " (auto)" : ""}<br>Routine : ${esc(s.routine)}`;
});
majCompteur();
let initiale = "tableau"; try { initiale = sessionStorage.getItem("vue") || "tableau"; } catch {}
afficher(VUES[initiale] ? initiale : "tableau");
