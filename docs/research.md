# Research: Casey G's "Rocky" (Project Hail Mary fan build)

## Method and its limits

This research was done with text-only web search/fetch tools (no video playback,
no frame OCR, no TikTok/Instagram/YouTube authenticated access, no audio
transcription). The brief that kicked off this project asked for direct video/frame
inspection — that was not possible in this environment. Everything below is
graded CONFIRMED / LIKELY / INFERRED / UNKNOWN per source quality; nothing here
should be treated as more certain than its grade.

**Important finding: there are at least two different fan-built "Rocky" robots**
circulating in press coverage, and several articles conflate them. Keep them
separate:

1. **Casey G (`@casey.aicreates` / YouTube "CaseysDay")** — the creator named in
   this project's brief. Small desk-companion form factor.
2. **"Leviathan Engineering"** (YouTube, Hackster.io writeup) — a larger
   four-legged/walking Raspberry Pi 5 robot with 10 servos. This is a
   **different person's build**, not Casey's, even though several syndicated
   articles (Yahoo, Interesting Engineering, CircuitDigest, Hackster) describe
   it under generic "Project Hail Mary fan builds a Rocky robot" headlines.

## Evidence table

| Component | Value | Confidence | Source |
|---|---|---|---|
| Creator (Casey's build) | Casey G, `@casey.aicreates` (TikTok/Instagram), YouTube "CaseysDay" | CONFIRMED | Handle appears consistently across TikTok/Instagram/YouTube search hits |
| Form factor | Small desk companion (not walking/legged) | LIKELY | Distinguishing detail repeated in search snippets vs. the Leviathan Engineering build |
| MCU | Seeed XIAO ESP32S3 Sense | UNKNOWN | Appeared only in a WebSearch AI-synthesized summary with no fetchable primary source (Instagram post content is not accessible to this tool); could not independently confirm |
| Display | 1.3" SH1106 I2C OLED, 128×64 | UNKNOWN | Same synthesized-summary origin as above, unconfirmed |
| Audio amp | MAX98357A I2S amplifier | UNKNOWN | Same, unconfirmed |
| Head motion | Adafruit Mini Pan-Tilt kit | UNKNOWN | Same, unconfirmed |
| STT | Vosk (local) | LIKELY | Repeated across multiple independent syndicated articles, though some of those articles are actually describing the Leviathan Engineering build — attribution to Casey specifically is not fully disentangled |
| TTS | Piper (local), described as a "sharp, rhythmic voice style" | LIKELY | Same caveat as STT |
| LLM / dialogue | Google Gemini API (cloud, not local) | LIKELY | Repeated across sources; if accurate, Casey's build is *not* fully local — differs from this project's local-only requirement |
| Dev tooling | Claude Code / Claude CLI used to help write the robot's software | CONFIRMED-ish | Stated directly in coverage as a detail Casey highlighted, low ambiguity risk since it's a specific unusual claim unlikely to be conflated between builds |
| Gesture generation | LLM tool-calling triggers physical gestures live (no pre-scripted animations) | LIKELY (attribution uncertain between the two builds) | — |

## What this means for Jimmy

Casey's actual stack (Vosk + Piper + cloud Gemini, on what's likely an ESP32
class MCU) is **lighter-weight and partly cloud-based** — very different from
this project's constraints (RTX 4060 available, fully local required, browser
is the display for now). We are not blindly porting his stack:

- **STT**: this project already uses faster-whisper instead of Vosk —
  strictly better accuracy for a machine with a real GPU/CPU budget, and still
  fully local. No change recommended.
- **TTS**: Piper is a legitimate lightweight local option; this project
  currently uses Kokoro-82M (see [voice.md](voice.md)) which is a materially
  newer and higher-quality open local TTS. Kept.
- **LLM**: Casey reportedly uses cloud Gemini. This project requires local-only
  (RTX 4060 target) per its own brief, so this is an intentional divergence:
  local Ollama + Qwen2.5, not cloud.
- **Display resolution**: this project's already-chosen canonical 128×64
  logical face resolution happens to match the *unconfirmed* SH1106 128×64
  panel spec found in search results. If that spec turns out to be accurate
  once someone can verify it against Casey's actual posts, it's a happy
  coincidence rather than something copied from him — 128×64 was chosen here
  independently as a common small-OLED size compatible with SSD1306/SSD1327
  hardware.
- **Personality**: Casey's own dialogue/voice design is not reproduced or
  quoted anywhere in this codebase. `prompts/jimmy.md` is original writing
  inspired only by the broad, publicly known communication style of the
  *Rocky* character from the novel *Project Hail Mary* (simple grammar,
  short sentences, emotional bluntness) — not by anything Casey specifically
  wrote or said.

## Recommended follow-up (needs a human or a tool with real video/image access)

To actually confirm the UNKNOWN rows above, someone with working
YouTube/TikTok/Instagram access (video playback, frame inspection) needs to
review `@casey.aicreates`'s posts directly. This environment could not do
that. Until then, treat the hardware/software rows marked UNKNOWN as
unverified leads, not facts to build on.
