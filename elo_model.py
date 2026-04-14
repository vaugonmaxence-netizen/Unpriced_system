import json
import os
import math
from collections import defaultdict
from datetime import datetime

DATA_DIR = "data"
MODEL_DIR = "model"
os.makedirs(MODEL_DIR, exist_ok=True)

ELO_START = 1500
K_FACTOR = 32
K_NEW_PLAYER = 40
K_SLAM = 40
K_MASTERS = 36
REGRESSION_RATE = 0.1
SURFACES = ["Clay", "Hard", "Grass", "Carpet"]
SURFACE_ALIASES = {
    "clay": "Clay", "hard": "Hard", "grass": "Grass",
    "carpet": "Carpet", "indoor hard": "Hard", "outdoor hard": "Hard"
}

def normalize_surface(s):
    if not s:
        return "Hard"
    return SURFACE_ALIASES.get(s.lower().strip(), "Hard")

def elo_win_probability(elo_a, elo_b):
    return 1.0 / (1.0 + 10 ** ((elo_b - elo_a) / 400.0))

def update_elo(elo_w, elo_l, k_w, k_l):
    prob = elo_win_probability(elo_w, elo_l)
    return elo_w + k_w * (1 - prob), elo_l + k_l * (0 - (1 - prob))

def get_k(tourney_name, count):
    name = (tourney_name or "").lower()
    if count < 30: return K_NEW_PLAYER
    if any(s in name for s in ["roland","wimbledon","us open","australian"]): return K_SLAM
    if any(s in name for s in ["masters","monte","madrid","rome","canada","cincinnati"]): return K_MASTERS
    return K_FACTOR

class TennisEloModel:
    def __init__(self):
        self.elos = defaultdict(lambda: {s: ELO_START for s in SURFACES})
        self.elos_global = defaultdict(lambda: ELO_START)
        self.match_counts = defaultdict(int)
        self.player_names = {}
        self.predictions_log = []
        self.total_processed = 0
        self._last_year = None

    def _regress(self, year):
        if self._last_year is None or year <= self._last_year: return
        for pid in self.elos:
            for s in SURFACES:
                self.elos[pid][s] = ELO_START + (1 - REGRESSION_RATE) * (self.elos[pid][s] - ELO_START)
            self.elos_global[pid] = ELO_START + (1 - REGRESSION_RATE) * (self.elos_global[pid] - ELO_START)

    def process_match(self, match):
        wid = match.get("winner_id","")
        lid = match.get("loser_id","")
        if not wid or not lid: return
        score = match.get("score","")
        if score and any(x in score.upper() for x in ["W/O","RET","DEF","ABD"]): return
        surface = normalize_surface(match.get("surface","Hard"))
        date = match.get("tourney_date","")
        year = int(date[:4]) if date and len(date) >= 4 else 2020
        self._regress(year)
        self._last_year = year
        self.player_names[wid] = match.get("winner_name","")
        self.player_names[lid] = match.get("loser_name","")
        ew = self.elos[wid][surface]
        el = self.elos[lid][surface]
        pred = elo_win_probability(ew, el)
        self.predictions_log.append({"pred": pred, "surface": surface})
        kw = get_k(match.get("tourney_name",""), self.match_counts[wid])
        kl = get_k(match.get("tourney_name",""), self.match_counts[lid])
        nw, nl = update_elo(ew, el, kw, kl)
        self.elos[wid][surface] = nw
        self.elos[lid][surface] = nl
        gw, gl = update_elo(self.elos_global[wid], self.elos_global[lid], kw*0.8, kl*0.8)
        self.elos_global[wid] = gw
        self.elos_global[lid] = gl
        self.match_counts[wid] += 1
        self.match_counts[lid] += 1
        self.total_processed += 1

    def train(self, matches):
        print(f"\n[ELO] Entraînement sur {len(matches):,} matchs...")
        for i, m in enumerate(sorted(matches, key=lambda x: x.get("tourney_date",""))):
            self.process_match(m)
            if (i+1) % 10000 == 0:
                print(f"  {i+1:,}/{len(matches):,}...")
        correct = sum(1 for p in self.predictions_log if p["pred"] > 0.5)
        acc = round(correct / len(self.predictions_log) * 100, 2) if self.predictions_log else 0
        print(f"[ELO] ✅ Terminé — Accuracy: {acc}%")
        return {"accuracy": acc, "total": self.total_processed}

    def get_player_elo(self, name, surface="Hard"):
        surface = normalize_surface(surface)
        name_lower = name.lower().strip()
        found_id = None
        for pid, pname in self.player_names.items():
            if pname.lower().strip() == name_lower or name_lower in pname.lower():
                found_id = pid
                break
        if not found_id:
            return {"found": False, "player": name, "elo_surface": ELO_START, "elo_global": ELO_START, "surface": surface, "matches": 0}
        return {
            "found": True, "player": self.player_names[found_id],
            "elo_surface": round(self.elos[found_id][surface], 1),
            "elo_global": round(self.elos_global[found_id], 1),
            "elos_all_surfaces": {s: round(self.elos[found_id][s], 1) for s in SURFACES},
            "surface": surface, "matches": self.match_counts[found_id]
        }

    def predict_match(self, player_a, player_b, surface="Hard"):
        surface = normalize_surface(surface)
        da = self.get_player_elo(player_a, surface)
        db = self.get_player_elo(player_b, surface)
        ea, eb = da["elo_surface"], db["elo_surface"]
        prob_a = elo_win_probability(ea, eb)
        confidence = "HIGH" if (da["matches"] > 100 and db["matches"] > 100) else "MEDIUM" if (da["matches"] > 30 and db["matches"] > 30) else "LOW"
        return {
            "player_a": player_a, "player_b": player_b, "surface": surface,
            "elo_a": ea, "elo_b": eb,
            "prob_a": round(prob_a, 4), "prob_b": round(1-prob_a, 4),
            "prob_a_pct": round(prob_a*100, 1), "prob_b_pct": round((1-prob_a)*100, 1),
            "fair_odds_a": round(1/prob_a, 3) if prob_a > 0 else 99,
            "fair_odds_b": round(1/(1-prob_a), 3) if prob_a < 1 else 99,
            "confidence": confidence, "matches_a": da["matches"], "matches_b": db["matches"]
        }

    def calculate_edge(self, player_a, player_b, surface, odds_a, odds_b):
        pred = self.predict_match(player_a, player_b, surface)
        pa, pb = pred["prob_a"], pred["prob_b"]
        ia = 1/odds_a if odds_a > 0 else 0
        ib = 1/odds_b if odds_b > 0 else 0
        edge_a = round((pa - ia) / ia * 100, 2) if ia > 0 else 0
        edge_b = round((pb - ib) / ib * 100, 2) if ib > 0 else 0
        def classify(edge, odds):
            if odds < 1.60 and edge < 5: return "REFUS"
            if edge < 2: return "SKIP"
            if edge < 4: return "ACTION"
            return "CORE"
        return {
            **pred,
            "odds_a": odds_a, "odds_b": odds_b,
            "implied_prob_a": round(ia*100, 1), "implied_prob_b": round(ib*100, 1),
            "edge_a_pct": edge_a, "edge_b_pct": edge_b,
            "ev_a": round((pa*odds_a-1)*100, 2), "ev_b": round((pb*odds_b-1)*100, 2),
            "decision_a": classify(edge_a, odds_a), "decision_b": classify(edge_b, odds_b),
            "best_bet": player_a if edge_a > edge_b else player_b,
            "best_edge_pct": max(edge_a, edge_b)
        }

    def get_top_players(self, surface="Hard", top_n=20):
        surface = normalize_surface(surface)
        players = [{"player": n, "elo": round(self.elos[pid][surface], 1), "matches": self.match_counts[pid]}
                   for pid, n in self.player_names.items() if self.match_counts[pid] >= 50]
        return sorted(players, key=lambda x: x["elo"], reverse=True)[:top_n]

    def save(self, path=None):
        if path is None: path = os.path.join(MODEL_DIR, "elo_model.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "elos": {pid: dict(e) for pid, e in self.elos.items()},
                "elos_global": dict(self.elos_global),
                "match_counts": dict(self.match_counts),
                "player_names": self.player_names,
                "trained_at": datetime.now().isoformat(),
                "total_processed": self.total_processed
            }, f, ensure_ascii=False)
        print(f"[ELO] Modèle sauvegardé → {path}")

    @classmethod
    def load(cls, path=None):
        if path is None: path = os.path.join(MODEL_DIR, "elo_model.json")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Modèle non trouvé : {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        model = cls()
        for pid, elos in data["elos"].items(): model.elos[pid] = elos
        for pid, elo in data["elos_global"].items(): model.elos_global[pid] = elo
        for pid, count in data["match_counts"].items(): model.match_counts[pid] = count
        model.player_names = data["player_names"]
        model.total_processed = data.get("total_processed", 0)
        print(f"[ELO] Modèle chargé — {model.total_processed:,} matchs")
        return model
