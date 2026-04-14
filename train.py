import time
from data_downloader import load_matches
from elo_model import TennisEloModel

print("=" * 50)
print("UNPRICED — Entraînement du modèle Elo Tennis")
print("=" * 50)

start = time.time()

print("\n[1/3] Chargement des données ATP...")
matches = load_matches()

print("\n[2/3] Entraînement du modèle Elo par surface...")
model = TennisEloModel()
stats = model.train(matches)

print("\n[3/3] Sauvegarde...")
model.save()

elapsed = round(time.time() - start, 1)

print(f"\n{'='*50}")
print(f"✅ Terminé en {elapsed}s")
print(f"   Matchs traités : {model.total_processed:,}")
print(f"   Accuracy : {stats.get('accuracy', '?')}%")

print(f"\nTop 10 Clay :")
for i, p in enumerate(model.get_top_players("Clay", 10), 1):
    print(f"  {i:2}. {p['player']:<25} Elo: {p['elo']}")

print(f"\nTop 10 Hard :")
for i, p in enumerate(model.get_top_players("Hard", 10), 1):
    print(f"  {i:2}. {p['player']:<25} Elo: {p['elo']}")
