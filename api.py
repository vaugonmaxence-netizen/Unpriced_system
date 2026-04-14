import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("MODEL_API_PORT", 8080))

def load_model():
    from elo_model import TennisEloModel
    from calibrator import MatchAnalyzer
    try:
        model = TennisEloModel.load()
        analyzer = MatchAnalyzer(model)
        print(f"[API] ✅ Modèle chargé — {model.total_processed:,} matchs")
        return model, analyzer
    except FileNotFoundError:
        print("[API] ⚠ Modèle non trouvé. Lance d'abord train.py")
        return None, None

class ModelHandler(BaseHTTPRequestHandler):
    model = None
    analyzer = None

    def log_message(self, format, *args): pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)
        def p(key, default=""): return params.get(key, [default])[0]

        if path == "/health":
            self.send_json({"status": "ok", "model_loaded": self.model is not None,
                           "matches_trained": self.model.total_processed if self.model else 0})

        elif path == "/predict":
            if not self.model:
                self.send_json({"error": "Model not loaded"}, 503); return
            result = self.model.predict_match(p("player_a"), p("player_b"), p("surface", "Hard"))
            self.send_json(result)

        elif path == "/analyze":
            if not self.analyzer:
                self.send_json({"error": "Model not loaded"}, 503); return
            try:
                odds_a = float(p("odds_a", "0"))
                odds_b = float(p("odds_b", "0"))
            except ValueError:
                self.send_json({"error": "odds invalides"}, 400); return
            analysis = self.analyzer.analyze(
                p("player_a"), p("player_b"), p("surface", "Hard"),
                odds_a, odds_b, p("tournament"), p("round")
            )
            if analysis["has_value"]:
                analysis["telegram_message"] = self.analyzer.format_telegram_message(
                    analysis, is_live=p("live","false") == "true"
                )
            analysis.pop("elo_data", None)
            self.send_json(analysis)

        elif path == "/rankings":
            if not self.model:
                self.send_json({"error": "Model not loaded"}, 503); return
            rankings = self.model.get_top_players(p("surface","Clay"), int(p("top","20")))
            self.send_json({"surface": p("surface","Clay"), "rankings": rankings})

        else:
            self.send_json({"error": "Not found"}, 404)

def run():
    print(f"\n🎾 UNPRICED Model API — Port {PORT}")
    model, analyzer = load_model()
    ModelHandler.model = model
    ModelHandler.analyzer = analyzer
    server = HTTPServer(("0.0.0.0", PORT), ModelHandler)
    print(f"[API] ✅ Démarré sur http://0.0.0.0:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[API] Arrêt.")

if __name__ == "__main__":
    run()
