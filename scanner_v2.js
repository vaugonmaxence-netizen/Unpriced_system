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

  // Alerte si trop de picks consecutifs
  if (tracking.session.consecutive_actions >= 5) {
    console.log(`[ALERTE] ${tracking.session.consecutive_actions} picks consecutifs - seuil peut-etre trop bas`);
  }

  try {
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
    console.log(`[TRACKING] Sauvegarde: ${teams} | ${pick.player} @ ${pick.odds}`);
  } catch(e) {
    console.error("[TRACKING ERR]:", e.message);
  }
  return entry;
}

function recordSkip() {
  const tracking = loadTracking();
  tracking.session.consecutive_skips = (tracking.session.consecutive_skips || 0) + 1;
  tracking.session.consecutive_actions = 0;
  try {
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
  } catch(e) {}
}

function getTrackingStats() {
  const tracking = loadTracking();
  const { picks } = tracking;
  const resolved = picks.filter(p => p.result !== "PENDING");
  const wins = resolved.filter(p => p.result === "WIN").length;
  const losses = resolved.filter(p => p.result === "LOSS").length;
  const totalStaked = resolved.reduce((s, p) => s + (p.stake_pct || 1), 0);
  const totalReturned = resolved
    .filter(p => p.result === "WIN")
    .reduce((s, p) => s + (p.stake_pct || 1) * (p.odds || 1), 0);
  const roi = totalStaked > 0 ? ((totalReturned - totalStaked) / totalStaked * 100).toFixed(2) : 0;
  return {
    total: picks.length,
    pending: picks.filter(p => p.result === "PENDING").length,
    wins,
    losses,
    roi: `${roi}%`,
    winrate: resolved.length > 0 ? `${(wins / resolved.length * 100).toFixed(1)}%` : "N/A",
    consecutive_skips: tracking.session?.consecutive_skips || 0,
    consecutive_actions: tracking.session?.consecutive_actions || 0
  };
}

// ============================================================
// MISE A JOUR AUTOMATIQUE DES RESULTATS
// ============================================================
async function updateResults() {
  console.log("\n[RESULTATS] Verification des picks PENDING...");
  const tracking = loadTracking();
  const pending = tracking.picks.filter(p => p.result === "PENDING");

  if (pending.length === 0) {
    console.log("[RESULTATS] Aucun pick en attente");
    return;
  }

  console.log(`[RESULTATS] ${pending.length} picks a verifier`);
  let updated = 0;

  for (const pick of pending) {
    const pickTime = new Date(pick.date);
    const hoursSince = (Date.now() - pickTime.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 1) {
      console.log(`[RESULTATS] Trop recent: ${pick.teams}`);
      continue;
    }

    try {
      console.log(`[RESULTATS] Recherche: ${pick.teams} | ${pick.player}`);

      const prompt = `Tu es un verificateur de resultats tennis/football.

PICK A VERIFIER:
Match: ${pick.teams}
Joueur/Equipe mise: ${pick.player}
Sport: ${pick.sport}
Date du pick: ${pick.date}

INSTRUCTIONS:
Recherche le resultat de ce match sur flashscore.com, livescore.com, atptour.com ou wtatennis.com.
Determine si ${pick.player} a gagne ou perdu.
Si match pas encore joue ou resultat introuvable -> PENDING.
Si abandon ou retire -> VOID.

Reponds UNIQUEMENT en JSON:
{"result":"WIN/LOSS/PENDING/VOID","score":"score si trouve","source":"site consulte"}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      });

      const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) continue;

      const data = JSON.parse(m[0]);
      console.log(`[RESULTATS] ${pick.teams} -> ${data.result} | ${data.score || "?"}`);

      if (data.result === "WIN" || data.result === "LOSS" || data.result === "VOID") {
        pick.result = data.result;
        pick.score = data.score || "";
        pick.profit = data.result === "WIN"
          ? (pick.stake_pct || 1) * (pick.odds - 1)
          : data.result === "LOSS"
          ? -(pick.stake_pct || 1)
          : 0;
        updated++;
      }

      await new Promise(r => setTimeout(r, 5000));
    } catch(e) {
      console.error(`[RESULTATS ERR] ${pick.teams}:`, e.message);
    }
  }

  if (updated > 0) {
    try {
      fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
      console.log(`[RESULTATS] ${updated} picks mis a jour`);
    } catch(e) {
      console.error("[RESULTATS SAVE ERR]:", e.message);
    }
  }
}

// ============================================================
// RAPPORT QUOTIDIEN 23H00
// ============================================================
async function sendDailyReport() {
  console.log("\n[RAPPORT] Generation bilan quotidien...");
  const tracking = loadTracking();
  const today = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });

  const todayPicks = tracking.picks.filter(p => {
    const pickDate = new Date(p.date).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
    return pickDate === today;
  });

  if (todayPicks.length === 0) {
    console.log("[RAPPORT] Aucun pick aujourd hui");
    return;
  }

  const pending = todayPicks.filter(p => p.result === "PENDING");
  const wins = todayPicks.filter(p => p.result === "WIN");
  const losses = todayPicks.filter(p => p.result === "LOSS");
  const voids = todayPicks.filter(p => p.result === "VOID");

  const resolved = todayPicks.filter(p => p.result !== "PENDING" && p.result !== "VOID");
  const totalStaked = resolved.reduce((s, p) => s + (p.stake_pct || 1), 0);
  const totalReturned = wins.reduce((s, p) => s + (p.stake_pct || 1) * (p.odds || 1), 0);
  const profitUnits = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? ((profitUnits / totalStaked) * 100).toFixed(1) : 0;
  const bilan = profitUnits > 0 ? "POSITIF" : profitUnits < 0 ? "NEGATIF" : "NEUTRE";

  const allStats = getTrackingStats();

  let lines = [
    `UNPRICED - Bilan ${today}`,
    ``,
    `PICKS DU JOUR: ${todayPicks.length}`,
    `Wins: ${wins.length} | Losses: ${losses.length} | Void: ${voids.length} | Pending: ${pending.length}`,
    ``
  ];

  todayPicks.forEach(p => {
    const status = p.result === "WIN" ? "WIN" :
                   p.result === "LOSS" ? "LOSS" :
                   p.result === "VOID" ? "VOID" : "PENDING";
    const profitStr = p.result === "WIN"
      ? `+${((p.stake_pct || 1) * (p.odds - 1)).toFixed(2)}u`
      : p.result === "LOSS"
      ? `-${(p.stake_pct || 1).toFixed(2)}u`
      : p.result === "VOID" ? "rembourse" : "en attente";
    const score = p.score ? ` (${p.score})` : "";
    const markets = p.markets_checked?.length > 1 ? ` [${p.markets_checked.join(",")}]` : "";
    lines.push(`${status} | ${p.player} @ ${p.odds} - ${p.stake_pct}%${score}${markets} | ${profitStr}`);
  });

  lines = lines.concat([
    ``,
    `BILAN JOUR:`,
    `Mise totale: ${totalStaked.toFixed(2)} unites`,
    `Retour: ${totalReturned.toFixed(2)} unites`,
    `Profit: ${profitUnits >= 0 ? "+" : ""}${profitUnits.toFixed(2)} unites`,
    `ROI jour: ${roi}%`,
    `Resultat: ${bilan}`,
    ``,
    `STATS GLOBALES:`,
    `Total: ${allStats.total} picks | WR: ${allStats.winrate} | ROI: ${allStats.roi}`,
    ``,
    `Lecture froide. Zero emotion.`
  ]);

  const message = lines.join("\n");
  const title = `UNPRICED Bilan ${today} ROI ${roi}% ${bilan}`
    .replace(/[^\x20-\x7E]/g, "").substring(0, 100);

  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Title": title,
        "Priority": profitUnits >= 0 ? "high" : "default",
        "Tags": profitUnits >= 0 ? "white_check_mark" : "x"
      },
      body: message
    });
    console.log(`[RAPPORT] OK - ROI: ${roi}% | ${bilan}`);
  } catch(e) {
    console.error("[RAPPORT ERR]:", e.message);
  }
}

// ============================================================
// MODELE ELO
// ============================================================
async function getEloData(playerA, playerB, surface) {
  try {
    const params = new URLSearchParams({
      player_a: playerA, player_b: playerB,
      surface: surface || "Clay"
    });
    const res = await fetch(`${MODEL_API_URL}/predict?${params}`, { timeout: 5000 });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.prob_a) return null;
    return {
      elo_a: data.elo_a,
      elo_b: data.elo_b,
      prob_a_pct: data.prob_a_pct,
      prob_b_pct: data.prob_b_pct,
      fair_odds_a: data.fair_odds_a,
      fair_odds_b: data.fair_odds_b,
      confidence: data.confidence,
      matches_a: data.matches_a,
      matches_b: data.matches_b
    };
  } catch {
    return null;
  }
}

// ============================================================
// SURFACE
// ============================================================
function getSurface(sportTitle, sportKey) {
  const text = ((sportTitle || "") + " " + (sportKey || "")).toLowerCase();
  if (text.includes("wimbledon") || text.includes("grass") ||
      text.includes("queens") || text.includes("halle") ||
      text.includes("eastbourne") || text.includes("nottingham")) return "Grass";
  if (text.includes("australian") || text.includes("us open") ||
      text.includes("miami") || text.includes("indian wells") ||
      text.includes("cincinnati") || text.includes("toronto") ||
      text.includes("montreal") || text.includes("beijing") ||
      text.includes("shanghai") || text.includes("vienna") ||
      text.includes("basel") || text.includes("doha") ||
      text.includes("dubai") || text.includes("rotterdam")) return "Hard";
  return "Unknown";
}

// ============================================================
// COMPETITIONS
// ============================================================
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
    console.log(`[TENNIS COMPS] ${comps.length} tournois: ${comps.join(", ")}`);
    return comps;
  } catch(e) {
    console.error("[TENNIS COMPS ERR]:", e.message);
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
  let pinnacleA = 0, pinnacleB = 0;
  for (const bm of match.bookmakers || []) {
    const market = bm.markets?.[0];
    if (!market) continue;
    for (const o of market.outcomes) {
      if (o.name === match.home_team) {
        bestA = Math.max(bestA, o.price);
        if (bm.key === "pinnacle") pinnacleA = o.price;
      }
      if (o.name === match.away_team) {
        bestB = Math.max(bestB, o.price);
        if (bm.key === "pinnacle") pinnacleB = o.price;
      }
    }
  }
  return { oddsA: bestA, oddsB: bestB, pinnacleA, pinnacleB };
}

// ============================================================
// AGENT CALLER
// ============================================================
async function callAgent(prompt, useSearch = false) {
  const params = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }]
  };
  if (useSearch) {
    params.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const response = await anthropic.messages.create(params);
  const text = response.content.map(b => b.type === "text" ? b.text : "").join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ============================================================
// PIPELINE TENNIS 5 AGENTS
// ============================================================
async function runTennisPipeline(match) {
  const surface = getSurface(match.sport_title, match.sport_key);
  const playerA = match.home_team || "";
  const playerB = match.away_team || "";
  const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(match);
  const tournament = match.sport_title || "";
  const isLive = match.isLive || false;

  if (!oddsA || !oddsB) return null;

  const eloData = await getEloData(playerA, playerB, surface === "Unknown" ? "Clay" : surface);

  const pinnacleInfo = (pinnacleA && pinnacleB)
    ? `Pinnacle (reference mondiale, marge 1.5%): ${playerA} @ ${pinnacleA} / ${playerB} @ ${pinnacleB}
- Prob implicite Pinnacle no-vig: ${playerA} ${(1/pinnacleA/(1/pinnacleA+1/pinnacleB)*100).toFixed(1)}% / ${playerB} ${(1/pinnacleB/(1/pinnacleA+1/pinnacleB)*100).toFixed(1)}%`
    : `Pinnacle: non disponible - utilise la meilleure cote du marche comme reference`;

  const eloInfo = eloData
    ? `MODELE ELO (base mathematique 42000 matchs ATP):
- ${playerA}: Elo ${eloData.elo_a} | Proba ${eloData.prob_a_pct}% | Cote juste ${eloData.fair_odds_a}
- ${playerB}: Elo ${eloData.elo_b} | Proba ${eloData.prob_b_pct}% | Cote juste ${eloData.fair_odds_b}
- Fiabilite: ${eloData.confidence} (${eloData.matches_a} matchs A / ${eloData.matches_b} matchs B)
- Edge brut Elo vs marche: A=${((eloData.prob_a_pct/100 - 1/oddsA)*100).toFixed(1)}% / B=${((eloData.prob_b_pct/100 - 1/oddsB)*100).toFixed(1)}%`
    : `MODELE ELO: non disponible - base toi sur tes recherches web`;

  const surfaceInfo = surface === "Unknown"
    ? `Surface inconnue - cherche "surface ${tournament} 2026" en priorite`
    : `Surface: ${surface}`;

  console.log(`\n[PIPELINE] ${playerA} vs ${playerB} | ${surface} | ${oddsA}/${oddsB} | Pinnacle: ${pinnacleA}/${pinnacleB}`);
  if (eloData) console.log(`[ELO] ${playerA}: ${eloData.prob_a_pct}% | ${playerB}: ${eloData.prob_b_pct}%`);

  // ── AGENT 1 : ANALYSTE ─────────────────────────────────
  console.log(`[AGENT 1] Analyse...`);
  const analyst = await callAgent(`Tu es un analyste EV+ tennis professionnel. Ton objectif est de trouver des erreurs de marche exploitables.

MATCH: ${playerA} @ ${oddsA} vs ${playerB} @ ${oddsB}
Tournoi: ${tournament}
${surfaceInfo}
${isLive ? "STATUT: LIVE - analyse rapide requise" : "STATUT: PRE-MATCH"}

${pinnacleInfo}

${eloInfo}

ROLE DU MODELE ELO:
Le modele Elo fournit une base mathematique historique sur 42000 matchs ATP.
- Si Elo confirme un edge ET tu trouves des facteurs supplementaires -> edge solide
- Si Elo dit SKIP mais tu trouves une info majeure recente -> peut justifier un pick
- Si Elo dit edge mais Pinnacle a deja price l info -> edge mort, SKIP
- La reference finale est TOUJOURS Pinnacle, pas les autres bookmakers

RECHERCHE OBLIGATOIRE - utilise web search sur ces sources:
1. atptour.com ou wtatennis.com : classement et resultats des 14 derniers jours
2. tennisabstract.com : stats head-to-head par surface, forme recente et qualite adversaires
3. Presse sportive L Equipe BBC Sport Eurosport Tennis.com : infos 14 derniers jours
4. Si blessure suspectee : cherche "[joueur] injury 2026" ET "[joueur] blessure 2026"
5. Si surface inconnue : cherche "surface [tournoi] 2026" en priorite absolue

VERIFIE OBLIGATOIREMENT (minimum 2 sources independantes):
1. Resultats 14 derniers jours - victoires/defaites ET qualite des adversaires battus
2. Fatigue : matchs joues cette semaine et semaine precedente
3. Blessures ou pepins physiques confirmes par la presse
4. Head-to-head sur cette surface specifiquement
5. Forme sur cette surface saison 2026
6. Pinnacle a-t-il deja integre ces infos dans ses cotes ?
7. Niveau tournoi : Challenger/250 marche moins efficient vs Masters/GC tres efficient

MARCHES ALTERNATIFS A VERIFIER:
En plus du ML, verifie si un edge existe sur:
- Handicap sets (ex: favori -1.5 sets)
- Total sets (over/under 2.5 sets)
- Score exact (ex: 2-0 si domination claire)
Ces marches sont souvent moins efficients que le ML.

REGLES STRICTES:
- Edge < ${EDGE_THRESHOLD}% vs Pinnacle -> SKIP obligatoire
- Cote < 1.60 -> edge minimum 5% requis
- Favori < 1.30 -> SKIP sauf blessure confirmee adverse
- Grand Chelem ou Masters 1000 -> SKIP si edge < 5%
- Challenger ou ATP 250 -> seuil normal
- Info incertaine sur une seule source -> cherche confirmation
- En cas de doute -> SKIP, ne force jamais un pick

Reponds en JSON:
{"decision":"CORE/ACTION/SKIP","edge_estimate":"X%","player":"nom exact","odds":X.XX,"market":"ML/handicap/total_sets","facteurs":["f1","f2","f3"],"qualite_adversaires":"evaluation","prob_estimee":"X%","surface_confirmed":"Clay/Hard/Grass","elo_confirme":true,"pinnacle_reference":true,"rationale":"explication avec sources"}`, true);

  if (!analyst || analyst.decision === "SKIP") {
    console.log(`[AGENT 1] SKIP - ${analyst?.rationale || "pas d edge"}`);
    recordSkip();
    return null;
  }

  const edgeNum = parseFloat((analyst.edge_estimate || "0").replace("%", "").replace("+", ""));
  if (edgeNum < EDGE_THRESHOLD) {
    console.log(`[AGENT 1] SKIP - Edge ${edgeNum}% insuffisant`);
    recordSkip();
    return null;
  }

  console.log(`[AGENT 1] ${analyst.decision} | Edge: ${analyst.edge_estimate} | ${analyst.player} | Marche: ${analyst.market}`);
  await new Promise(r => setTimeout(r, 4000));

  // ── AGENT 2 : CONTRE-ANALYSTE ───────────────────────────
  console.log(`[AGENT 2] Contre-analyse...`);
  const counter = await callAgent(`Tu es un contre-analyste EV+ professionnel. Ton seul objectif est de trouver pourquoi ce bet est mauvais.

MATCH: ${playerA} vs ${playerB} | ${tournament}
ANALYSE A CHALLENGER: ${JSON.stringify(analyst)}
DONNEES ELO: ${JSON.stringify(eloData)}
COTES ACTUELLES: ${playerA} @ ${oddsA} / ${playerB} @ ${oddsB}
PINNACLE: ${pinnacleA ? `${playerA} @ ${pinnacleA} / ${playerB} @ ${pinnacleB}` : "non disponible"}

CHERCHE ACTIVEMENT sur le web:
1. Les cotes Pinnacle ont-elles bouge depuis l analyse ? Recalcule l edge avec les cotes actuelles.
2. La fatigue est-elle deja pricee par Pinnacle ?
3. Y a-t-il une information sur l adversaire qui change tout ?
4. Les stats surface sont-elles biaisees par adversaires trop faibles ?
5. Le head-to-head recent contredit-il la tendance ?
6. Le modele Elo a-t-il des donnees insuffisantes sur ce joueur ?
7. Y a-t-il des matchs des 7 derniers jours qui contredisent l analyse ?
8. L edge sur le marche alternatif choisi est-il reel ou illusion ?
9. La qualite des adversaires recents est-elle vraiment representative ?

VERIFICATION COTES EN TEMPS REEL:
Cherche les cotes actuelles sur bet365, pinnacle ou oddsportal pour ce match.
Si les cotes ont bouge de plus de 10% depuis l analyse -> edge potentiellement mort.

Reponds en JSON:
{"decision":"CONFIRME/FAIBLE/REFUS","edge_reel":"X%","cotes_verifiees":true,"mouvement_cotes":"stable/monte/baisse","erreurs":["e1","e2"],"warning":"risque principal","rationale":"explication"}`, true);

  if (!counter || counter.decision === "REFUS") {
    console.log(`[AGENT 2] REFUS - ${counter?.warning || "edge invalide"}`);
    recordSkip();
    return null;
  }

  console.log(`[AGENT 2] ${counter.decision} | Edge reel: ${counter.edge_reel} | Cotes: ${counter.mouvement_cotes}`);
  await new Promise(r => setTimeout(r, 4000));

  // ── AGENT 3 : DECIDEUR FINAL ────────────────────────────
  console.log(`[AGENT 3] Decision finale...`);
  const final = await callAgent(`Tu es le decideur final EV+. Tranche definitivement.

MATCH: ${playerA} vs ${playerB} | ${tournament}
ANALYSE INITIALE: ${JSON.stringify(analyst)}
CONTRE-ANALYSE: ${JSON.stringify(counter)}
DONNEES ELO: ${JSON.stringify(eloData)}
MOUVEMENT COTES: ${counter?.mouvement_cotes || "inconnu"}

CRITERES DE VALIDATION:
1. L edge survit-il a la contradiction ET au mouvement des cotes ?
2. Les infos sont-elles verifiees sur minimum 2 sources independantes ?
3. Pinnacle n a-t-il pas deja integre ces informations ?
4. La confiance Elo est-elle HIGH ou MEDIUM ?
5. Le marche choisi est-il le plus inefficient disponible ?
6. Le ratio risque/rendement justifie la mise ?

GESTION DES SERIES:
Si beaucoup de picks consecutifs aujourd hui -> etre plus strict.
Si beaucoup de SKIP consecutifs -> verifier si le seuil est trop haut.

DECISION:
- CORE : edge > 4%, confirmation forte, Pinnacle confirme, sources multiples
- ACTION : edge 2-4%, bonne confirmation, doutes mineurs
- REFUS : contre-analyse fatale, edge mort ou cotes trop bougees
- SKIP : insuffisant ou trop incertain

Reponds en JSON:
{"decision":"CORE/ACTION/REFUS/SKIP","edge_final":"X%","player":"nom exact","odds":X.XX,"market":"ML/handicap/total_sets","confidence":"HIGH/MEDIUM/LOW","validation":"1 phrase"}`);

  if (!final || final.decision === "REFUS" || final.decision === "SKIP") {
    console.log(`[AGENT 3] ${final?.decision} - ${final?.validation}`);
    recordSkip();
    return null;
  }

  console.log(`[AGENT 3] ${final.decision} | Edge: ${final.edge_final} | Marche: ${final.market} | Confiance: ${final.confidence}`);
  await new Promise(r => setTimeout(r, 4000));

  // ── AGENT 4 : BANKROLL ──────────────────────────────────
  console.log(`[AGENT 4] Bankroll sizing...`);
  const bankroll = await callAgent(`Tu es un gestionnaire de bankroll professionnel specialise en value betting tennis.

DECISION FINALE: ${JSON.stringify(final)}
CONFIANCE ELO: ${eloData?.confidence || "inconnue"}
CONTRE-ANALYSE: ${JSON.stringify(counter)}
MARCHE: ${final.market || "ML"}
COTE: ${final.odds}
MOUVEMENT COTES: ${counter?.mouvement_cotes || "inconnu"}

REGLES DE SIZING:
- CORE edge > 4%: 1% a 2% de bankroll
- ACTION edge 2-4%: 0.5% a 1% de bankroll
- Confiance ELO HIGH -> haut du range
- Confiance ELO MEDIUM ou LOW -> bas du range
- Cote > 3.00 -> reduire de 25% variance elevee
- Warning contre-analyse -> reduire de 25%
- Cotes en mouvement baisse -> reduire de 25%
- Marche alternatif handicap/sets -> reduire de 15% liquidite inferieure
- Maximum absolu: 2% jamais plus

Reponds en JSON:
{"stake_pct":"X%","type":"CORE/ACTION","justification":"1 phrase"}`);

  await new Promise(r => setTimeout(r, 4000));

  // ── AGENT 5 : TIPSTER ───────────────────────────────────
  console.log(`[AGENT 5] Message tipster...`);
  const stake = bankroll?.stake_pct || (final.decision === "CORE" ? "1.5%" : "0.75%");
  const surfaceFinal = analyst.surface_confirmed || surface;
  const marketLabel = final.market || analyst.market || "ML";

  const tipster = await callAgent(`Tu es le tipster final UNPRICED. Genere le message de publication Telegram.

DONNEES:
Match: ${playerA} vs ${playerB}
Tournoi: ${tournament} | Surface: ${surfaceFinal}
Pick: ${final.player} @ ${final.odds} sur marche ${marketLabel}
Stake: ${stake}
Edge: ${final.edge_final}
Decision: ${final.decision}
Confiance: ${final.confidence}
Facteurs: ${analyst.facteurs?.join(", ")}
Qualite adversaires recents: ${analyst.qualite_adversaires || "non evaluee"}
ELO: ${eloData ? `${playerA} ${eloData.prob_a_pct}% vs ${playerB} ${eloData.prob_b_pct}% cotes justes ${eloData.fair_odds_a}/${eloData.fair_odds_b}` : "non disponible"}
Pinnacle: ${pinnacleA ? `${playerA} @ ${pinnacleA} / ${playerB} @ ${pinnacleB}` : "non disponible"}
Validation: ${final.validation}
Warning: ${counter?.warning || "aucun"}
Statut: ${isLive ? "LIVE" : "PRE-MATCH"}

STYLE UNPRICED: froid, factuel, concis, zero emotion.
IMPORTANT: ASCII uniquement. Pas d emojis. Pas d accents. Pas de caracteres speciaux.

FORMAT EXACT:
UNPRICED Tennis${isLive ? " LIVE" : ""}
[Tournoi] - [Round si connu]

[Joueur] @ [cote] - [stake]% [marche si pas ML]
Value: +X%
Proba modele: ~X%
Pinnacle ref: [cote Pinnacle si dispo]
---
Contexte: [biais marche principal en 1 ligne]
Edge: [1-2 facteurs cles verifies avec sources]
Scenario: [lecture du match en 1-2 phrases]
---
Lecture froide. Zero emotion.

Reponds en JSON:
{"telegram_message":"message complet"}`);

  const message = tipster?.telegram_message ||
    `UNPRICED Tennis${isLive ? " LIVE" : ""}\n${tournament}\n\n${final.player} @ ${final.odds} - ${stake}\nValue: +${final.edge_final}\nProba: ~${analyst.prob_estimee}\n---\n${final.validation}\n---\nLecture froide. Zero emotion.`;

  return {
    player: final.player,
    odds: final.odds,
    edge_pct: parseFloat((final.edge_final || "0").replace("%", "").replace("+", "")),
    stake_pct: parseFloat((stake || "1").replace("%", "")),
    decision: final.decision,
    confidence: final.confidence,
    telegram_message: message,
    isLive,
    source: "pipeline_5agents",
    elo_used: !!eloData,
    markets_checked: ["ML", "handicap", "total_sets"],
    market_selected: marketLabel
  };
}

// ============================================================
// PIPELINE FOOTBALL
// ============================================================
async function runFootballPipeline(match) {
  const { oddsA, oddsB, pinnacleA, pinnacleB } = getBestOdds(match);
  if (!oddsA || !oddsB) return null;

  console.log(`\n[FOOT PIPELINE] ${match.home_team} vs ${match.away_team}`);

  const pinnacleInfo = (pinnacleA && pinnacleB)
    ? `Pinnacle: ${match.home_team} @ ${pinnacleA} / ${match.away_team} @ ${pinnacleB}`
    : `Pinnacle: non disponible`;

  const analyst = await callAgent(`Tu es un analyste EV+ football professionnel. Le marche foot est TRES efficient - sois EXTREMEMENT selectif.

MATCH: ${match.home_team} @ ${oddsA} vs ${match.away_team} @ ${oddsB}
Competition: ${match.sport_title}
${pinnacleInfo}

RECHERCHE OBLIGATOIRE:
1. Forme recente 5 derniers matchs chaque equipe avec qualite adversaires
2. Blessures et suspensions confirmees par la presse
3. Contexte enjeux classement rotation fatigue
4. Head-to-head recent 3 derniers matchs
5. Cotes Pinnacle comme reference absolue du marche efficient

REGLES STRICTES:
- Edge minimum vs Pinnacle: ${EDGE_THRESHOLD + 1}%
- SKIP si pas d info exclusive verifiee sur 2 sources
- SKIP si info deja dans les cotes Pinnacle
- En cas de doute -> SKIP obligatoire

Reponds en JSON:
{"decision":"ACTION/CORE/SKIP","edge_estimate":"X%","player":"equipe","odds":X.XX,"rationale":"explication avec sources"}`, true);

  if (!analyst || analyst.decision === "SKIP") {
    console.log(`[FOOT] SKIP - ${analyst?.rationale || "pas d edge"}`);
    return null;
  }

  const edgeNum = parseFloat((analyst.edge_estimate || "0").replace("%", "").replace("+", ""));
  if (edgeNum < EDGE_THRESHOLD + 1) {
    console.log(`[FOOT] SKIP - Edge ${edgeNum}% insuffisant`);
    return null;
  }

  await new Promise(r => setTimeout(r, 6000));

  const counter = await callAgent(`Tu es un contre-analyste football. Trouve pourquoi ce bet est mauvais.

MATCH: ${match.home_team} vs ${match.away_team} | ${match.sport_title}
ANALYSE: ${JSON.stringify(analyst)}
PINNACLE: ${pinnacleA ? `${match.home_team} @ ${pinnacleA} / ${match.away_team} @ ${pinnacleB}` : "non dispo"}

Verifie: cotes bougees ? marche deja price ? info fausse ? biais confirmation ?

Reponds en JSON:
{"decision":"CONFIRME/REFUS","edge_reel":"X%","mouvement_cotes":"stable/monte/baisse","warning":"risque principal"}`);

  if (!counter || counter.decision === "REFUS") {
    console.log(`[FOOT] REFUS contre-analyse`);
    return null;
  }

  const message = `UNPRICED Foot\n${match.sport_title}\n\n${analyst.player} @ ${analyst.odds} - 0.5%\nValue: +${analyst.edge_estimate}\n${pinnacleA ? `Pinnacle ref: ${analyst.player === match.home_team ? pinnacleA : pinnacleB}` : ""}\n---\n${analyst.rationale}\n---\nLecture froide. Zero emotion.`;

  return {
    player: analyst.player,
    odds: analyst.odds,
    edge_pct: edgeNum,
    stake_pct: 0.5,
    decision: analyst.decision,
    confidence: "MEDIUM",
    telegram_message: message,
    isLive: match.isLive || false,
    source: "pipeline_football",
    elo_used: false,
    markets_checked: ["ML"]
  };
}

// ============================================================
// NOTIFICATION NTFY
// ============================================================
async function sendNotification(result, teams, sport) {
  const sportLabel = sport === "tennis" ? "Tennis" : "Foot";
  const liveTag = result.isLive ? "LIVE " : "";
  const eloTag = result.elo_used ? " ELO" : "";
  const title = `${liveTag}UNPRICED ${sportLabel}${eloTag} ${result.decision} Edge+${result.edge_pct}% ${teams}`
    .replace(/[^\x20-\x7E]/g, "")
    .substring(0, 100);
  const body = (result.telegram_message || `${teams}\n${result.player} @ ${result.odds}\nEdge: +${result.edge_pct}%\nStake: ${result.stake_pct}%\n\nLecture froide. Zero emotion.`)
    .replace(/[^\x20-\x7E\n]/g, "")
    .substring(0, 4000);

  console.log(`[NTFY] Envoi: ${title}`);
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Title": title,
        "Priority": result.decision === "CORE" ? "urgent" : "high",
        "Tags": "chart_with_upwards_trend"
      },
      body
    });
    if (res.ok) {
      console.log(`[NTFY] OK: ${teams} | ${result.decision} | Edge +${result.edge_pct}%`);
    } else {
      const err = await res.text();
      console.log(`[NTFY ERR] ${res.status}: ${err}`);
    }
  } catch(e) {
    console.error("[NTFY ERR]:", e.message);
  }
}

// ============================================================
// SCAN PRINCIPAL
// ============================================================
async function scan(isLiveRound = false) {
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  console.log(`\n[SCAN] ${now} - ${isLiveRound ? "LIVE" : "PRE-MATCH"}`);

  const matches = [];
  const tennisComps = await getTennisCompetitions();
  const tennisMatches = await fetchMatches(tennisComps, isLiveRound);
  matches.push(...tennisMatches.map(m => ({ ...m, sport: "tennis" })));

  if (!isLiveRound) {
    const footMatches = await fetchMatches(FOOTBALL_COMPETITIONS, false);
    matches.push(...footMatches.map(m => ({ ...m, sport: "football" })));
  }

  const now48 = new Date();
  now48.setHours(now48.getHours() + 48);
  const filtered = matches.filter(m => {
    if (m.isLive) return true;
    return new Date(m.commence_time) <= now48;
  });
  console.log(`[FILTRE 48H] ${filtered.length}/${matches.length} matchs`);

  filtered.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(a.commence_time) - new Date(b.commence_time);
  });

  const stats = getTrackingStats();
  console.log(`[STATS] Total: ${stats.total} | W: ${stats.wins} | L: ${stats.losses} | ROI: ${stats.roi} | WR: ${stats.winrate} | SKIPS: ${stats.consecutive_skips} | PICKS: ${stats.consecutive_actions}`);

  for (const match of filtered.slice(0, 2)) {
    const teams = `${match.home_team} vs ${match.away_team}`;
    const key = `${match.id}-${match.sport}`;
    if (sentPicks.has(key)) {
      console.log(`[CACHE] Deja analyse: ${teams}`);
      continue;
    }

    try {
      let result = null;
      if (match.sport === "tennis") {
        result = await runTennisPipeline(match);
      } else {
        result = await runFootballPipeline(match);
      }

      if (result) {
        sentPicks.add(key);
        savePick(result, teams, match.sport);
        await sendNotification(result, teams, match.sport);
        setTimeout(() => sentPicks.delete(key), 6 * 60 * 60 * 1000);
      }

      await new Promise(r => setTimeout(r, 15000));
    } catch(e) {
      console.error(`[ERR] ${teams}:`, e.message);
    }
  }
}

// ============================================================
// DEMARRAGE
// ============================================================
console.log("\nUNPRICED v2 - Pipeline 5 Agents + Elo + Pinnacle + Tracking");
console.log(`ntfy: ${NTFY_TOPIC}`);
console.log(`Edge seuil: ${EDGE_THRESHOLD}%`);
console.log(`Model API: ${MODEL_API_URL}`);

const initStats = getTrackingStats();
console.log(`[TRACKING] ${initStats.total} picks | ROI: ${initStats.roi} | WR: ${initStats.winrate}`);

cron.schedule("*/30 * * * *", () => scan(false));
cron.schedule("*/10 * * * *", () => scan(true));
cron.schedule("0 22 * * *", () => updateResults(), { timezone: "Europe/Paris" });
cron.schedule("0 23 * * *", () => sendDailyReport(), { timezone: "Europe/Paris" });

console.log("[CRON] Pre-match: 30min | Live: 10min | Resultats: 22h | Rapport: 23h");

const startupDelay = parseInt(process.env.STARTUP_DELAY || "30") * 1000;
console.log(`[INIT] Premier scan dans ${startupDelay/1000}s...`);
setTimeout(() => scan(false), startupDelay);
