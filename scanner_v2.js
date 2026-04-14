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

  const modelResult = await callEloModel(playerA, playerB, surface, oddsA, oddsB,
    match.sport_title || "", match.isLive || false);

  if (modelResult?.has_value && modelResult.value_bets?.length > 0) {
    const best = modelResult.value_bets[0];
    if (best.edge_pct >= EDGE_THRESHOLD) {
      console.log(`[ELO] ✅ ${best.player} +${best.edge_pct}% | ${best.decision}`);
      return { telegram_message: modelResult.telegram_message, pick: best.player,
               cote: best.odds, stake: `${best.stake_pct}%`, edge: `${best.edge_pct}%`,
               decision: best.decision, confidence: best.confidence,
               isLive: match.isLive || false, source: "elo_model" };
    }
  }

  if (!modelResult) {
    const { oddsA, oddsB } = getBestOdds(match);
    const matchDesc = `${playerA} vs ${playerB} | Surface: ${surface} | ${match.sport_title || "ATP"} | Cotes: ${playerA} ${oddsA} / ${playerB} ${oddsB}`;
    const prompt = `Tu es un analyste EV+ tennis. Analyse ce match. Match: ${matchDesc}
Edge minimum: ${EDGE_THRESHOLD}%. Si edge insuffisant → SKIP.
Réponds UNIQUEMENT en JSON: {"has_value":true/false,"player":"nom","odds":X.XX,"edge_pct":X.X,"stake_pct":X.X,"decision":"CORE/ACTION/SKIP","confidence":"HIGH/MEDIUM/LOW","telegram_message":"message si value"}`;
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514", max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      });
      const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
      const m = text.replace(/```json|```/g,"").trim().match(/\{[\s\S]*\}/);
      const data = m ? JSON.parse(m[0]) : null;
      if (data?.has_value && data.edge_pct >= EDGE_THRESHOLD)
        return { ...data, isLive: match.isLive || false, source: "ai_fallback" };
    } catch(e) { console.error("[AI]", e.message); }
  }
  return null;
}

async function analyzeFootballMatch(match) {
  const { oddsA, oddsB } = getBestOdds(match);
  if (!oddsA || !oddsB) return null;
  const matchDesc = `${match.home_team} vs ${match.away_team} | ${match.sport_title} | Cotes: ${oddsA} / ${oddsB}`;
  const prompt = `Tu es un analyste EV+ football. Sois TRÈS sélectif — marché efficient.
Match: ${matchDesc}
Edge minimum: ${EDGE_THRESHOLD + 1}%. En cas de doute → SKIP.
Réponds UNIQUEMENT en JSON: {"has_value":true/false,"player":"équipe","odds":X.XX,"edge_pct":X.X,"stake_pct":X.X,"decision":"CORE/ACTION/SKIP","confidence":"HIGH/MEDIUM/LOW","telegram_message":"message si value"}`;
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
  const title = `${liveTag}UNPRICED ${emoji} ${result.decision} | Edge ${result.edge || result.edge_pct + "%"} | ${teams}`;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Title: title,
                 Priority: result.decision === "CORE" ? "urgent" : "high",
                 Tags: result.isLive ? "red_circle,chart_with_upwards_trend" : "chart_with_upwards_trend" },
      body: result.telegram_message || title
    });
    console.log(`[NTFY] ✅ ${teams} | ${result.decision}`);
  } catch(e) { console.error("[NTFY]", e.message); }
}

async function scan(isLiveRound = false) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  console.log(`\n[SCAN] ${now} — ${isLiveRound ? "LIVE" : "PRÉ-MATCH"}`);
  const matches = [];

  if (!isLiveRound) {
    const tp = await fetchMatches(TENNIS_COMPETITIONS, false);
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

  for (const match of matches.slice(0, isLiveRound ? 8 : 5)) {
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
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) { console.error(`[ERR] ${teams}:`, e.message); }
  }
}

console.log("\n🚀 UNPRICED v2");
console.log(`📡 ntfy: ${NTFY_TOPIC}`);
console.log(`🧮 Model: ${MODEL_API_URL}`);
console.log(`⚡ Edge: ${EDGE_THRESHOLD}%`);

fetch(`${MODEL_API_URL}/health`).then(r=>r.json())
  .then(d => console.log(`[MODEL] ✅ ${d.matches_trained?.toLocaleString()} matchs`))
  .catch(() => console.log("[MODEL] ⚠ Fallback IA actif"));

cron.schedule("*/30 * * * *", () => scan(false));
cron.schedule("*/3 * * * *", () => scan(true));
scan(false);
