import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import fs from "fs";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NTFY_TOPIC = process.env.NTFY_TOPIC || "unpriced-picks";
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "3");
const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:8080";
const TRACKING_FILE = "picks_tracking.json";

// ============================================================
// TRACKING
// ============================================================
function loadTracking() {
  try {
    if (fs.existsSync(TRACKING_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKING_FILE, "utf-8"));
    }
  } catch(e) {}
  return { picks: [], session: { consecutive_skips: 0, consecutive_actions: 0 } };
}

function savePick(pick, teams, sport) {
  const tracking = loadTracking();
  const entry = {
    id: `${Date.now()}`,
    date: new Date().toISOString(),
    teams,
    sport,
    player: pick.player,
    odds: pick.odds,
    edge_pct: pick.edge_pct,
    stake_pct: pick.stake_pct,
    decision: pick.decision,
    confidence: pick.confidence,
    isLive: pick.isLive,
    markets_checked: pick.markets_checked || ["ML"],
    result: "PENDING",
    profit: null
  };
  tracking.picks.push(entry);
  tracking.session.consecutive_actions = (tracking.session.consecutive_actions || 0) + 1;
  tracking.session.consecutive_skips = 0;
  if (tracking.session.consecutive_actions >= 5) {
    console.log(`[ALERTE] ${tracking.session.consecutive_actions} picks consecutifs - seuil peut-etre trop bas`);
  }
  try {
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
    console.log(`[TRACKING] ${teams} | ${pick.player} @ ${pick.odds}`);
  } catch(e) {}
  return entry;
}

function recordSkip() {
  const tracking = loadTracking();
  tracking.session.consecutive_skips = (tracking.session.consecutive_skips || 0) + 1;
  tracking.session.consecutive_actions = 0;
  try { fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2)); } catch(e) {}
}

function getTrackingStats() {
  const tracking = loadTracking();
  const { picks } = tracking;
  const resolved = picks.filter(p => p.result !== "PENDING");
  const wins = resolved.filter(p => p.result === "WIN").length;
  const losses = resolved.filter(p => p.result === "LOSS").length;
  const totalStaked = resolved.reduce((s, p) => s + (p.stake_pct || 1), 0);
  const totalReturned = resolved.filter(p => p.result === "WIN").reduce((s, p) => s + (p.stake_pct || 1) * (p.odds || 1), 0);
  const roi = totalStaked > 0 ? ((totalReturned - totalStaked) / totalStaked * 100).toFixed(2) : 0;
  return {
    total: picks.length,
    pending: picks.filter(p => p.result === "PENDING").length,
    wins, losses,
    roi: `${roi}%`,
    winrate: resolved.length > 0 ? `${(wins / resolved.length * 100).toFixed(1)}%` : "N/A",
    consecutive_skips: tracking.session?.consecutive_skips || 0,
    consecutive_actions: tracking.session?.consecutive_actions || 0
  };
}

// ============================================================
// MISE A JOUR RESULTATS
// ============================================================
async function updateResults() {
  console.log("\n[RESULTATS] Verification picks PENDING...");
  const tracking = loadTracking();
  const pending = tracking.picks.filter(p => p.result === "PENDING");
  if (pending.length === 0) { console.log("[RESULTATS] Aucun pick en attente"); return; }

  let updated = 0;
  for (const pick of pending) {
    const hoursSince = (Date.now() - new Date(pick.date).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 1) continue;
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: `Resultat du match ${pick.teams} - joueur mise: ${pick.player} - date: ${pick.date}. Cherche sur flashscore.com ou atptour.com. JSON: {"result":"WIN/LOSS/PENDING/VOID","score":"score"}` }]
      });
      const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
      const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);
      if (!m) continue;
      const data = JSON.parse(m[0]);
      if (["WIN","LOSS","VOID"].includes(data.result)) {
        pick.result = data.result;
        pick.score = data.score || "";
        pick.profit = data.result === "WIN" ? (pick.stake_pct||1)*(pick.odds-1) : data.result === "LOSS" ? -(pick.stake_pct||1) : 0;
        updated++;
      }
      await new Promise(r => setTimeout(r, 8000));
    } catch(e) { console.error(`[RESULTATS ERR]:`, e.message); }
  }
  if (updated > 0) {
    try { fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2)); } catch(e) {}
    console.log(`[RESULTATS] ${updated} mis a jour`);
  }
}

// ============================================================
// RAPPORT QUOTIDIEN
// ============================================================
async function sendDailyReport() {
  const tracking = loadTracking();
  const today = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  const todayPicks = tracking.picks.filter(p =>
    new Date(p.date).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) === today
  );
  if (todayPicks.length === 0) { console.log("[RAPPORT] Aucun pick"); return; }

  const wins = todayPicks.filter(p => p.result === "WIN");
  const losses = todayPicks.filter(p => p.result === "LOSS");
  const pending = todayPicks.filter(p => p.result === "PENDING");
  const voids = todayPicks.filter(p => p.result === "VOID");
  const resolved = todayPicks.filter(p => !["PENDING","VOID"].includes(p.result));
  const totalStaked = resolved.reduce((s, p) => s + (p.stake_pct||1), 0);
  const totalReturned = wins.reduce((s, p) => s + (p.stake_pct||1)*(p.odds||1), 0);
  const profit = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? ((profit/totalStaked)*100).toFixed(1) : 0;
  const bilan = profit > 0 ? "POSITIF" : profit < 0 ? "NEGATIF" : "NEUTRE";
  const allStats = getTrackingStats();

  let lines = [
    `UNPRICED - Bilan ${today}`,
    ``,
    `PICKS: ${todayPicks.length} | W:${wins.length} L:${losses.length} V:${voids.length} P:${pending.length}`,
    ``
  ];
  todayPicks.forEach(p => {
    const profitStr = p.result==="WIN" ? `+${((p.stake_pct||1)*(p.odds-1)).toFixed(2)}u` :
                      p.result==="LOSS" ? `-${(p.stake_pct||1).toFixed(2)}u` :
                      p.result==="VOID" ? "rembourse" : "pending";
    lines.push(`${p.result} | ${p.player} @ ${p.odds} - ${p.stake_pct}%${p.score ? ` (${p.score})` : ""} | ${profitStr}`);
  });
  lines = lines.concat([``,`BILAN JOUR:`,`Profit: ${profit>=0?"+":""}${profit.toFixed(2)}u | ROI: ${roi}% | ${bilan}`,``,`GLOBAL: ${allStats.total} picks | WR: ${allStats.winrate} | ROI: ${allStats.roi}`,``,`Lecture froide. Zero emotion.`]);

  const title = `UNPRICED Bilan ${today} ROI ${roi}% ${bilan}`.replace(/[^\x20-\x7E]/g,"").substring(0,100);
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Title": title, "Priority": profit>=0?"high":"default", "Tags": profit>=0?"white_check_mark":"x" },
      body: lines.join("\n")
    });
    console.log(`[RAPPORT] OK - ${bilan} | ROI: ${roi}%`);
  } catch(e) { console.error("[RAPPORT ERR]:", e.message); }
}

// ============================================================
// MODELE ELO
// ============================================================
async function getEloData(playerA, playerB, surface) {
  try {
    const params = new URLSearchParams({ player_a: playerA, player_b: playerB, surface: surface||"Clay" });
    const res = await fetch(`${MODEL_API_URL}/predict?${params}`, { timeout: 5000 });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.prob_a) return null;
    return data;
  } catch { return null; }
}

// ============================================================
// SURFACE
// ============================================================
function getSurface(sportTitle, sportKey) {
  const text = ((sportTitle||"")+" "+(sportKey||"")).toLowerCase();
  if (text.includes("wimbledon")||text.includes("grass")||text.includes("queens")||text.includes("halle")||text.includes("eastbourne")||text.includes("nottingham")) return "Grass";
  if (text.includes("australian")||text.includes("us open")||text.includes("miami")||text.includes("indian wells")||text.includes("cincinnati")||text.includes("toronto")||text.includes("montreal")||text.includes("beijing")||text.includes("shanghai")||text.includes("vienna")||text.includes("basel")||text.includes("doha")||text.includes("dubai")||text.includes("rotterdam")) return "Hard";
  return "Unknown";
}

const FOOTBALL_COMPETITIONS = ["soccer_france_ligue_one","soccer_england_league1","soccer_spain_la_liga","soccer_germany_bundesliga","soccer_italy_serie_a","soccer_uefa_champs_league","soccer_uefa_europa_league"];
const sentPicks = new Set();

async function getTennisCompetitions() {
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}&all=false`);
    const data = await res.json();
    const comps = data.filter(s => s.key.includes("tennis") && s.active).map(s => s.key);
    console.log(`[COMPS] ${comps.length} tournois tennis: ${comps.join(", ")}`);
    return comps;
  } catch(e) { return []; }
}

async function fetchMatches(competitions, inPlay=false) {
  const results = [];
  for (const comp of competitions) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${comp}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso${inPlay?"&inPlay=true":""}`;
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data.map(m => ({ ...m, isLive: inPlay })));
        console.log(`[FETCH] ${comp}: ${data.length} matchs`);
      }
    } catch(e) {}
  }
  return results;
}

function getBestOdds(match) {
  let bestA=0, bestB=0, pinnacleA=0, pinnacleB=0;
  for (const bm of match.bookmakers||[]) {
    const market = bm.markets?.[0];
    if (!market) continue;
    for (const o of market.outcomes) {
      if (o.name===match.home_team) { bestA=Math.max(bestA,o.price); if(bm.key==="pinnacle") pinnacleA=o.price; }
      if (o.name===match.away_team) { bestB=Math.max(bestB,o.price); if(bm.key==="pinnacle") pinnacleB=o.price; }
    }
  }
  return { oddsA: bestA, oddsB: bestB, pinnacleA, pinnacleB };
}

// ============================================================
// AGENT CALLER - avec retry automatique sur rate limit
// ============================================================
async function callAgent(prompt, useSearch=false, retries=2) {
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const params = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }]
      };
      if (useSearch) params.tools = [{ type: "web_search_20250305", name: "web_search" }];
      const response = await anthropic.messages.create(params);
      const text = response.content.map(b => b.type==="text" ? b.text : "").join("\n");
      const clean = text.replace(/```json|```/g,"").trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) return null;
      return JSON.parse(m[0]);
    } catch(e) {
      if (e.message?.includes("rate_limit") && attempt < retries) {
        console.log(`[RETRY] Rate limit - attente 30s... (tentative ${attempt+1}/${retries})`);
        await new Promise(r => setTimeout(r, 30000));
      } else {
        throw e;
      }
    }
  }
  return null;
}

// ============================================================
// PIPELINE TENNIS 5 AGENTS
// ============================================================
async function runTennisPipeline(match) {
  const surface = getSurface(match.sport_title, match.sport_key);
  const playerA = match.home_team||"";
  const playerB = match.away_team||"";
  const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(match);
  const tournament = match.sport_title||"";
  const isLive = match.isLive||false;

  if (!oddsA||!oddsB) return null;

  const eloData = await getEloData(playerA, playerB, surface==="Unknown"?"Clay":surface);
  const eloStr = eloData
    ? `ELO: ${playerA} ${eloData.prob_a_pct}% (cote juste ${eloData.fair_odds_a}) / ${playerB} ${eloData.prob_b_pct}% (cote juste ${eloData.fair_odds_b}) - fiabilite ${eloData.confidence}`
    : `ELO: non disponible`;
  const pinStr = pinnacleA ? `Pinnacle: ${playerA}@${pinnacleA} / ${playerB}@${pinnacleB}` : `Pinnacle: non dispo`;
  const surfStr = surface==="Unknown" ? `Surface inconnue - cherche "surface ${tournament} 2026"` : `Surface: ${surface}`;

  console.log(`\n[PIPELINE] ${playerA} vs ${playerB} | ${surface} | ${oddsA}/${oddsB}`);

  // ── AGENT 1 ────────────────────────────────────────────
  console.log(`[AGENT 1] Analyse...`);
  const analyst = await callAgent(
    `Analyste EV+ tennis. Trouve erreurs de marche exploitables.
MATCH: ${playerA}@${oddsA} vs ${playerB}@${oddsB} | ${tournament} | ${surfStr} | ${isLive?"LIVE":"PRE-MATCH"}
${pinStr} | ${eloStr}
RECHERCHE: atptour.com, tennisabstract.com, presse 14j, blessures "[joueur] injury 2026"
VERIFIE: resultats 14j+qualite adversaires, fatigue, blessures, H2H surface, forme 2026, Pinnacle deja price?
MARCHES: ML + handicap sets + total sets (souvent moins efficients)
REGLES: edge<${EDGE_THRESHOLD}% SKIP | cote<1.60 edge>5% | GC/Masters edge>5% | doute SKIP
JSON: {"decision":"CORE/ACTION/SKIP","edge_estimate":"X%","player":"nom","odds":X.XX,"market":"ML/handicap/sets","facteurs":["f1","f2"],"prob":"X%","surface":"Clay/Hard/Grass","rationale":"sources+raison"}`,
    true
  );

  if (!analyst||analyst.decision==="SKIP") { console.log(`[AGENT 1] SKIP - ${analyst?.rationale||"?"}`); recordSkip(); return null; }
  const edgeNum = parseFloat((analyst.edge_estimate||"0").replace("%","").replace("+",""));
  if (edgeNum<EDGE_THRESHOLD) { console.log(`[AGENT 1] SKIP - edge ${edgeNum}%`); recordSkip(); return null; }
  console.log(`[AGENT 1] ${analyst.decision} | ${analyst.edge_estimate} | ${analyst.player}`);
  await new Promise(r => setTimeout(r, 8000));

  // ── AGENT 2 ────────────────────────────────────────────
  console.log(`[AGENT 2] Contre-analyse...`);
  const counter = await callAgent(
    `Contre-analyste EV+. Trouve pourquoi ce bet est mauvais.
MATCH: ${playerA} vs ${playerB} | ${tournament}
ANALYSE: ${JSON.stringify(analyst)} | ${pinStr}
CHERCHE: cotes bougees? fatigue deja pricee Pinnacle? info adverse ignoree? H2H contredit? Elo obsolete? edge reel ou illusion?
Verifie cotes actuelles oddsportal.com ou bet365.
JSON: {"decision":"CONFIRME/FAIBLE/REFUS","edge_reel":"X%","mouvement":"stable/monte/baisse","warning":"risque principal"}`,
    true
  );

  if (!counter||counter.decision==="REFUS") { console.log(`[AGENT 2] REFUS - ${counter?.warning||"?"}`); recordSkip(); return null; }
  console.log(`[AGENT 2] ${counter.decision} | ${counter.edge_reel} | cotes: ${counter.mouvement}`);
  await new Promise(r => setTimeout(r, 8000));

  // ── AGENT 3 ────────────────────────────────────────────
  console.log(`[AGENT 3] Decision finale...`);
  const final = await callAgent(
    `Decideur final EV+. Tranche.
ANALYSE: ${JSON.stringify(analyst)} | CONTRE: ${JSON.stringify(counter)} | ${eloStr}
VALIDE: edge survit contradiction? 2+ sources? Pinnacle pas price? Elo HIGH/MEDIUM? cotes stables?
CORE: edge>4% fort | ACTION: edge 2-4% | REFUS: fatal | SKIP: incertain
JSON: {"decision":"CORE/ACTION/REFUS/SKIP","edge_final":"X%","player":"nom","odds":X.XX,"market":"ML/handicap/sets","confidence":"HIGH/MEDIUM/LOW","validation":"1 phrase"}`
  );

  if (!final||["REFUS","SKIP"].includes(final.decision)) { console.log(`[AGENT 3] ${final?.decision}`); recordSkip(); return null; }
  console.log(`[AGENT 3] ${final.decision} | ${final.edge_final} | ${final.confidence}`);
  await new Promise(r => setTimeout(r, 8000));

  // ── AGENT 4 ────────────────────────────────────────────
  console.log(`[AGENT 4] Bankroll...`);
  const bankroll = await callAgent(
    `Bankroll manager tennis EV+.
DECISION: ${JSON.stringify(final)} | ELO confiance: ${eloData?.confidence||"?"} | cotes: ${counter?.mouvement||"?"}
CORE>4%: 1-2% | ACTION 2-4%: 0.5-1% | ELO HIGH->haut range | cote>3->-25% | warning->-25% | cotes baisse->-25% | marche alternatif->-15% | MAX 2%
JSON: {"stake_pct":"X%","justification":"1 phrase"}`
  );
  await new Promise(r => setTimeout(r, 8000));

  // ── AGENT 5 ────────────────────────────────────────────
  console.log(`[AGENT 5] Tipster...`);
  const stake = bankroll?.stake_pct||(final.decision==="CORE"?"1.5%":"0.75%");
  const tipster = await callAgent(
    `Tipster UNPRICED. Message Telegram froid et factuel.
PICK: ${final.player}@${final.odds} stake:${stake} edge:${final.edge_final} | ${tournament} | ${analyst.surface||surface} | ${final.market||"ML"} | ${isLive?"LIVE":"PRE-MATCH"}
FACTEURS: ${analyst.facteurs?.join(", ")} | ${eloStr} | ${pinStr} | ${final.validation}
ASCII UNIQUEMENT. Pas accents. Pas emojis.
FORMAT:
UNPRICED Tennis${isLive?" LIVE":""}
[Tournoi] - [Round]

[Joueur] @ [cote] - [stake]%${final.market&&final.market!=="ML"?" ["+final.market+"]":""}
Value: +X%
Proba: ~X%
Pinnacle ref: [si dispo]
---
Contexte: [1 ligne]
Edge: [facteurs verifies]
Scenario: [1-2 phrases]
---
Lecture froide. Zero emotion.
JSON: {"telegram_message":"message"}`
  );

  const msg = tipster?.telegram_message||`UNPRICED Tennis${isLive?" LIVE":""}\n${tournament}\n\n${final.player} @ ${final.odds} - ${stake}\nValue: +${final.edge_final}\n---\n${final.validation}\n---\nLecture froide. Zero emotion.`;

  return {
    player: final.player, odds: final.odds,
    edge_pct: parseFloat((final.edge_final||"0").replace("%","").replace("+","")),
    stake_pct: parseFloat((stake||"1").replace("%","")),
    decision: final.decision, confidence: final.confidence,
    telegram_message: msg, isLive,
    source: "pipeline_5agents", elo_used: !!eloData,
    markets_checked: ["ML","handicap","sets"],
    market_selected: final.market||"ML"
  };
}

// ============================================================
// PIPELINE FOOTBALL
// ============================================================
async function runFootballPipeline(match) {
  const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(match);
  if (!oddsA||!oddsB) return null;
  console.log(`\n[FOOT] ${match.home_team} vs ${match.away_team}`);

  const analyst = await callAgent(
    `Analyste EV+ football. Marche TRES efficient - TRES selectif.
MATCH: ${match.home_team}@${oddsA} vs ${match.away_team}@${oddsB} | ${match.sport_title}
${pinnacleA?`Pinnacle: ${match.home_team}@${pinnacleA} / ${match.away_team}@${pinnacleB}`:"Pinnacle: non dispo"}
RECHERCHE: forme 5 matchs+qualite adversaires, blessures/suspensions confirmees, contexte, H2H, Pinnacle reference
REGLES: edge min ${EDGE_THRESHOLD+1}% vs Pinnacle | 2 sources minimum | doute SKIP
JSON: {"decision":"ACTION/CORE/SKIP","edge_estimate":"X%","player":"equipe","odds":X.XX,"rationale":"sources+raison"}`,
    true
  );

  if (!analyst||analyst.decision==="SKIP") { console.log(`[FOOT] SKIP`); return null; }
  const edgeNum = parseFloat((analyst.edge_estimate||"0").replace("%","").replace("+",""));
  if (edgeNum<EDGE_THRESHOLD+1) { console.log(`[FOOT] SKIP edge ${edgeNum}%`); return null; }
  await new Promise(r => setTimeout(r, 10000));

  const counter = await callAgent(
    `Contre-analyste foot. Trouve pourquoi ce bet est mauvais.
MATCH: ${match.home_team} vs ${match.away_team} | ANALYSE: ${JSON.stringify(analyst)}
Pinnacle: ${pinnacleA?`${match.home_team}@${pinnacleA}`:"non dispo"}
JSON: {"decision":"CONFIRME/REFUS","edge_reel":"X%","warning":"risque"}`
  );

  if (!counter||counter.decision==="REFUS") { console.log(`[FOOT] REFUS`); return null; }

  const msg = `UNPRICED Foot\n${match.sport_title}\n\n${analyst.player} @ ${analyst.odds} - 0.5%\nValue: +${analyst.edge_estimate}\n${pinnacleA?`Pinnacle ref: ${analyst.player===match.home_team?pinnacleA:pinnacleB}\n`:""}\n---\n${analyst.rationale}\n---\nLecture froide. Zero emotion.`;

  return {
    player: analyst.player, odds: analyst.odds, edge_pct: edgeNum,
    stake_pct: 0.5, decision: analyst.decision, confidence: "MEDIUM",
    telegram_message: msg, isLive: match.isLive||false,
    source: "pipeline_football", elo_used: false, markets_checked: ["ML"]
  };
}

// ============================================================
// NOTIFICATION NTFY
// ============================================================
async function sendNotification(result, teams, sport) {
  const label = sport==="tennis"?"Tennis":"Foot";
  const title = `${result.isLive?"LIVE ":""}UNPRICED ${label}${result.elo_used?" ELO":""} ${result.decision} Edge+${result.edge_pct}% ${teams}`
    .replace(/[^\x20-\x7E]/g,"").substring(0,100);
  const body = (result.telegram_message||`${teams}\n${result.player}@${result.odds}\nEdge:+${result.edge_pct}%\nStake:${result.stake_pct}%\n\nLecture froide. Zero emotion.`)
    .replace(/[^\x20-\x7E\n]/g,"").substring(0,4000);
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Content-Type":"text/plain", "Title":title, "Priority":result.decision==="CORE"?"urgent":"high", "Tags":"chart_with_upwards_trend" },
      body
    });
    if (res.ok) console.log(`[NTFY] OK: ${teams} | ${result.decision} | +${result.edge_pct}%`);
    else console.log(`[NTFY ERR] ${res.status}`);
  } catch(e) { console.error("[NTFY ERR]:", e.message); }
}

// ============================================================
// SCAN PRINCIPAL
// ============================================================
async function scan(isLiveRound=false) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  console.log(`\n[SCAN] ${now} - ${isLiveRound?"LIVE":"PRE-MATCH"}`);

  const matches = [];
  const tennisComps = await getTennisCompetitions();
  const tennisMatches = await fetchMatches(tennisComps, isLiveRound);
  matches.push(...tennisMatches.map(m => ({ ...m, sport:"tennis" })));

  if (!isLiveRound) {
    const footMatches = await fetchMatches(FOOTBALL_COMPETITIONS, false);
    matches.push(...footMatches.map(m => ({ ...m, sport:"football" })));
  }

  // Filtre 48h
  const limit = new Date();
  limit.setHours(limit.getHours()+48);
  const filtered = matches.filter(m => m.isLive||new Date(m.commence_time)<=limit);
  console.log(`[48H] ${filtered.length}/${matches.length} matchs`);

  filtered.sort((a,b) => {
    if (a.isLive&&!b.isLive) return -1;
    if (!a.isLive&&b.isLive) return 1;
    return new Date(a.commence_time)-new Date(b.commence_time);
  });

  const stats = getTrackingStats();
  console.log(`[STATS] ${stats.total} picks | W:${stats.wins} L:${stats.losses} | ROI:${stats.roi} | WR:${stats.winrate}`);

  // 1 seul match par scan pour eviter le rate limit
  for (const match of filtered.slice(0,1)) {
    const teams = `${match.home_team} vs ${match.away_team}`;
    const key = `${match.id}-${match.sport}`;
    if (sentPicks.has(key)) { console.log(`[CACHE] ${teams}`); continue; }

    try {
      const result = match.sport==="tennis"
        ? await runTennisPipeline(match)
        : await runFootballPipeline(match);

      if (result) {
        sentPicks.add(key);
        savePick(result, teams, match.sport);
        await sendNotification(result, teams, match.sport);
        setTimeout(() => sentPicks.delete(key), 6*60*60*1000);
      } else {
        recordSkip();
      }
    } catch(e) { console.error(`[ERR] ${teams}:`, e.message); }
  }
}

// ============================================================
// DEMARRAGE
// ============================================================
console.log("\nUNPRICED v2 - 5 Agents + Elo + Pinnacle + Tracking");
console.log(`ntfy: ${NTFY_TOPIC} | Edge: ${EDGE_THRESHOLD}%`);

const initStats = getTrackingStats();
console.log(`[TRACKING] ${initStats.total} picks | ROI: ${initStats.roi} | WR: ${initStats.winrate}`);

cron.schedule("*/30 * * * *", () => scan(false));
cron.schedule("*/10 * * * *", () => scan(true));
cron.schedule("0 22 * * *", () => updateResults(), { timezone: "Europe/Paris" });
cron.schedule("0 23 * * *", () => sendDailyReport(), { timezone: "Europe/Paris" });

console.log("[CRON] Pre-match:30min | Live:10min | Resultats:22h | Rapport:23h");

const delay = parseInt(process.env.STARTUP_DELAY||"30")*1000;
console.log(`[INIT] Scan dans ${delay/1000}s...`);
setTimeout(() => scan(false), delay);
