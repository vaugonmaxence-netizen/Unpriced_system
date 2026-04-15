import Anthropic from “@anthropic-ai/sdk”;
import fetch from “node-fetch”;
import fs from “fs”;
import cron from “node-cron”;
import dotenv from “dotenv”;
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NTFY_TOPIC = process.env.NTFY_TOPIC || “unpriced-picks”;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || “3”);
const MODEL_API_URL = process.env.MODEL_API_URL || “http://localhost:8080”;
const TRACKING_FILE = “picks_tracking.json”;

// ============================================================
// COMPETITIONS - Tennis ATP/Challengers hommes + L1 + UCL
// ============================================================
const FOOTBALL_COMPETITIONS = [
“soccer_france_ligue_one”,
“soccer_uefa_champs_league”
];

// Filtres tennis : hommes uniquement, pas WTA
const TENNIS_MALE_KEYWORDS = [“atp”, “challenger”, “itf_men”];
const TENNIS_EXCLUDE_KEYWORDS = [“wta”, “women”, “female”];

async function getTennisCompetitions() {
try {
const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}&all=false`);
if (!res.ok) return [];
const data = await res.json();
const comps = data.filter(s => {
const key = s.key.toLowerCase();
const title = (s.title||””).toLowerCase();
const isMale = TENNIS_MALE_KEYWORDS.some(k => key.includes(k) || title.includes(k));
const isFemale = TENNIS_EXCLUDE_KEYWORDS.some(k => key.includes(k) || title.includes(k));
return s.active && isMale && !isFemale;
}).map(s => s.key);
console.log(`[COMPS] ${comps.length} tournois tennis hommes: ${comps.join(", ")}`);
return comps;
} catch(e) {
console.error(”[COMPS ERR]:”, e.message);
return [];
}
}

// ============================================================
// TRACKING
// ============================================================
function loadTracking() {
try {
if (fs.existsSync(TRACKING_FILE)) return JSON.parse(fs.readFileSync(TRACKING_FILE, “utf-8”));
} catch(e) {}
return { picks: [], pending_validation: [] };
}

function saveTracking(data) {
try { fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

function savePick(pick, teams, sport) {
const tracking = loadTracking();
const entry = {
id: `${Date.now()}`,
date: new Date().toISOString(),
teams, sport,
player: pick.player,
odds: pick.odds,
edge_pct: pick.edge_pct,
stake_pct: pick.stake_pct,
decision: pick.decision,
confidence: pick.confidence,
match_id: pick.match_id,
commence_time: pick.commence_time,
scan_type: pick.scan_type || “J2”,
result: “PENDING”,
profit: null
};
tracking.picks.push(entry);
saveTracking(tracking);
console.log(`[TRACKING] Saved: ${teams} | ${pick.player} @ ${pick.odds} | ${pick.scan_type}`);
return entry;
}

// Sauvegarde un pick J-2 en attente de validation J0
function savePendingValidation(pick, teams, sport, matchId, commenceTime) {
const tracking = loadTracking();
if (!tracking.pending_validation) tracking.pending_validation = [];

// Evite les doublons
const exists = tracking.pending_validation.find(p => p.match_id === matchId);
if (exists) return;

tracking.pending_validation.push({
match_id: matchId,
teams, sport,
player: pick.player,
odds: pick.odds,
edge_pct: pick.edge_pct,
stake_pct: pick.stake_pct,
decision: pick.decision,
confidence: pick.confidence,
commence_time: commenceTime,
saved_at: new Date().toISOString(),
validated: false
});
saveTracking(tracking);
console.log(`[PENDING] Saved for J0 validation: ${teams}`);
}

function getPendingValidations() {
const tracking = loadTracking();
return (tracking.pending_validation || []).filter(p => !p.validated);
}

function markValidated(matchId) {
const tracking = loadTracking();
if (!tracking.pending_validation) return;
const p = tracking.pending_validation.find(p => p.match_id === matchId);
if (p) p.validated = true;
saveTracking(tracking);
}

function getTrackingStats() {
const tracking = loadTracking();
const { picks } = tracking;
const resolved = picks.filter(p => p.result !== “PENDING”);
const wins = resolved.filter(p => p.result === “WIN”).length;
const losses = resolved.filter(p => p.result === “LOSS”).length;
const totalStaked = resolved.reduce((s, p) => s + (p.stake_pct || 1), 0);
const totalReturned = resolved.filter(p => p.result === “WIN”)
.reduce((s, p) => s + (p.stake_pct || 1) * (p.odds || 1), 0);
const roi = totalStaked > 0 ? ((totalReturned - totalStaked) / totalStaked * 100).toFixed(2) : 0;
return {
total: picks.length,
pending: picks.filter(p => p.result === “PENDING”).length,
wins, losses,
roi: `${roi}%`,
winrate: resolved.length > 0 ? `${(wins / resolved.length * 100).toFixed(1)}%` : “N/A”
};
}

// ============================================================
// FETCH MATCHES
// ============================================================
async function fetchMatches(competitions) {
const results = [];
for (const comp of competitions) {
try {
const url = `https://api.the-odds-api.com/v4/sports/${comp}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
const res = await fetch(url, { timeout: 10000 });
if (!res.ok) continue;
const data = await res.json();
if (Array.isArray(data) && data.length > 0) {
results.push(…data);
console.log(`[FETCH] ${comp}: ${data.length} matchs`);
}
} catch(e) {}
}
return results;
}

function getBestOdds(match) {
let bestA = 0, bestB = 0, pinnacleA = 0, pinnacleB = 0;
for (const bm of match.bookmakers || []) {
const market = bm.markets?.[0];
if (!market) continue;
for (const o of market.outcomes) {
if (o.name === match.home_team) {
bestA = Math.max(bestA, o.price);
if (bm.key === “pinnacle”) pinnacleA = o.price;
}
if (o.name === match.away_team) {
bestB = Math.max(bestB, o.price);
if (bm.key === “pinnacle”) pinnacleB = o.price;
}
}
}
return { oddsA: bestA, oddsB: bestB, pinnacleA, pinnacleB };
}

function getSurface(sportTitle, sportKey) {
const text = ((sportTitle || “”) + “ “ + (sportKey || “”)).toLowerCase();
if (text.includes(“wimbledon”) || text.includes(“grass”) || text.includes(“queens”) || text.includes(“halle”)) return “Grass”;
if (text.includes(“australian”) || text.includes(“us open”) || text.includes(“miami”) ||
text.includes(“indian wells”) || text.includes(“cincinnati”) || text.includes(“toronto”) ||
text.includes(“montreal”) || text.includes(“beijing”) || text.includes(“shanghai”) ||
text.includes(“vienna”) || text.includes(“rotterdam”) || text.includes(“doha”) || text.includes(“dubai”)) return “Hard”;
if (text.includes(“roland”) || text.includes(“clay”) || text.includes(“monte”) ||
text.includes(“madrid”) || text.includes(“rome”) || text.includes(“barcelona”) ||
text.includes(“hamburg”) || text.includes(“rio”) || text.includes(“buenos”)) return “Clay”;
return “Clay”; // default clay pour challenger
}

// ============================================================
// AGENT CALLER
// ============================================================
async function callAgent(prompt, useSearch = false, retries = 2) {
for (let attempt = 0; attempt <= retries; attempt++) {
try {
const params = {
model: “claude-sonnet-4-20250514”,
max_tokens: 500,
messages: [{ role: “user”, content: prompt }]
};
if (useSearch) params.tools = [{ type: “web_search_20250305”, name: “web_search” }];
const response = await anthropic.messages.create(params);
const text = response.content.map(b => b.type === “text” ? b.text : “”).join(”\n”);
const clean = text.replace(/`json|`/g, “”).trim();
const m = clean.match(/{[\s\S]*}/);
if (!m) return null;
return JSON.parse(m[0]);
} catch(e) {
if (e.message?.includes(“rate_limit”) && attempt < retries) {
console.log(`[RETRY] Rate limit - attente 30s...`);
await new Promise(r => setTimeout(r, 30000));
} else { throw e; }
}
}
return null;
}

async function getEloData(playerA, playerB, surface) {
try {
const params = new URLSearchParams({ player_a: playerA, player_b: playerB, surface: surface || “Clay” });
const res = await fetch(`${MODEL_API_URL}/predict?${params}`, { timeout: 5000 });
if (!res.ok) return null;
const data = await res.json();
return data.prob_a ? data : null;
} catch { return null; }
}

// ============================================================
// SCAN J-2 : ANALYSE INITIALE (3 agents + web search)
// ============================================================
async function runInitialAnalysis(match, sport) {
const surface = sport === “tennis” ? getSurface(match.sport_title, match.sport_key) : “N/A”;
const playerA = match.home_team || “”;
const playerB = match.away_team || “”;
const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(match);
const tournament = match.sport_title || “”;

if (!oddsA || !oddsB) return null;

const eloData = sport === “tennis” ? await getEloData(playerA, playerB, surface) : null;
const eloStr = eloData
? `ELO: ${playerA} ${eloData.prob_a_pct}% (juste ${eloData.fair_odds_a}) / ${playerB} ${eloData.prob_b_pct}% (juste ${eloData.fair_odds_b}) conf:${eloData.confidence}`
: “ELO: non dispo”;
const pinStr = pinnacleA ? `Pinnacle: ${playerA}@${pinnacleA} / ${playerB}@${pinnacleB}` : “Pinnacle: non dispo”;

console.log(`\n[J-2] ${playerA} vs ${playerB} | ${surface} | ${oddsA}/${oddsB}`);

// Agent 1 : Analyse initiale (web search activé)
console.log(`[J-2 A1] Analyse...`);
const analyst = await callAgent(
`Analyste EV+ ${sport}. Analyse 24-48h avant le match. MATCH: ${playerA}@${oddsA} vs ${playerB}@${oddsB} | ${tournament} | Surface:${surface} ${pinStr} | ${eloStr} RECHERCHE: forme 14j+qualite adversaires, blessures "[joueur] injury 2026", H2H surface, fatigue, Pinnacle deja price? REGLES: edge<${EDGE_THRESHOLD}% SKIP | cote<1.60 edge>5% | doute SKIP JSON: {"decision":"CORE/ACTION/SKIP","edge_estimate":"X%","player":"nom","odds":X.XX,"facteurs":["f1","f2"],"prob":"X%","rationale":"raison courte"}`,
true
);

if (!analyst || analyst.decision === “SKIP”) { console.log(`[J-2 A1] SKIP`); return null; }
const edgeNum = parseFloat((analyst.edge_estimate || “0”).replace(”%”, “”).replace(”+”, “”));
if (edgeNum < EDGE_THRESHOLD) { console.log(`[J-2 A1] SKIP edge ${edgeNum}%`); return null; }
console.log(`[J-2 A1] ${analyst.decision} | ${analyst.edge_estimate} | ${analyst.player}`);
await new Promise(r => setTimeout(r, 8000));

// Agent 2 : Contre-analyse (web search activé)
console.log(`[J-2 A2] Contre-analyse...`);
const counter = await callAgent(
`Contre-analyste EV+. Trouve pourquoi ce bet est mauvais. MATCH: ${playerA} vs ${playerB} | ${tournament} | ${pinStr} ANALYSE: ${JSON.stringify(analyst)} CHERCHE: cotes bougees? info adverse ignoree? Pinnacle deja price? edge illusion? JSON: {"decision":"CONFIRME/FAIBLE/REFUS","edge_reel":"X%","warning":"risque principal"}`,
true
);

if (!counter || counter.decision === “REFUS”) { console.log(`[J-2 A2] REFUS - ${counter?.warning}`); return null; }
console.log(`[J-2 A2] ${counter.decision} | ${counter.edge_reel}`);
await new Promise(r => setTimeout(r, 8000));

// Agent 3 : Décision finale (pas de web search - économie)
console.log(`[J-2 A3] Decision...`);
const final = await callAgent(
`Decideur final EV+. Tranche. ANALYSE: ${JSON.stringify(analyst)} | CONTRE: ${JSON.stringify(counter)} | ${eloStr} CORE: edge>4% | ACTION: edge 2-4% | REFUS: fatal | SKIP: incertain JSON: {"decision":"CORE/ACTION/REFUS/SKIP","edge_final":"X%","player":"nom","odds":X.XX,"confidence":"HIGH/MEDIUM/LOW","stake":"X%"}`
);

if (!final || [“REFUS”, “SKIP”].includes(final.decision)) { console.log(`[J-2 A3] ${final?.decision}`); return null; }

const stake = final.stake || (final.decision === “CORE” ? “1.5%” : “0.75%”);
const edgeFinal = parseFloat((final.edge_final || “0”).replace(”%”, “”).replace(”+”, “”));

// Message de notification J-2
const msg = [
`UNPRICED ${sport === "tennis" ? "Tennis" : "Foot"} - ANALYSE J-2`,
`${tournament}`,
``,
`${final.player} @ ${final.odds} - ${stake}`,
`Value: +${final.edge_final} | Proba: ~${analyst.prob || “?”}`,
`${pinStr}`,
`—`,
`Facteurs: ${analyst.facteurs?.join(”, “) || analyst.rationale}`,
`${eloStr}`,
`—`,
`A confirmer 1-2h avant le match.`,
`Lecture froide. Zero emotion.`
].join(”\n”).replace(/[^\x20-\x7E\n]/g, “”);

return {
player: final.player, odds: final.odds,
edge_pct: edgeFinal,
stake_pct: parseFloat((stake).replace(”%”, “”)),
decision: final.decision, confidence: final.confidence,
telegram_message: msg, scan_type: “J2”,
match_id: match.id,
commence_time: match.commence_time,
elo_used: !!eloData
};
}

// ============================================================
// SCAN J0 : VALIDATION 1-2H AVANT (1 agent léger + web search)
// ============================================================
async function runValidation(pending, currentMatch) {
const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(currentMatch);
const pinStr = pinnacleA
? `Pinnacle actuel: ${currentMatch.home_team}@${pinnacleA} / ${currentMatch.away_team}@${pinnacleB}`
: “Pinnacle: non dispo”;

const oddsChanged = Math.abs((oddsA || pending.odds) - pending.odds) > 0.1;

console.log(`\n[J0] Validation: ${pending.teams} | Cotes: ${oddsA}/${oddsB} | Mouvement: ${oddsChanged ? "OUI" : "stable"}`);

const validator = await callAgent(
`Validateur EV+ 1-2h avant le match. Pick J-2 a confirmer ou annuler. MATCH: ${pending.teams} | Pick initial: ${pending.player}@${pending.odds} edge:+${pending.edge_pct}% COTES ACTUELLES: ${pending.player}@${oddsA || pending.odds} | ${pinStr} Mouvement cotes: ${oddsChanged ? `BOUGE (${pending.odds} -> ${oddsA})` : "stable"} VERIFIE: nouvelles blessures/forfaits derniere heure, cotes bougees significativement, info de derniere minute CONFIRME si: pas de nouvelle info negative + cotes stables ou ameliorees ANNULE si: blessure confirmee / cotes bougees contre nous >0.15 / info majeure adverse JSON: {"decision":"CONFIRME/ANNULE","raison":"1 phrase","odds_final":X.XX}`,
true
);

return {
confirmed: validator?.decision === “CONFIRME”,
raison: validator?.raison || “?”,
odds_final: validator?.odds_final || oddsA || pending.odds,
odds_changed: oddsChanged
};
}

// ============================================================
// NOTIFICATIONS
// ============================================================
async function sendNotification(result, teams, sport, type = “J2”) {
const label = sport === “tennis” ? “Tennis” : “Foot”;
const typeLabel = type === “J0_CONFIRME” ? “CONFIRME” : type === “J0_ANNULE” ? “ANNULE” : “ANALYSE”;
const title = `UNPRICED ${label} ${typeLabel} ${result.decision || ""} +${result.edge_pct || "?"}% ${teams}`
.replace(/[^\x20-\x7E]/g, “”).substring(0, 100);
const body = (result.telegram_message || “”)
.replace(/[^\x20-\x7E\n]/g, “”).substring(0, 4000);
try {
const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
method: “POST”,
headers: {
“Content-Type”: “text/plain”,
“Title”: title,
“Priority”: type === “J0_ANNULE” ? “default” : result.decision === “CORE” ? “urgent” : “high”,
“Tags”: type === “J0_ANNULE” ? “x” : “chart_with_upwards_trend”
},
body
});
if (res.ok) console.log(`[NTFY] OK: ${teams} | ${typeLabel}`);
else console.error(`[NTFY ERR] ${res.status}`);
} catch(e) { console.error(”[NTFY ERR]:”, e.message); }
}

async function sendCancellationNotif(pending, raison) {
const msg = [
`UNPRICED - PICK ANNULE`,
`${pending.teams}`,
``,
`Pick J-2 annule: ${pending.player} @ ${pending.odds}`,
`Raison: ${raison}`,
`—`,
`Lecture froide. Zero emotion.`
].join(”\n”);
await sendNotification(
{ telegram_message: msg, edge_pct: pending.edge_pct, decision: “ANNULE” },
pending.teams, pending.sport, “J0_ANNULE”
);
}

async function sendConfirmationNotif(pending, validation) {
const msg = [
`UNPRICED ${pending.sport === "tennis" ? "Tennis" : "Foot"} - CONFIRME J0`,
``,
`${pending.player} @ ${validation.odds_final} - ${pending.stake_pct}%`,
`Value: +${pending.edge_pct}% | Conf: ${pending.confidence}`,
validation.odds_changed ? `Cote mise a jour: ${pending.odds} -> ${validation.odds_final}` : `Cote stable: ${pending.odds}`,
`—`,
`Analyse J-2 confirmee. Aucune info negative.`,
`JOUER MAINTENANT.`,
`—`,
`Lecture froide. Zero emotion.`
].join(”\n”).replace(/[^\x20-\x7E\n]/g, “”);
await sendNotification(
{ telegram_message: msg, edge_pct: pending.edge_pct, decision: pending.decision },
pending.teams, pending.sport, “J0_CONFIRME”
);
}

// ============================================================
// RAPPORT QUOTIDIEN
// ============================================================
async function sendDailyReport() {
const stats = getTrackingStats();
const tracking = loadTracking();
const today = new Date().toLocaleDateString(“fr-FR”, { timeZone: “Europe/Paris” });
const todayPicks = tracking.picks.filter(p =>
new Date(p.date).toLocaleDateString(“fr-FR”, { timeZone: “Europe/Paris” }) === today
);
const msg = [
`UNPRICED - Bilan ${today}`,
`, `Picks du jour: ${todayPicks.length}`, todayPicks.map(p => `${p.result} | ${p.player}@${p.odds} ${p.stake_pct}%`).join("\n"), `,
`GLOBAL: ${stats.total} picks | W:${stats.wins} L:${stats.losses}`,
`ROI: ${stats.roi} | WR: ${stats.winrate}`,
``,
`Lecture froide. Zero emotion.`
].join(”\n”);

try {
await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
method: “POST”,
headers: { “Content-Type”: “text/plain”, “Title”: `UNPRICED Bilan ${today}`, “Priority”: “default” },
body: msg
});
console.log(`[RAPPORT] Envoye`);
} catch(e) { console.error(”[RAPPORT ERR]:”, e.message); }
}

// ============================================================
// SCAN PRINCIPAL J-2 (toutes les 2h)
// ============================================================
async function scanInitial() {
const now = new Date().toLocaleString(“fr-FR”, { timeZone: “Europe/Paris” });
console.log(`\n[SCAN J-2] ${now}`);

const tennisComps = await getTennisCompetitions();
const tennisMatches = await fetchMatches(tennisComps);
const footMatches = await fetchMatches(FOOTBALL_COMPETITIONS);

// Filtre : matchs dans 6h à 48h (pas trop proche, pas trop loin)
const now_ms = Date.now();
const min_ms = now_ms + 6 * 60 * 60 * 1000;   // dans 6h minimum
const max_ms = now_ms + 48 * 60 * 60 * 1000;  // dans 48h maximum

const allMatches = [
…tennisMatches.map(m => ({ …m, sport: “tennis” })),
…footMatches.map(m => ({ …m, sport: “football” }))
].filter(m => {
const t = new Date(m.commence_time).getTime();
return t >= min_ms && t <= max_ms;
});

// Exclure matchs déjà en pending validation
const pending = getPendingValidations().map(p => p.match_id);
const toAnalyze = allMatches
.filter(m => !pending.includes(m.id))
.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
.slice(0, 2); // MAX 2 matchs par cycle

console.log(`[J-2] ${allMatches.length} matchs eligibles | ${toAnalyze.length} a analyser`);

const stats = getTrackingStats();
console.log(`[STATS] ${stats.total} picks | ROI:${stats.roi} | WR:${stats.winrate}`);

for (const match of toAnalyze) {
const teams = `${match.home_team} vs ${match.away_team}`;
try {
let result = null;
if (match.sport === “tennis”) {
result = await runInitialAnalysis(match, “tennis”);
} else {
result = await runInitialAnalysis(match, “football”);
}

```
  if (result) {
    savePendingValidation(result, teams, match.sport, match.id, match.commence_time);
    await sendNotification(result, teams, match.sport, "J2");
  }

  await new Promise(r => setTimeout(r, 10000));
} catch(e) { console.error(`[ERR J-2] ${teams}:`, e.message); }
```

}
}

// ============================================================
// SCAN VALIDATION J0 (toutes les heures)
// ============================================================
async function scanValidation() {
const now = new Date().toLocaleString(“fr-FR”, { timeZone: “Europe/Paris” });
console.log(`\n[SCAN J0] ${now}`);

const pendings = getPendingValidations();
if (pendings.length === 0) { console.log(`[J0] Aucun pick en attente`); return; }

const now_ms = Date.now();
// Valider les picks dont le match commence dans 1 à 3h
const toValidate = pendings.filter(p => {
const t = new Date(p.commence_time).getTime();
const hoursUntil = (t - now_ms) / (1000 * 60 * 60);
return hoursUntil >= 0.5 && hoursUntil <= 3;
});

console.log(`[J0] ${pendings.length} en attente | ${toValidate.length} a valider maintenant`);

for (const pending of toValidate) {
try {
// Récupérer les cotes actuelles
const sport = pending.sport;
const comps = sport === “tennis” ? await getTennisCompetitions() : FOOTBALL_COMPETITIONS;
const matches = await fetchMatches(comps);
const currentMatch = matches.find(m => m.id === pending.match_id);

```
  if (!currentMatch) {
    console.log(`[J0] Match introuvable pour validation: ${pending.teams}`);
    markValidated(pending.match_id);
    continue;
  }

  const validation = await runValidation(pending, currentMatch);
  markValidated(pending.match_id);

  if (validation.confirmed) {
    savePick({
      ...pending,
      odds: validation.odds_final,
      scan_type: "J0_CONFIRME"
    }, pending.teams, pending.sport);
    await sendConfirmationNotif(pending, validation);
  } else {
    await sendCancellationNotif(pending, validation.raison);
    console.log(`[J0] ANNULE: ${pending.teams} - ${validation.raison}`);
  }

  await new Promise(r => setTimeout(r, 8000));
} catch(e) { console.error(`[ERR J0] ${pending.teams}:`, e.message); }
```

}
}

// ============================================================
// MISE A JOUR RESULTATS (22h)
// ============================================================
async function updateResults() {
console.log(”\n[RESULTATS] Verification picks PENDING…”);
const tracking = loadTracking();
const pending = tracking.picks.filter(p => p.result === “PENDING” && p.scan_type === “J0_CONFIRME”);
if (pending.length === 0) { console.log(”[RESULTATS] Rien a verifier”); return; }

let updated = 0;
for (const pick of pending.slice(0, 3)) { // Max 3 checks par soir
const hoursSince = (Date.now() - new Date(pick.date).getTime()) / (1000 * 60 * 60);
if (hoursSince < 2) continue;
try {
const response = await anthropic.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 200,
tools: [{ type: “web_search_20250305”, name: “web_search” }],
messages: [{ role: “user”, content: `Resultat match ${pick.teams} - joueur: ${pick.player} - date: ${pick.date}. JSON: {"result":"WIN/LOSS/PENDING/VOID","score":"score"}` }]
});
const text = response.content.map(b => b.type === “text” ? b.text : “”).join(”\n”);
const m = text.replace(/`json|`/g, “”).trim().match(/{[\s\S]*}/);
if (!m) continue;
const data = JSON.parse(m[0]);
if ([“WIN”, “LOSS”, “VOID”].includes(data.result)) {
pick.result = data.result;
pick.score = data.score || “”;
pick.profit = data.result === “WIN” ? (pick.stake_pct || 1) * (pick.odds - 1)
: data.result === “LOSS” ? -(pick.stake_pct || 1) : 0;
updated++;
}
await new Promise(r => setTimeout(r, 8000));
} catch(e) { console.error(`[RESULTATS ERR]:`, e.message); }
}
if (updated > 0) {
saveTracking(loadTracking());
console.log(`[RESULTATS] ${updated} mis a jour`);
}
}

// ============================================================
// DEMARRAGE
// ============================================================
console.log(”\nUNPRICED v3 - Tennis ATP/Challenger + L1/UCL - 2 scans/match”);
console.log(`ntfy: ${NTFY_TOPIC} | Edge: ${EDGE_THRESHOLD}%`);
console.log(`Mode: J-2 analyse + J0 validation (pas de live)`);

const stats = getTrackingStats();
console.log(`[TRACKING] ${stats.total} picks | ROI: ${stats.roi} | WR: ${stats.winrate}`);

// Scan initial J-2 : toutes les 2h
cron.schedule(“0 */2 * * *”, () => scanInitial(), { timezone: “Europe/Paris” });

// Validation J0 : toutes les heures
cron.schedule(“30 * * * *”, () => scanValidation(), { timezone: “Europe/Paris” });

// Résultats : 22h chaque soir
cron.schedule(“0 22 * * *”, () => updateResults(), { timezone: “Europe/Paris” });

// Rapport quotidien : 23h
cron.schedule(“0 23 * * *”, () => sendDailyReport(), { timezone: “Europe/Paris” });

console.log(”[CRON] J-2: toutes les 2h | J0: toutes les heures | Resultats: 22h | Rapport: 23h”);

// Démarrage avec délai pour laisser Railway s’initialiser
const delay = parseInt(process.env.STARTUP_DELAY || “30”) * 1000;
console.log(`[INIT] Premier scan dans ${delay / 1000}s...`);
setTimeout(() => scanInitial(), delay);
