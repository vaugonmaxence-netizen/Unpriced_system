import os
import csv
import json
import urllib.request
import urllib.error
from datetime import datetime

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

USEFUL_COLUMNS = [
    "tourney_id", "tourney_name", "surface", "tourney_date",
    "winner_id", "winner_name", "winner_rank",
    "loser_id", "loser_name", "loser_rank",
    "score", "best_of", "round",
    "w_ace", "w_df", "w_svpt", "w_1stIn", "w_1stWon", "w_2ndWon",
    "w_bpSaved", "w_bpFaced",
    "l_ace", "l_df", "l_svpt", "l_1stIn", "l_1stWon", "l_2ndWon",
    "l_bpSaved", "l_bpFaced",
    "minutes"
]

def download_year(year):
    url = f"https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_{year}.csv"
    print(f"  Téléchargement {year}...", end=" ", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            content = response.read().decode("utf-8")
        reader = csv.DictReader(content.splitlines())
        matches = []
        for row in reader:
            match = {col: row.get(col, "") for col in USEFUL_COLUMNS}
            matches.append(match)
        print(f"✓ {len(matches)} matchs")
        return matches
    except Exception as e:
        print(f"✗ {e}")
        return []

def download_all(start_year=2010, end_year=None):
    if end_year is None:
        end_year = datetime.now().year
    print(f"\n[DATA] Téléchargement ATP {start_year}–{end_year}")
    all_matches = []
    for year in range(start_year, end_year + 1):
        all_matches.extend(download_year(year))
    output_path = os.path.join(DATA_DIR, "atp_matches.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_matches, f, ensure_ascii=False)
    print(f"\n[DATA] ✅ {len(all_matches)} matchs sauvegardés")
    return all_matches

def load_matches():
    path = os.path.join(DATA_DIR, "atp_matches.json")
    if not os.path.exists(path):
        return download_all()
    with open(path, "r", encoding="utf-8") as f:
        matches = json.load(f)
    print(f"[DATA] ✅ {len(matches)} matchs chargés")
    return matches

if __name__ == "__main__":
    download_all(start_year=2010)
