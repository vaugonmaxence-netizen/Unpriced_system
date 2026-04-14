 import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NTFY_TOPIC = process.env.NTFY_TOPIC || "unpriced-picks";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "3");
const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:8080";

const FOOTBALL_COMPETITIONS = [
  "soccer_france_ligue_one","soccer_england_league1","soccer_spain_la_liga",
  "soccer_germany_bundesliga","soccer_italy_serie_a",
  "soccer_uefa_champs_league","soccer_uefa_europa_league"
];

const TENNIS_COMPETITIONS = [
  "tennis_atp_french_open","tennis_atp_us_open","tennis_atp_wimbledon",
  "tennis_atp_aus_open","tennis_atp_madrid_open","tennis_atp_rome",
  "tennis_atp_monte_carlo","tennis_atp_canadian_open","tennis_atp_cincinnati",
  "tennis_wta_french_open"
];

const sentPicks = new Set();

async function callEloModel(playerA, playerB, surface, oddsA, oddsB, tournament, isLive) {
  try {
    const params = new URLSearchParams({
      player_a: playerA, player_b: playerB, surface: surface || "Hard",
      odds_a: oddsA, odds_b: oddsB, tournament: tournament || "",
      live: isLive ? "true" : "false"
    });
    const res = await fetch(`${MODEL_API_URL}/analyze?${params}`, { timeout: 8000 });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── IA ciblée : blessures / fatigue / fraîcheur uniquement ──
async function checkPhysicalFactors(playerA, playerB, surface, eloEdge) {
  const prompt = `Tu es un analyste médical tennis EV+. Recherche UNIQUEMENT les infos physiques récentes (14 jours) sur ces deux joueurs.

Match: ${playerA} vs ${playerB} sur ${surface}
Edge Elo de base: ${eloEdge}%

Recherche pour CHAQUE joueur :
- Blessure récente ou en cours (cheville, dos, épaule, genou...)
- Maladie récente
- Nombre de matchs joués dans les 7 derniers jours
- Durée totale de jeu sur les 7 derniers jours
- Déclarations sur leur forme physique en conférence de presse
- Abandon ou retrait récent

RÈGLES :
- Si info négative sur le FAVORI Elo → edge augmente
- Si info négative sur l'OUTSIDER Elo → edge diminue
- Si aucune info physique trouvée → adjustment 0%

Réponds UNIQUEMENT en JSON :
{
  "player_a_status": "FIT/FATIGUE/BLESSE/INCONNU",
  "player_b_status": "FIT/FATIGUE/BLESSE/INCONNU",
  "player_a_details": "détails en 1 phrase",
  "player_b_details": "détails en 1 phrase",
  "edge_adjustment": X,
  "adjusted_edge": Y,
  "key_factor": "facteur physique principal ou AUCUN",
  "recommendation": "CONFIRME/RENFORCE/REDUIT/ANNULE"
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
    const m = text.replace(/```json|```/g,"").trim().match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch(e) {
    console.error("[IA PHYSIQUE]", e.message);
    return null;
  }
}

async function fetchMatches(competitions, inPlay = false) {
  const results = [];
  for (const comp of competitions) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${comp}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso${inPlay ? "&inPlay=true" : ""}`;
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data)) results.push(...data.map(m => ({ ...m, isLive: inPlay })));
    } catch {}
  }
  return results;
}

function parseTennisMatch(match) {
  const title = (match.sport_title || match.sport_key || "").toLowerCase();
  let surface = "Hard";
  if (title.includes("clay") || title.includes("monte") || title.includes("roland") ||
      title.includes("rome") || title.includes("madrid")) surface = "Clay";
  else if (title.includes("wimbledon") || title.includes("grass")) surface = "Grass";
  return { playerA: match.home_team || "", playerB: match.away_team || "", surface };
}

function getBestOdds(match) {
  let bestA = 0, bestB = 0;
  for (const bm of match.bookmakers || []) {
    const market = bm.markets?.[0];
    if (!market) continue;
    for (const o of market.outcomes) {
      if (o.name === match.home_team) bestA = Math.max(bestA, o.price);
      if (o.name === match.away_team) bestB = Math.max(bestB, o.price);
    }
  }
  return { oddsA: bestA, oddsB: bestB };
}

async function analyzeTennisMatch(match) {
  const { playerA, playerB, surface } = parseTennisMatch(match);
  const { oddsA, oddsB } = getBestOdds(match);
  if (!oddsA || !oddsB) return null;

  console.log(`[TENNIS] ${playerA} vs ${playerB} | ${surface} | ${oddsA}/${oddsB}`);

  // ── Étape 1 : Modèle Elo ──
  const modelResult = await callEloModel(playerA, playerB, surface, oddsA, oddsB,
    match.sport_title || "", match.isLive || false);

  if (!modelResult?.has_value || !modelResult.value_bets?.length) return null;

  const best = modelResult.value_bets[0];
  if (best.edge_pct < EDGE_THRESHOLD) return null;

  console.log(`[ELO] Edge détecté: ${best.player} +${best.edge_pct}% — vérification physique...`);

  // ── Étape 2 : IA physique ──
  const physical = await checkPhysicalFactors(playerA, playerB, surface, best.edge_pct);

  let finalEdge = best.edge_pct;
  let physicalNote = "";
  let decision = best.decision;

  if (physical) {
    finalEdge = physical.adjusted_edge || best.edge_pct;
    physicalNote = physical.key_factor !== "AUCUN" ? physical.key_factor : "";

    if (physical.recommendation === "ANNULE" || finalEdge < EDGE_THRESHOLD) {
      console.log(`[IA] ❌ Edge annulé par facteur physique: ${physicalNote}`);
      return null;
    }
    if (physical.recommendation === "REDUIT") {
      decision = finalEdge >= 4 ? "CORE" : finalEdge >= 2 ? "ACTION" : "SKIP";
    }
    console.log(`[IA] ✅ ${physical.recommendation} | ${physicalNote || "Aucun facteur physique majeur"}`);
  }

  // ── Message final ──
  const emoji = "🎾";
  const liveTag = match.isLive ? "🔴 LIVE · " : "";
  const tournament = match.sport_title || "ATP";

  const lines = [
    `${emoji} ${liveTag}${tournament}`,
    ``,
    `${best.player} @ ${best.odds} · ${best.stake_pct}%`,
    `Value estimée : +${finalEdge}%`,
    `Proba modèle : ~${best.prob_model_pct}%`,
    `—`,
    `Elo ${surface} : ${best.elo_player} vs ${best.elo_opponent}`,
    physicalNote ? `⚕ Physique : ${physicalNote}` : `⚕ Physique : RAS`,
    physical ? `Statut : ${playerA} ${physical.player_a_status} · ${playerB} ${physical.player_b_status}` : "",
    `—`,
    `Lecture froide. Zéro émotion.`
  ].filter(l => l !== "");

  return {
    telegram_message: lines.join("\n"),
    pick: best.player,
    cote: best.odds,
    stake: `${best.stake_pct}%`,
    edge: `${finalEdge}%`,
    decision,
    isLive: match.isLive || false,
    source: "elo+ia"
  };
}

async function analyzeFootballMatch(match) {
  const { oddsA, oddsB } = getBestOdds(match);
  if (!oddsA || !oddsB) return null;

  const prompt = `Tu es un analyste EV+ football. Sois TRÈS sélectif.
Match: ${match.home_team} vs ${match.away_team} | ${match.sport_title} | Cotes: ${oddsA} / ${oddsB}

Recherche UNIQUEMENT :
- Blessures joueurs clés (derniers 14 jours)
- Fatigue (matchs joués cette semaine)
- Suspensions
- Forme récente (5 derniers matchs)

Edge minimum: ${EDGE_THRESHOLD + 1}%. Si doute → SKIP.

JSON: {"has_value":false} ou {"has_value":true,"player":"équipe","odds":X.XX,"edge_pct":X.X,"stake_pct":X.X,"decision":"CORE/ACTION","physical_note":"facteur clé","telegram_message":"message complet"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
    const m = text.replace(/```json|```/g,"").trim().match(/\{[\s\S]*\}/);
    const data = m ? JSON.parse(m[0]) : null;
    if (data?.has_value && data.edge_pct >= EDGE_THRESHOLD + 1)
      return { ...data, isLive: match.isLive || false, source: "ai_football" };
  } catch(e) { console.error("[FOOT]", e.message); }
  return null;
}

async function sendNotification(result, teams, sport) {
  const emoji = sport === "tennis" ? "🎾" : "⚽";
  const liveTag = result.isLive ? "🔴 LIVE — " : "";
  const title = `${liveTag}UNPRICED ${emoji} ${result.decision} | Edge ${result.edge} | ${teams}`;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Title: title,
        Priority: result.decision === "CORE" ? "urgent" : "high",
        Tags: result.isLive ? "red_circle,chart_with_upwards_trend" : "chart_with_upwards_trend"
      },
      body: result.telegram_message || title
    });
    console.log(`[NTFY] ✅ ${teams} | ${result.decision} | ${result.source}`);
  } catch(e) { console.error("[NTFY]", e.message); }
}
// Récupérer tous les sports tennis disponibles dynamiquement
async function getTennisCompetitions() {
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}&all=true`);
    const data = await res.json();
    return data
      .filter(s => s.key.includes("tennis") && s.active)
      .map(s => s.key);
  } catch { return TENNIS_COMPETITIONS; }
}

async function scan(isLiveRound = false) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  console.log(`\n[SCAN] ${now} — ${isLiveRound ? "LIVE" : "PRÉ-MATCH"}`);
  const matches = [];

  if (!isLiveRound) {
   const tennisComps = await getTennisCompetitions();
const tp = await fetchMatches(tennisComps, false);
    const fp = await fetchMatches(FOOTBALL_COMPETITIONS, false);
    matches.push(...tp.map(m => ({ ...m, sport: "tennis" })));
    matches.push(...fp.map(m => ({ ...m, sport: "football" })));
  }
  const tl = await fetchMatches(TENNIS_COMPETITIONS, true);
  matches.push(...tl.map(m => ({ ...m, sport: "tennis" })));

  matches.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(a.commence_time) - new Date(b.commence_time);
  });

  console.log(`[SCAN] ${matches.length} matchs (${matches.filter(m=>m.isLive).length} live)`);

  for (const match of matches.slice(0, isLiveRound ? 3 : 3)) {
    const teams = `${match.home_team} vs ${match.away_team}`;
    const key = `${match.id}-${match.sport}-${match.isLive}`;
    if (sentPicks.has(key)) continue;
    try {
      const result = match.sport === "tennis"
        ? await analyzeTennisMatch(match)
        : await analyzeFootballMatch(match);
      if (result) {
        sentPicks.add(key);
        await sendNotification(result, teams, match.sport);
        setTimeout(() => sentPicks.delete(key), 4 * 60 * 60 * 1000);
      }
      await new Promise(r => setTimeout(r, 5000));
    } catch(e) { console.error(`[ERR] ${teams}:`, e.message); }
  }
}

console.log("\n🚀 UNPRICED v2 — Elo + IA Physique");
console.log(`📡 ntfy: ${NTFY_TOPIC}`);
console.log(`🧮 Model: ${MODEL_API_URL}`);
console.log(`⚡ Edge seuil: ${EDGE_THRESHOLD}%`);

fetch(`${MODEL_API_URL}/health`).then(r=>r.json())
  .then(d => console.log(`[MODEL] ✅ ${d.matches_trained?.toLocaleString()} matchs`))
  .catch(() => console.log("[MODEL] ⚠ Modèle non connecté"));

// Live tennis : toutes les 10 min
cron.schedule("*/10 * * * *", () => scan(true));
// Pré-match : toutes les heures
cron.schedule("0 * * * *", () => scan(false));

scan(false);

