# Remote speech (optional)

By default Ted speaks with Kokoro on your Mac and nothing leaves it. If you want a different voice, `TTS_PROVIDER` can send the words Ted is about to speak to a remote service instead. Everything after that is unchanged: ffmpeg turns the audio into AAC and Signal shows a voice message.

**Read this first.** With a remote provider, the text of each spoken reply (and nothing else: no mail, no notes, no history) is sent over HTTPS to a third party (`elevenlabs`) or to a server you run (`http`). Only use a cloned voice you have the rights and consent for: your own, or one whose owner agreed. This repo contains no cloned voice, no recording and no celebrity voice, and will not. The reference recording of a clone stays on the remote side and is only named by an id.

| Setting | |
|---|---|
| `TTS_PROVIDER` | `kokoro` (default), `elevenlabs` or `http` |
| `TTS_FALLBACK` | `none` (default): a failed remote request is sent as text with the usual note. `kokoro`: speak the same words locally instead (needs `scripts/setup-tts.sh`). Never switches unless you set it. |
| `TTS_TIMEOUT_SECONDS` | per request, 5 to 300, default 60 |

Keys and tokens live in `.env` only, are sent only in a request header, and are blanked out of any error message. A wrong setting stops the agent at start-up. `npm run doctor` shows which provider is chosen.

## ElevenLabs

```
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...        # from your ElevenLabs account
ELEVENLABS_VOICE_ID=...       # a stock voice, or a clone you made there with a voice you have the rights to
# ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Ted calls `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` with `{text, model_id}` and takes the MP3 it returns. Usage is billed by ElevenLabs by character; a 401, quota or rate-limit answer is a failure like any other (text, or Kokoro if `TTS_FALLBACK=kokoro`).

## Your own server (`http`)

```
TTS_PROVIDER=http
TTS_HTTP_URL=https://tts.example.com/say    # https; http:// only for localhost
TTS_HTTP_TOKEN=...                           # optional bearer token
# TTS_HTTP_VOICE=...                         # optional, passed as "voice"
# TTS_HTTP_REFERENCE_ID=...                  # optional, passed as "reference_id"
```

The contract, so you can implement it on any server (a serverless GPU running F5-TTS or Chatterbox, say):

```
POST {TTS_HTTP_URL}
Content-Type: application/json
Authorization: Bearer {TTS_HTTP_TOKEN}      (only if a token is set)

{"text": "the words to speak", "voice": "optional", "reference_id": "optional"}
```

- `text`: plain text, at most about 3,500 characters.
- `voice`: a voice name your server understands. `reference_id`: the id, on your server, of the reference recording for a cloned voice. The recording itself never travels and is never in this repo. Both are left out when unset.
- Success: status 200 and the audio as the body, WAV, MP3 or OGG, up to 25 MB. The format is read from the `Content-Type` (`audio/wav`, `audio/mpeg`, `audio/ogg`), or from the first bytes if that is missing or generic.
- Anything else (any other status, an empty or non-audio body, no answer within the timeout, a redirect) is a failure. Use 401/403 for a bad token and 429 for quota; they are named in the log.
- Redirects are not followed, so the token cannot be sent to another host.

### Try the plumbing locally

`examples/remote-tts-sample-server.ts` is a sample that follows the contract and answers with a sine-wave beep, not speech:

```
TTS_SAMPLE_TOKEN=some-long-random-string node examples/remote-tts-sample-server.ts
# .env: TTS_PROVIDER=http  TTS_HTTP_URL=http://localhost:8787/tts  TTS_HTTP_TOKEN=some-long-random-string
```

Restart the agent, then ask Ted for a voice answer: you should receive a beep as a voice message. Replace `render` with a real model on a server you control.

Back to the [README](../README.md) · [Safety](SAFETY.md) · [Setup](SETUP.md)
