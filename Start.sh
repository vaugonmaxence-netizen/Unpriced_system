#!/bin/bash
echo "=== TRAIN ==="
python3 train.py
echo "=== API ==="
python3 api.py &
echo "=== SCANNER ==="
node scanner_v3.js
