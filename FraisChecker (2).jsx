import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

const IK_RATE = 0.45;

const SYSTEM_PROMPT = `Tu es un agent comptable expert en vérification de fiches de frais d'arbitres de rugby pour la Ligue des Hauts-de-France de Rugby (saison 2025-2026).

Analyse le document PDF fourni qui contient une convocation et/ou une fiche de frais d'un officiel de match.

GRILLE DES IRF (Indemnités Représentatives de Frais) selon la procédure officielle HDF:
- Arbitre de champ sur National U16/U18, Excellence B, Fédérale B, Fédérale 2 Féminine: 70€ (entité: FFR, via Oval-E)
- Arbitre de champ sur Régionale 1/2/3, Féminines X, Régional 1/2/3, U16/U19, Réserves R1/R2, Plateau U14, Cross Rugby, Challenge Fédéral M14 à XV: 70€ (entité: Ligue)
- Arbitre de champ sur Plateau Rugby à 7: 75€ (entité: Ligue)
- Arbitre de champ sur Match Amical/Loisirs/Tournois: 50€ (entité: Ligue, refacturé club)
- Arbitre Assistant (AA1 ou AA2) sur toutes phases régulières et finales: 60€ (entité: Ligue)
- Représentant Fédéral sur R1/R2/R3/Féminines/Régional 1-2/U16/U19/Réserves: 60€ (entité: Ligue)
- Représentant Fédéral sur Plateau U14: 50€ (entité: Ligue)
- Superviseur (tous niveaux Ligue y compris F2 et F3): 50€ (entité: Ligue)

Taux kilométrique officiel: 0,45 €/km appliqué sur le kilométrage RÉEL (pas le kilométrage arrondi +10%).
Sur la fiche, la ligne "Km parcourus A.R." indique d'abord le km réel (ex: 195 km) puis "Arrondi à (1): 201 km". Le calcul doit être fait sur le km RÉEL.

DÉLAI DE DÉPÔT : La fiche doit être transmise dans les 30 jours après la date du match. Si tu peux calculer la différence entre date_match et date_signature, indique true dans delai_depot_depasse si cette différence dépasse 30 jours, false sinon. Si les dates ne sont pas disponibles, indique false.

DOCUMENTS ATTENDUS — les 2 volets doivent être dans le même PDF:
- Volet 1 (convocation) : lettre officielle de désignation mentionnant l'officiel, son rôle, la rencontre, la date, les distances estimées. Émise par la Ligue ou la FFR.
- Volet 2 (fiche de frais) : formulaire FICHE DE DEPLACEMENT / FICHE DE FRAIS avec les cases remplies (km parcourus, IK, péages, IRF, total, signature).
Indique "true" pour chaque volet si tu le vois clairement dans le document, "false" sinon.

JUSTIFICATIFS DE PÉAGES : les tickets de péage (reçus Sanef, Vinci, etc.) peuvent apparaître comme pages supplémentaires dans le PDF. Indique "true" si tu vois des reçus/tickets de péage dans le document, "false" si des péages sont déclarés mais aucun justificatif n'est visible, "null" si aucun péage n'est déclaré.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte avant ou après:
{
  "officiel_nom": "NOM Prénom",
  "role": "Arbitre de champ|Arbitre Assistant 1|Arbitre Assistant 2|Représentant Fédéral|Superviseur|Inconnu",
  "competition": "ex: Régionale 2, Régional 1 U16, National U16, Fédérale 3...",
  "entite_payante": "FFR|Ligue|Inconnu",
  "date_match": "DD/MM/YYYY ou null",
  "date_signature": "DD/MM/YYYY ou null",
  "delai_depot_depasse": false,
  "equipe_domicile": "nom équipe domicile ou null",
  "equipe_visiteur": "nom équipe visiteur ou null",
  "numero_rencontre": "ex: 202526 13 2007 0061 RCT ou null",
  "km_reel": 0,
  "km_arrondi": 0,
  "km_utilises_calcul": 0,
  "ik_montant_declare": 0.0,
  "peages_montant_declare": 0.0,
  "sous_total_deplacement": 0.0,
  "irf_declare": 0.0,
  "irf_attendu": 0.0,
  "total_declare": 0.0,
  "signature_presente": true,
  "volet_convocation_present": true,
  "volet_fiche_frais_presente": true,
  "justificatifs_peages_presents": null,
  "anomalies_detectees": [],
  "observations": ""
}`;

function checkConformity(data) {
  const issues = [];
  const warnings = [];

  // FFR match = NON_CONFORME (hors circuit Ligue)
  if (data.entite_payante === "FFR") {
    issues.push("Match FFR : remboursement géré via Oval-E / FFR — cette fiche ne doit PAS être transmise à la Ligue HDF");
  }

  // IK basé sur km RÉEL (pas km arrondi)
  const kmRef = data.km_reel || data.km_utilises_calcul || 0;
  if (kmRef > 0 && data.ik_montant_declare != null) {
    const expected = Math.round(kmRef * IK_RATE * 100) / 100;
    if (Math.abs(expected - data.ik_montant_declare) > 0.10) {
      // Vérifier si l'arbitre a utilisé le km arrondi par erreur
      const withArrondi = data.km_arrondi ? Math.round(data.km_arrondi * IK_RATE * 100) / 100 : null;
      const usedArrondi = withArrondi && Math.abs(withArrondi - data.ik_montant_declare) < 0.10;
      if (usedArrondi) {
        issues.push(`IK calculé sur km arrondi (${data.km_arrondi} km) au lieu du km réel (${kmRef} km) — attendu : ${expected.toFixed(2)} €, déclaré : ${data.ik_montant_declare.toFixed(2)} €`);
      } else {
        issues.push(`IK incorrect : ${kmRef} km réels × 0,45 = ${expected.toFixed(2)} € (déclaré : ${data.ik_montant_declare.toFixed(2)} €)`);
      }
    }
  }

  // IRF
  if (data.irf_declare != null && data.irf_attendu != null && data.irf_declare !== data.irf_attendu) {
    issues.push(`IRF incorrect : déclaré ${data.irf_declare} €, attendu ${data.irf_attendu} € pour ce rôle/compétition`);
  }

  // Total
  if (data.sous_total_deplacement != null && data.irf_declare != null && data.total_declare != null) {
    const expected = Math.round((data.sous_total_deplacement + data.irf_declare) * 100) / 100;
    if (Math.abs(expected - data.total_declare) > 0.10) {
      issues.push(`Total incorrect : ${data.sous_total_deplacement.toFixed(2)} + ${data.irf_declare} = ${expected.toFixed(2)} € ≠ ${data.total_declare.toFixed(2)} €`);
    }
  }

  // Péages : non conformes si déclarés sans justificatifs (false) OU si non vérifiés (null avec montant > 0)
  if (data.peages_montant_declare > 0) {
    if (data.justificatifs_peages_presents === false) {
      issues.push(`Péages déclarés (${data.peages_montant_declare.toFixed(2)} €) mais aucun justificatif joint`);
    } else if (data.justificatifs_peages_presents === null) {
      warnings.push(`Péages déclarés (${data.peages_montant_declare.toFixed(2)} €) — présence des justificatifs non confirmée`);
    }
  }

  // Signature
  if (data.signature_presente === false) {
    issues.push("Signature absente");
  }

  // Délai de dépôt > 30 jours après le match
  if (data.delai_depot_depasse === true) {
    issues.push("Fiche transmise hors délai (> 30 jours après le match) — non prise en charge selon la procédure HDF");
  } else if (data.date_match && data.date_signature) {
    // Vérification JS en backup si le modèle ne l'a pas calculé
    const parseDate = s => { const [d,m,y] = s.split('/'); return new Date(y,m-1,d); };
    try {
      const dm = parseDate(data.date_match);
      const ds = parseDate(data.date_signature);
      const diff = Math.round((ds - dm) / 86400000);
      if (diff > 30) {
        issues.push(`Fiche transmise hors délai : ${diff} jours après le match (limite : 30 j) — non prise en charge selon la procédure HDF`);
      }
    } catch(e) {}
  }

  // Les 2 volets obligatoires
  if (data.volet_convocation_present === false) {
    issues.push("Volet 1 manquant : convocation / lettre de désignation non jointe");
  }
  if (data.volet_fiche_frais_presente === false) {
    issues.push("Volet 2 manquant : fiche de frais / fiche de déplacement non jointe");
  }

  // Convocation (ancien champ — compatibilité)
  if (data.convocation_presente === false && data.volet_convocation_present == null) {
    warnings.push("Convocation non jointe (les 2 volets doivent être présents en 1 PDF)");
  }

  (data.anomalies_detectees || []).forEach(a => {
    if (a && a.trim()) warnings.push(a);
  });

  return {
    status: issues.length > 0 ? "NON_CONFORME" : warnings.length > 0 ? "ATTENTION" : "CONFORME",
    issues,
    warnings,
  };
}

async function analyzeFile(base64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Analyse cette fiche de frais et retourne le JSON structuré." }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Erreur API ${res.status}`);
  const api = await res.json();
  const text = api.content?.find(b => b.type === "text")?.text || "{}";
  return JSON.parse(text.replace(/```json\n?|```/g, "").trim());
}

const S = {
  CONFORME:     { label: "Conforme",      bg: "#e8f5e9", color: "#2e7d32", dot: "#4caf50" },
  ATTENTION:    { label: "Attention",     bg: "#fff8e1", color: "#e65100", dot: "#ff9800" },
  NON_CONFORME: { label: "Non conforme", bg: "#ffebee", color: "#c62828", dot: "#f44336" },
};

const NAVY = "#002D5D";
const GREEN = "#97B732";

export default function FraisChecker() {
  const [fiches, setFiches] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState({});
  const fileRef = useRef(null);

  const processFiles = useCallback(async (fileList) => {
    const pdfs = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith(".pdf"));
    for (const file of pdfs) {
      const id = `${file.name}-${Date.now()}-${Math.random()}`;
      setFiches(p => [...p, { id, fileName: file.name, status: "processing", data: null, conformity: null, error: null }]);
      try {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = e => res(e.target.result.split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        const data = await analyzeFile(b64);
        const conformity = checkConformity(data);
        setFiches(p => p.map(f => f.id === id ? { ...f, status: "done", data, conformity } : f));
      } catch (err) {
        setFiches(p => p.map(f => f.id === id ? { ...f, status: "error", error: err.message } : f));
      }
    }
  }, []);

  const onDrop = e => {
    e.preventDefault();
    setDragging(false);
    processFiles(e.dataTransfer.files);
  };

  const exportXLSX = () => {
    const rows = fiches.filter(f => f.status === "done" && f.data).map(f => {
      const d = f.data;
      const all = [...(f.conformity?.issues || []), ...(f.conformity?.warnings || [])];
      return {
        "A - Officiel": d.officiel_nom || "",
        "B - Rôle": d.role || "",
        "C - Compétition": d.competition || "",
        "D - Date du match": d.date_match || "",
        "E - Rencontre": [d.equipe_domicile, d.equipe_visiteur].filter(Boolean).join(" vs ") || "",
        "F - N° Rencontre": d.numero_rencontre || "",
        "G - TOTAL À VERSER (€)": d.entite_payante === "FFR" ? 0 : (d.total_declare || 0),
        "Statut": f.conformity?.status || "",
        "Anomalies / Observations": all.length ? all.join(" | ") : "RAS",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [28,22,24,14,44,26,20,14,70].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Récap frais");
    XLSX.writeFile(wb, `Recap_frais_HDF_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const done = fiches.filter(f => f.status === "done");
  const totalLigue = done.filter(f => f.data?.entite_payante === "Ligue").reduce((s, f) => s + (f.data?.total_declare || 0), 0);
  const counts = {
    CONFORME: done.filter(f => f.conformity?.status === "CONFORME").length,
    ATTENTION: done.filter(f => f.conformity?.status === "ATTENTION").length,
    NON_CONFORME: done.filter(f => f.conformity?.status === "NON_CONFORME").length,
  };

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", maxWidth: 860, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        .fiche-row:hover { background: #f5f7ff !important; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, paddingBottom: "1rem", borderBottom: `3px solid ${NAVY}`, marginBottom: "1.5rem" }}>
        <div style={{ background: NAVY, borderRadius: 8, padding: "7px 12px" }}>
          <div style={{ color: GREEN, fontWeight: 800, fontSize: 11, letterSpacing: 1.5 }}>HDF RUGBY</div>
          <div style={{ color: "white", fontWeight: 700, fontSize: 9, letterSpacing: 0.5, marginTop: 1 }}>ARBITRAGE</div>
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: NAVY }}>Vérificateur de fiches de frais</h1>
          <p style={{ margin: 0, fontSize: 12, color: "#666" }}>Agent de pré-conformité comptable · Procédure 2025-2026</p>
        </div>
        {fiches.length > 0 && (
          <button onClick={() => { setFiches([]); setOpen({}); }}
            style={{ border: "1px solid #ddd", background: "white", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", color: "#555" }}>
            Tout effacer
          </button>
        )}
      </div>

      {/* Stats */}
      {done.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: "1.5rem" }}>
          {[
            { label: "Analysées", value: done.length, color: NAVY },
            { label: "Conformes", value: counts.CONFORME, color: "#2e7d32" },
            { label: "Attention", value: counts.ATTENTION, color: "#e65100" },
            { label: "Non conformes", value: counts.NON_CONFORME, color: "#c62828" },
          ].map(s => (
            <div key={s.label} style={{ background: "#f8f9fa", borderRadius: 8, padding: "10px 14px", borderLeft: `3px solid ${s.color}` }}>
              <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? GREEN : NAVY}`,
          borderRadius: 12,
          padding: "2rem 1rem",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "#f4faec" : "#f8f9ff",
          marginBottom: "1.5rem",
          transition: "border-color .15s, background .15s",
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>📂</div>
        <p style={{ margin: 0, fontWeight: 600, color: NAVY, fontSize: 14 }}>Déposer les fiches de frais PDF</p>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#888" }}>
          Convocation + fiche de frais · Plusieurs fichiers acceptés simultanément
        </p>
        <input ref={fileRef} type="file" multiple accept=".pdf" style={{ display: "none" }}
          onChange={e => processFiles(e.target.files)} />
      </div>

      {/* Fiches list */}
      {fiches.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          {fiches.map(fiche => {
            const cfg = fiche.conformity ? S[fiche.conformity.status] : null;
            const d = fiche.data;
            const isOpen = !!open[fiche.id];

            return (
              <div key={fiche.id}
                style={{ border: "1px solid #e0e0e0", borderLeft: `4px solid ${cfg?.dot || (fiche.status === "error" ? "#f44336" : "#ccc")}`, borderRadius: 10, marginBottom: 8, overflow: "hidden", background: "white" }}>

                <div className="fiche-row"
                  onClick={() => fiche.status === "done" && setOpen(p => ({ ...p, [fiche.id]: !p[fiche.id] }))}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", cursor: fiche.status === "done" ? "pointer" : "default", background: "white" }}>

                  {/* Status badge or spinner */}
                  {fiche.status === "processing" && (
                    <div className="spin" style={{ width: 16, height: 16, border: `2px solid ${NAVY}`, borderTopColor: "transparent", borderRadius: "50%", flexShrink: 0 }} />
                  )}
                  {fiche.status === "error" && (
                    <span style={{ color: "#c62828", fontSize: 16, flexShrink: 0 }}>✗</span>
                  )}
                  {fiche.status === "done" && cfg && (
                    <span style={{ background: cfg.bg, color: cfg.color, borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
                      {cfg.label}
                    </span>
                  )}

                  {/* Main info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: NAVY, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d ? d.officiel_nom : fiche.fileName}
                    </div>
                    <div style={{ fontSize: 12, color: "#777", marginTop: 1 }}>
                      {fiche.status === "processing" && "Analyse en cours par Claude…"}
                      {fiche.status === "error" && `Erreur : ${fiche.error}`}
                      {d && `${d.role} · ${d.competition} · ${d.date_match || "—"}`}
                      {d?.equipe_domicile && ` · ${d.equipe_domicile} vs ${d.equipe_visiteur}`}
                    </div>
                  </div>

                  {/* Amount */}
                  {d && (
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 17, color: d.entite_payante === "FFR" ? "#aaa" : NAVY }}>
                        {d.total_declare != null ? `${d.total_declare.toFixed(2)} €` : "—"}
                      </div>
                      {d.entite_payante === "FFR" && <div style={{ fontSize: 10, color: "#aaa" }}>via FFR</div>}
                      {d.entite_payante === "Ligue" && <div style={{ fontSize: 10, color: GREEN, fontWeight: 600 }}>Ligue HDF</div>}
                    </div>
                  )}

                  {fiche.status === "done" && (
                    <span style={{ color: "#bbb", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
                  )}
                </div>

                {/* Expanded detail */}
                {isOpen && d && (
                  <div style={{ borderTop: "1px solid #f0f0f0", padding: "14px 16px", background: "#fafafa" }}>

                    {/* Numeric breakdown */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
                      {[
                        { label: "Km réels déclarés", value: d.km_reel != null ? `${d.km_reel} km` : "—", note: "base de calcul IK" },
                        { label: "Km arrondi (+10%)", value: d.km_arrondi != null ? `${d.km_arrondi} km` : "—", note: "non utilisé pour IK" },
                        { label: "IK attendu (km réel)", value: d.km_reel ? `${(d.km_reel * IK_RATE).toFixed(2)} €` : "—", note: `${d.km_reel} × 0,45` },
                        { label: "IK déclaré", value: d.ik_montant_declare != null ? `${d.ik_montant_declare.toFixed(2)} €` : "—", note: null },
                        { label: "Péages", value: d.peages_montant_declare > 0 ? `${d.peages_montant_declare.toFixed(2)} €` : "0 €", note: d.justificatifs_peages_presents === true ? "justificatifs présents" : d.justificatifs_peages_presents === false ? "⚠ sans justificatifs" : null },
                        { label: "IRF attendu", value: d.irf_attendu != null ? `${d.irf_attendu} €` : "—", note: null },
                        { label: "IRF déclaré", value: d.irf_declare != null ? `${d.irf_declare} €` : "—", note: null },
                        { label: "Sous-total déplacement", value: d.sous_total_deplacement != null ? `${d.sous_total_deplacement.toFixed(2)} €` : "—", note: null },
                        { label: "Entité payante", value: d.entite_payante || "—", note: null },
                        { label: "Volet 1 — convocation", value: d.volet_convocation_present === true ? "✓ Présent" : d.volet_convocation_present === false ? "✗ Absent" : "—", note: null, alert: d.volet_convocation_present === false },
                        { label: "Volet 2 — fiche de frais", value: d.volet_fiche_frais_presente === true ? "✓ Présent" : d.volet_fiche_frais_presente === false ? "✗ Absent" : "—", note: null, alert: d.volet_fiche_frais_presente === false },
                      ].map(item => (
                        <div key={item.label} style={{ background: item.alert ? "#ffebee" : "white", border: `1px solid ${item.alert ? "#ef9a9a" : "#e8e8e8"}`, borderRadius: 7, padding: "8px 10px" }}>
                          <div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", letterSpacing: 0.5 }}>{item.label}</div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: item.alert ? "#c62828" : "#1a1a1a", marginTop: 1 }}>{item.value}</div>
                          {item.note && <div style={{ fontSize: 10, color: item.note.startsWith("⚠") ? "#c62828" : "#bbb" }}>{item.note}</div>}
                        </div>
                      ))}
                    </div>

                    {/* Total box */}
                    <div style={{ display: "flex", alignItems: "center", background: NAVY, borderRadius: 8, padding: "8px 14px", marginBottom: 12 }}>
                      <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, flex: 1 }}>Total à verser</span>
                      <span style={{ color: "white", fontWeight: 700, fontSize: 17 }}>
                        {d.total_declare != null ? `${d.total_declare.toFixed(2)} €` : "—"}
                        {d.entite_payante === "FFR" && " (via FFR, hors Ligue)"}
                      </span>
                    </div>

                    {/* Issues & warnings */}
                    {fiche.conformity.issues.map((msg, i) => (
                      <div key={`iss-${i}`} style={{ background: "#ffebee", color: "#c62828", borderRadius: 6, padding: "7px 12px", fontSize: 12, marginBottom: 5, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ fontWeight: 700, flexShrink: 0 }}>✗</span>{msg}
                      </div>
                    ))}
                    {fiche.conformity.warnings.map((msg, i) => (
                      <div key={`wrn-${i}`} style={{ background: "#fff8e1", color: "#e65100", borderRadius: 6, padding: "7px 12px", fontSize: 12, marginBottom: 5, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ flexShrink: 0 }}>ℹ</span>{msg}
                      </div>
                    ))}
                    {fiche.conformity.issues.length === 0 && fiche.conformity.warnings.length === 0 && (
                      <div style={{ background: "#e8f5e9", color: "#2e7d32", borderRadius: 6, padding: "7px 12px", fontSize: 12, display: "flex", gap: 8 }}>
                        <span>✓</span> Aucune anomalie détectée — fiche conforme à la procédure
                      </div>
                    )}
                    {d.observations && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "#888", fontStyle: "italic", paddingTop: 6, borderTop: "1px solid #eee" }}>
                        Observation : {d.observations}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Export bar */}
      {done.length > 0 && (
        <div style={{ background: NAVY, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginBottom: 2 }}>Total engagements Ligue HDF</div>
            <div style={{ color: "white", fontWeight: 700, fontSize: 20 }}>
              {totalLigue.toFixed(2)} €
              <span style={{ fontSize: 12, fontWeight: 400, color: "rgba(255,255,255,0.5)", marginLeft: 8 }}>
                ({done.filter(f => f.data?.entite_payante === "Ligue").length} fiche(s))
              </span>
            </div>
          </div>
          <button onClick={exportXLSX}
            style={{ background: GREEN, color: "white", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            ↓ Exporter récap Excel
          </button>
        </div>
      )}

      {fiches.length === 0 && (
        <div style={{ textAlign: "center", color: "#ccc", padding: "2rem 0", fontSize: 13 }}>
          Aucune fiche chargée — déposez vos PDFs ci-dessus pour démarrer
        </div>
      )}

      {/* Rules reminder */}
      <div style={{ marginTop: "2rem", background: "#f0f4ff", borderRadius: 10, padding: "14px 16px", fontSize: 12, color: "#445" }}>
        <div style={{ fontWeight: 700, color: NAVY, marginBottom: 8, fontSize: 13 }}>Règles de conformité vérifiées automatiquement</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
          {[
            "Calcul IK sur km RÉELS (pas km arrondi)",
            "IRF correct selon rôle et compétition",
            "Cohérence sous-total et total général",
            "Justificatifs péages présents si péages déclarés",
            "Signature présente sur la fiche",
            "Délai dépôt ≤ 30 jours après le match",
            "Volet 1 présent : convocation / désignation",
            "Volet 2 présent : fiche de frais remplie",
            "Match FFR → NON CONFORME (circuit Oval-E)",
            "Challenge Fédéral M14 à XV → pris en charge Ligue",
          ].map(r => (
            <div key={r} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <span style={{ color: GREEN, flexShrink: 0, fontWeight: 700 }}>✓</span>{r}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
