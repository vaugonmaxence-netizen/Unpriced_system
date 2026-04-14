import json
import os

def kelly_criterion(prob, odds, fraction=0.25):
    b = odds - 1
    q = 1 - prob
    kelly = (b * prob - q) / b
    return max(0, kelly * fraction)

class MatchAnalyzer:
    def __init__(self, elo_model):
        self.model = elo_model

    def analyze(self, player_a, player_b, surface, odds_a, odds_b, tournament="", round_name=""):
        edge_data = self.model.calculate_edge(player_a, player_b, surface, odds_a, odds_b)
        results = []

        for player, odds, edge_pct, prob, side in [
            (player_a, odds_a, edge_data["edge_a_pct"], edge_data["prob_a"], "a"),
            (player_b, odds_b, edge_data["edge_b_pct"], edge_data["prob_b"], "b")
        ]:
            if edge_pct < 2: continue
            if odds < 1.60 and edge_pct < 5: continue

            kelly_pct = round(kelly_criterion(prob, odds) * 100, 2)
            decision = edge_data[f"decision_{side}"]

            if decision == "CORE": stake = min(kelly_pct, 2.0)
            elif decision == "ACTION": stake = min(kelly_pct, 1.0)
            else: stake = min(kelly_pct, 0.75)
            stake = max(round(stake, 2), 0.25)

            results.append({
                "player": player,
                "opponent": player_b if player == player_a else player_a,
                "surface": surface,
                "tournament": tournament,
                "round": round_name,
                "odds": odds,
                "prob_model_pct": round(prob * 100, 1),
                "prob_implied_pct": edge_data[f"implied_prob_{side}"],
                "edge_pct": edge_pct,
                "fair_odds": edge_data[f"fair_odds_{side}"],
                "decision": decision,
                "stake_pct": stake,
                "confidence": edge_data["confidence"],
                "elo_player": edge_data[f"elo_{side}"],
                "elo_opponent": edge_data["elo_b" if side == "a" else "elo_a"],
                "matches_played": edge_data[f"matches_{side}"]
            })

        return {
            "match": f"{player_a} vs {player_b}",
            "surface": surface,
            "has_value": len(results) > 0,
            "value_bets": sorted(results, key=lambda x: x["edge_pct"], reverse=True),
            "elo_data": edge_data
        }

    def format_telegram_message(self, analysis, sport_emoji="🎾", is_live=False):
        if not analysis["has_value"]: return ""
        best = analysis["value_bets"][0]
        live_tag = "🔴 LIVE · " if is_live else ""
        tournament = best.get("tournament", "ATP")
        round_name = best.get("round", "")
        lines = [
            f"{sport_emoji} {live_tag}{tournament}{' · ' + round_name if round_name else ''}",
            "",
            f"{best['player']} @ {best['odds']} · {best['stake_pct']}%",
            f"Value estimée : +{best['edge_pct']}%",
            f"Proba modèle : ~{best['prob_model_pct']}%",
            "—",
            f"Elo {best['surface']} : {best['elo_player']} vs {best['elo_opponent']}",
            f"Edge : proba modèle {best['prob_model_pct']}% vs implicite {best['prob_implied_pct']}%",
            f"Cote juste calculée : {best['fair_odds']}",
            "—",
            "Lecture froide. Zéro émotion."
        ]
        return "\n".join(lines)
