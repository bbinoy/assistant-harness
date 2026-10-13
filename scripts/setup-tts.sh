#!/bin/bash
# Installs local text to speech (Kokoro) so the assistant can answer voice messages by voice.
# Everything goes into ~/.cache/ted-personal-assistant/kokoro (about 400 MB); nothing else is touched.
# Needs Python 3.10+ (macOS ships 3.9: `brew install python@3.12`) and ffmpeg (`brew install ffmpeg`).
set -euo pipefail
DIR="${TTS_DIR:-$HOME/.cache/ted-personal-assistant/kokoro}"
PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
[ -n "$PY" ] || { echo "Need Python 3.10 or newer: brew install python@3.12"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Need ffmpeg: brew install ffmpeg"; exit 1; }
mkdir -p "$DIR" && cd "$DIR"
[ -d venv ] || "$PY" -m venv venv
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet kokoro-onnx soundfile
BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -fL -o kokoro-v1.0.onnx "$BASE/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ] || curl -fL -o voices-v1.0.bin "$BASE/voices-v1.0.bin"
echo "Done: $DIR. Set TTS_VOICE (default am_onyx) in .env if you like; npm run doctor checks it."
