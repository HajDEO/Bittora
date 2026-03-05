#!/bin/bash
# Bittora startup script
CONFIG="/opt/bittora/config.json"

export BITTORA_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG'))['port'])")
export BITTORA_LANG=$(python3 -c "import json; print(json.load(open('$CONFIG'))['lang'])")
export BITTORA_DOWNLOADS=$(python3 -c "import json; print(json.load(open('$CONFIG'))['download_dir'])")
export BITTORA_DATA=$(python3 -c "import json; print(json.load(open('$CONFIG'))['data_dir'])")
export BITTORA_SECRET=$(python3 -c "import json; print(json.load(open('$CONFIG'))['secret'])")

cd /opt/bittora/backend
exec python3 -m uvicorn main:app --host 0.0.0.0 --port $BITTORA_PORT --log-level info
