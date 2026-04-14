import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NTFY_TOPIC = process.env.NTFY_TOPIC || "unpriced-picks";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "3");

// Surface par tournoi
const TOURNAMENT_SURFACES = {
  barcelona: "Clay", munich: "Clay", madrid: "Clay", rome: "Clay",
  "monte_carlo": "Clay", "monte-carlo": "Clay", roland: "Clay",
  estoril: "Clay", houston: "Clay", hamburg: "Clay", geneva: "Clay",
  lyon: "Clay", bucharest: "Clay", marrakech: "Clay", istanbul: "Clay",
  challenger: "Clay",
  wimbledon: "Grass", queens: "Grass", halle: "Grass", eastbourne: "Grass",
  "s-hertogenbosch": "Grass", nottingham: "Grass",
};

function getSurface(sportTitle, sportKey) {
  const text = ((sportTitle || "") + " " + (sportKey || "")).toLowerCase();
  for (const [keyword, surface] of Object.entries(TOURNAMENT_SURFACES)) {
    if (text.includes(keyword)) return surface;
  }
  return "Hard";
}

const FOOTBALL_COMPETITIONS = [
  "soccer_france_ligue_one", "soccer_england_league1", "soccer_spain_la_liga",
  "soccer_germany_bundesliga", "soccer_italy_serie_a",
  "soccer_uefa_champs_league", "soccer_uefa_europa_league"
];

const sentPicks = new Set();

async function getTennisCompetitions() {
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}&all=false`);
    const data = await res.json();
    const comps = data.filter(s => s.key.includes("tennis") && s.active).map(s => s.key);
    console.log(`[TENNIS COMPS] ${comps.length} tournois actifs: ${comps.join(", ")}`);
    return comps;
  } catch(e) {
    console.error("[TENNIS COMPS] Erreur:", e.message);
    return [];
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
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data.map(m => ({ ...m, isLive: inPlay })));
        console.log(`[FETCH] ${comp}: ${data.length} matchs`);
      }
    } catch(e) {
      console.error(`[FETCH ERR] ${comp}:`, e.message);
    }
  }
  return results;
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
  const surface = getSurface(match.sport_title, match.sport_key);
  const playerA = match.home_team || "";
  const playerB = match.away_team || "";
  const { oddsA, oddsB } = getBestOdds(match);
  const tournament = match.sport_title || "";
  const isLive = match.isLive || false;

  if (!oddsA || !oddsB) {
    console.log(`[SKIP] ${playerA} vs ${playerB} — pas de cotes`);
    return null;
  }

  console.log(`[TENNIS] ${playerA} vs ${playerB} | ${surface} | ${oddsA}/${oddsB} | ${tournament}`);

  const prompt = `Tu es un analyste EV+ tennis professionnel.

Match: ${playerA} vs ${playerB}
Surface: ${surface}
Tournoi: ${tournament}
Cotes: ${playerA} @ ${oddsA} / ${playerB} @ ${oddsB}
${isLive ? "MATCH EN LIVE" : "PRÉ-MATCH"}

Recherche les infos récentes sur ces joueurs (fatigue, blessures, forme, confrontations directes sur ${surface}).
Calcule l'edge estimé vs les cotes du marché.

RÈGLES STRICTES :
- Edge < ${EDGE_THRESHOLD}% → decision SKIP obligatoire
- Cote < 1.60 → edge requis ≥ 5%
- En cas de doute → SKIP

Réponds UNIQUEMENT en JSON valide sans markdown :
{"has_value":true,"player":"nom exact","odds":2.48,"edge_pct":4.2,"stake_pct":1.0,"decision":"ACTION","confidence":"MEDIUM","reason":"explication courte","telegram_message":"🎾 Munich · R2\\n\\nTsitsipas @ 1.75 · 1%\\nValue estimée : +4.2%\\nProba modèle : ~57%\\n—\\nEdge : surface clay avantage confirmé\\n—\\nLecture froide. Zéro émotion."}`;

  try {
    console.log(`[IA] Analyse en cours: ${playerA} vs ${playerB}...`);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    });

    const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
    console.log(`[IA RAW] ${text.substring(0, 200)}`);

    const clean = text.replace(/```json|```/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) {
      console.log(`[IA] Pas de JSON trouvé pour ${playerA} vs ${playerB}`);
      return null;
    }

    const data = JSON.parse(m[0]);
    console.log(`[IA RESULT] ${playerA} vs ${playerB} → ${data.decision} | Edge: ${data.edge_pct}%`);

    if (data.has_value && data.edge_pct >= EDGE_THRESHOLD) {
      return { ...data, isLive, source: "ai_tennis" };
    } else {
      console.log(`[SKIP] ${playerA} vs ${playerB} — edge insuffisant (${data.edge_pct}%)`);
    }
  } catch(e) {
    console.error(`[IA ERR] ${playerA} vs ${playerB}:`, e.message);
  }
  return null;
}

async function analyzeFootballMatch(match) {
  const { oddsA, oddsB } = getBestOdds(match);
  if (!oddsA || !oddsB) return null;

  const prompt = `Tu es un analyste EV+ football. Sois TRÈS sélectif.
Match: ${match.home_team} vs ${match.away_team} | ${match.sport_title}
Cotes: ${match.home_team} @ ${oddsA} / ${match.away_team} @ ${oddsB}
Edge minimum: ${EDGE_THRESHOLD + 1}%. En cas de doute → SKIP.
Réponds UNIQUEMENT en JSON valide :
{"has_value":false,"player":"équipe","odds":2.0,"edge_pct":0,"stake_pct":0,"decision":"SKIP","confidence":"LOW","reason":"","telegram_message":""}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
    const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
    const data = m ? JSON.parse(m[0]) : null;
    if (data?.has_value && data.edge_pct >= EDGE_THRESHOLD + 1) {
      console.log(`[FOOT] ✅ Edge: ${match.home_team} vs ${match.away_team} → ${data.decision} ${data.edge_pct}%`);
      return { ...data, isLive: match.isLive || false, source: "ai_football" };
    }
  } catch(e) {
    console.error(`[FOOT ERR]:`, e.message);
  }
  return null;
}

async function sendNotification(result, teams, sport) {
  const emoji = sport === "tennis" ? "🎾" : "⚽";
  const liveTag = result.isLive ? "🔴 LIVE — " : "";
  const title = `${liveTag}UNPRICED ${emoji} ${result.decision} | Edge +${result.edge_pct}% | ${teams}`;
  const body = result.telegram_message || title;

  console.log(`[NTFY] Envoi: ${title}`);
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Title: title,
        Priority: result.decision === "CORE" ? "urgent" : "high",
        Tags: result.isLive ? "red_circle,chart_with_upwards_trend" : "chart_with_upwards_trend"
      },
      body
    });
    if (res.ok) console.log(`[NTFY] ✅ Envoyé: ${teams}`);
    else console.log(`[NTFY] ❌ Erreur HTTP: ${res.status}`);
  } catch(e) {
    console.error("[NTFY ERR]:", e.message);
  }
}

async function scan(isLiveRound = false) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  console.log(`\n[SCAN] ${now} — ${isLiveRound ? "LIVE" : "PRÉ-MATCH"}`);

  const matches = [];

  const tennisComps = await getTennisCompetitions();
  const tennisMatches = await fetchMatches(tennisComps, isLiveRound);
  matches.push(...tennisMatches.map(m => ({ ...m, sport: "tennis" })));

  if (!isLiveRound) {
    const footMatches = await fetchMatches(FOOTBALL_COMPETITIONS, false);
    matches.push(...footMatches.map(m => ({ ...m, sport: "football" })));
  }

  matches.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(a.commence_time) - new Date(b.commence_time);
  });

  console.log(`[SCAN] ${matches.length} matchs (${matches.filter(m => m.isLive).length} live)`);

  const toAnalyze = matches.slice(0, 3);

  for (const match of toAnalyze) {
    const teams = `${match.home_team} vs ${match.away_team}`;
    const key = `${match.id}-${match.sport}`;
    if (sentPicks.has(key)) {
      console.log(`[CACHE] Déjà analysé: ${teams}`);
      continue;
    }

    try {
      let result = null;
      if (match.sport === "tennis") {
        result = await analyzeTennisMatch(match);
      } else {
        result = await analyzeFootballMatch(match);
      }

      if (result) {
        sentPicks.add(key);
        await sendNotification(result, teams, match.sport);
        setTimeout(() => sentPicks.delete(key), 4 * 60 * 60 * 1000);
      }

      await new Promise(r => setTimeout(r, 8000));
    } catch(e) {
      console.error(`[ERR] ${teams}:`, e.message);
    }
  }
}

console.log("\n🚀 UNPRICED v2 — Elo + IA Physique");
console.log(`📡 ntfy: ${NTFY_TOPIC}`);
console.log(`🧮 Model: http://localhost:8080/`);
console.log(`⚡ Edge seuil: ${EDGE_THRESHOLD}%`);

cron.schedule("*/30 * * * *", () => scan(false));
cron.schedule("*/10 * * * *", () => scan(true));

const startupDelay = parseInt(process.env.STARTUP_DELAY || "30") * 1000;
console.log(`[INIT] Premier scan dans ${startupDelay/1000}s...`);
setTimeout(() => scan(false), startupDelay);
