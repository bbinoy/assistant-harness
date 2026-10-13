# Text to speech with Kokoro, run by tts.ts: the text arrives on stdin, a WAV file is written.
# usage: kokoro-say.py MODEL VOICES VOICE SPEED OUT.wav
# VOICE is one Kokoro voice (am_onyx) or a blend of several: "am_adam:0.6,am_onyx:0.4" (weights optional, equal by default;
# the voice vectors are mixed in proportion, and the first voice decides British or American pronunciation).
import faulthandler
import sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

# If it ever hangs, the parent's timeout kills it; this prints where it was stuck, into the parent's error message.
faulthandler.dump_traceback_later(60, exit=False)
model, voices, voice, speed, out = sys.argv[1:6]
text = sys.stdin.read().strip()
k = Kokoro(model, voices)
parts = [p.split(":") for p in voice.split(",")]
weights = [float(p[1]) if len(p) > 1 else 1.0 for p in parts]
style = voice if len(parts) == 1 else sum(w * k.get_voice_style(p[0]) for p, w in zip(parts, weights)) / sum(weights)
voice = parts[0][0]
samples, rate = k.create(text, voice=style, speed=float(speed), lang="en-gb" if voice.startswith("b") else "en-us")
sf.write(out, samples, rate)
