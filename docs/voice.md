# Voice

## Current choice

- **Engine**: Kokoro-82M (`kokoro-onnx`), `kokoro-v1.0.onnx` + `voices-v1.0.bin`, in `models/`.
- **Voice**: `bm_daniel` (British male), set via `TTS_VOICE` in `.env`. Picked
  by the user after listening to an 8-voice bake-off generated this session
  (`bm_george`, `am_fenrir`, `am_onyx`, `bm_daniel`, `am_adam`, `am_michael`,
  `bm_lewis`, `am_puck` — samples were written to `voice_samples/`,
  gitignored, regenerate with the command below if needed).
- **54 voices available** — full list at `GET /api/voices`.

## Emotional prosody: speed + pause timing, driven by Jimmy's selected emotion

Kokoro has no direct "emotion" or style-strength control. What it does
expose (`kokoro_onnx.Kokoro.create()`) is `speed`, `sentence_pause`, and
`clause_pause`. The backend now derives these from the LLM's selected
`emotion` + `intensity` on every response
(`SpeechProfile::from_emotion` in `backend/src/ai/tts.rs`), instead of
always synthesizing at flat default settings:

| Emotion | Speed | Sentence pause | Feel |
|---|---|---|---|
| `angry` | faster (scales with intensity, up to +25%) | shorter | clipped, urgent |
| `happy` | slightly faster | normal | upbeat |
| `sad` | slower (down to -20%) | longer | subdued, trailing |
| `sleepy` | slow | long | drowsy |
| `surprised` | faster | longer (for emphasis) | sharp then a beat |
| `curious`/`thinking` | slightly slower | longer | deliberate |
| `neutral` | 1.0x | default | calm, even |

This required extending the request all the way through: Rust
`TTSProvider` trait gained `synthesize_with_profile()` (the plain
`synthesize()` is now a default method that assumes neutral), and the
Python `stt_tts_service.py` `/synthesize` endpoint accepts
`sentence_pause`/`clause_pause` fields it passes straight to
`kokoro_model.create()`.

The prompt (`prompts/jimmy.md`) was also updated to use punctuation
deliberately per emotion (short clipped sentences for anger, exclamation
points for genuine happy/surprised, ellipses for sad, real question marks
for curious/confused) — punctuation is the other lever Kokoro's prosody
model actually reads, on top of the speed/pause parameters.

**Not done**: per-voice style blending (Kokoro accepts a raw embedding array
in place of a voice string name, which would allow interpolating between two
voices, e.g. to push further toward "angrier" or "warmer" than any single
preset voice). Worth investigating if `bm_daniel` + prosody tuning still
doesn't carry enough emotional range once tested further — but this is a
smaller change than switching TTS engines, try it before anything more
drastic.

## Kokoro vs. Piper (what Casey reportedly used)

Per `docs/research.md`, Casey's build likely used Piper (unconfirmed — see
that doc's confidence grading). Kokoro-82M is a newer open model
(Apache-2.0) generally regarded as higher fidelity than Piper's smaller
VITS-based voices, at a larger model size (~330 MB vs. Piper's ~20-60 MB per
voice) and correspondingly higher compute cost per utterance. Given this
project targets an RTX 4060 rather than an ESP32, the larger/better model
was the right tradeoff for development — though see `docs/performance.md`'s
Raspberry Pi section: this may need revisiting once real hardware work
starts, since Piper's smaller footprint is much more Pi-friendly.

## Regenerating the bake-off samples

```bash
for v in bm_george am_fenrir am_onyx bm_daniel am_adam am_michael bm_lewis am_puck; do
  curl -s -X POST http://127.0.0.1:3000/api/synthesize \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"Bad idea. Bad, bad, bad. Me Jimmy. We fix this.\",\"voice\":\"$v\"}" \
    -o "voice_samples/${v}.wav"
done
```
