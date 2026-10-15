#!/bin/bash
# Installs the optional Qwen3-TTS voice (voice cloning, Apple Silicon only) for TTS_PROVIDER=qwen.
# Everything goes into state/tts-qwen/ of the harness (or $TTS_QWEN_DIR): a Python venv with mlx-audio (about 1 GB) and the
# model (0.6B 8-bit: about 1.5 GB, from Hugging Face). Needs Python 3.10+ (`brew install python@3.12`). Not run by npm install or CI.
# The reference recording of the voice is NOT part of this: you provide it (docs/REMOTE-TTS.md, "Local cloned voice").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${TTS_QWEN_DIR:-$ROOT/state/tts-qwen}"
MODEL="${TTS_QWEN_MODEL:-mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit}"
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Qwen3-TTS via mlx-audio needs an Apple Silicon Mac."; exit 1; }
PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
[ -n "$PY" ] || { echo "Need Python 3.10 or newer: brew install python@3.12"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Need ffmpeg: brew install ffmpeg"; exit 1; }
mkdir -p "$DIR" && cd "$DIR"
[ -d venv ] || "$PY" -m venv venv
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet mlx-audio soundfile numpy
./venv/bin/python - "$MODEL" <<'PYEOF'
import sys
from huggingface_hub import snapshot_download
print("model:", snapshot_download(sys.argv[1]))
PYEOF
echo "Done: $DIR. In .env: TTS_PROVIDER=qwen, TTS_REF_AUDIO=<your reference wav>, TTS_REF_TEXT=<its transcript or a .txt path>; npm run doctor checks it."
