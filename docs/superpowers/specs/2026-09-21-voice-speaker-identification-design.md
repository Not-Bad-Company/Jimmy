# Voice Speaker Identification — Design

Status: approved for implementation planning
Sub-project A of the "Jarvis-style persistent memory" initiative. Sub-project B
(persistent memory: facts + transcripts + semantic retrieval, keyed by the
speaker identity this spec produces) is out of scope here and will get its
own spec once this ships.

## Goals

- Jimmy recognizes who is currently speaking, from voice alone, across an
  unbounded number of distinct people ("infinite people" per the request —
  no hardcoded speaker limit).
- A first-time/unrecognized voice is handled conversationally: Jimmy carries
  on naturally and works the person's name into the conversation itself
  (not a jarring "ERROR: UNKNOWN USER, STATE YOUR NAME"), then remembers
  their voice under that name from then on.
- Runs entirely on the target hardware: Raspberry Pi 5 (8GB RAM, active
  cooling, NVMe SSD) — no thermal throttling or storage-I/O bottleneck
  expected at this model size, per the hardware already chosen.
- This is also the project's first persistent storage of any kind — today
  `ConversationStore` is an in-memory `Vec` wiped on every restart. The
  SQLite database introduced here is deliberately structured so Sub-project
  B can add tables to it rather than introducing a second storage system.

## Non-goals (explicitly deferred)

- Face/camera-based recognition (mentioned as a later phase).
- Voice stress/lie/emotion analysis (mentioned as a later phase, after
  memory ships).
- The smell sensor Jimmy proposed. Not happening.
- Persistent/inertial emotional state (mood that doesn't reset instantly,
  needs an apology to repair) — related, requested separately, but it's a
  change to `RobotStateMachine`'s emotion handling, not to identity/memory.
  Gets its own spec.
- Actually storing/retrieving facts about a person (Sub-project B). This
  spec only produces a stable `speaker_id` for a given voice.

## Architecture overview

```
                    ┌─────────────────────────┐
   mic audio ──────▶│  Rust backend            │
   (webm/opus)      │  voice_turn_handler       │
                    │                          │
                    │  tokio::join!(            │
                    │    stt.transcribe(...),   │──▶ configured STTProvider
                    │    speaker_id.identify(..)│      (local or Mistral)
                    │  )                        │
                    └───────────┬──────────────┘
                                │ POST /identify (audio bytes)
                                ▼
                    ┌─────────────────────────┐
                    │ Python STT/TTS service   │
                    │ + Resemblyzer speaker     │
                    │   embedding model         │
                    └───────────┬──────────────┘
                                │ 256-d fingerprint vector
                                ▼
                    ┌─────────────────────────┐
                    │ SQLite (data/jimmy.db)   │
                    │  speakers table          │
                    │  (Rust owns all writes)  │
                    └─────────────────────────┘
```

Speaker identification is **independent of which STT provider is
transcribing** (`STT_PROVIDER=local` or `mistral`) — it always goes to the
local Python service, since voice embeddings aren't something Mistral's API
offers. The two calls run concurrently (`tokio::join!`) so identification
never adds latency on top of transcription; it only matters if it's slower
than transcription, which it won't be at this model size.

## Components

### 1. Python service: speaker embedding + matching

New dependency: `resemblyzer` (GE2E-based speaker encoder, ~17MB weights,
pure CPU inference, well-documented as running acceptably on Pi-class ARM
CPUs — much lighter than SpeechBrain's ECAPA-TDNN, and accuracy at
"distinguish a handful of household voices" scale doesn't need ECAPA's
extra headroom).

New endpoint `POST /identify` in `services/stt_tts_service.py`:

- Input: multipart audio file (same upload the frontend already sends to
  `/transcribe`).
- Output: `{"fingerprint": [f32; 256]}` — just the raw embedding vector.
  Matching against known speakers happens in Rust (see below), not here:
  the Python service stays stateless and has no SQLite dependency, keeping
  the "which service owns the database" question unambiguous.
- Loaded once at service startup (`lifespan`, alongside Whisper/Kokoro),
  same pattern as the existing models.

### 2. Rust backend: SQLite + speaker matching

New dependency: `rusqlite` (bundled SQLite, no separate server process —
matches the "zero ops" requirement of running unattended on a Pi).

New module `backend/src/speaker/mod.rs`:

```rust
pub struct SpeakerStore { conn: Mutex<rusqlite::Connection> }

pub struct SpeakerMatch {
    pub speaker_id: i64,
    pub name: Option<String>, // None until they've told Jimmy their name
    pub confidence: f32,
}

impl SpeakerStore {
    pub fn new(db_path: &str) -> Result<Self>;  // runs migrations
    pub fn find_best_match(&self, fingerprint: &[f32]) -> Result<Option<SpeakerMatch>>;
    pub fn enroll(&self, fingerprint: &[f32], name: Option<&str>) -> Result<i64>;
    pub fn set_name(&self, speaker_id: i64, name: &str) -> Result<()>;
}
```

Schema (migration 0001):

```sql
CREATE TABLE speakers (
    id INTEGER PRIMARY KEY,
    name TEXT,                    -- NULL until identified by name
    fingerprint BLOB NOT NULL,    -- 256 x f32, little-endian
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
```

Matching: cosine similarity between the incoming fingerprint and every
stored one. At personal/household scale (tens of speakers, not thousands)
a full linear scan in-process is well within budget — no vector index
needed, consistent with the earlier SQLite-over-Postgres decision (don't
build infrastructure for a scale this will never reach).

Threshold: cosine similarity ≥ **0.75** counts as a match (Resemblyzer's
own documentation and common usage report same-speaker similarity
typically ≥0.8 and different-speaker well below 0.6; 0.75 leaves margin
for mic/room noise variation while a Pi's onboard mic is characterized).
**This threshold needs real-world tuning once hardware is in hand** — it's
a starting point, called out explicitly as unverified in the plan's
testing section.

### 3. Rust backend: conversation flow changes

`voice_turn_handler` (routes.rs) changes:

1. After STT transcription, run speaker matching concurrently as described.
2. If matched with a known name → proceed as today, but the system prompt
   gets the speaker's name injected (e.g. `Current speaker: Daan.`) so
   Jimmy can address them naturally. This is the first piece of "personal
   assistant" behavior, ahead of full memory.
3. If matched but **no name yet** (a voice enrolled previously but the
   person never gave a name — e.g. they hung up mid-introduction) or no
   match at all → the system prompt gets an instruction like: *"You don't
   know who this is. Naturally work finding out their name into the
   conversation — don't interrogate, don't break character."* The LLM
   handles the actual phrasing (this is exactly the kind of thing the
   existing personality-prompt system already does well).
4. A lightweight, deliberately dumb heuristic extracts a name from the
   user's *next* transcribed message when a name was being solicited (e.g.
   simple patterns like "I'm X" / "my name is X" / a bare capitalized word
   in response to being asked) — good enough for a natural conversational
   flow; this is not the place for a full NLU pipeline. If extraction
   fails, Jimmy just asks again next turn (also LLM-driven, not hardcoded).
5. On first contact with a new voice, `SpeakerStore::enroll` is called
   immediately with `name: None`; `set_name` is called once a name is
   captured. This means even an unnamed voice is already being recognized
   as "the same person as last time" from the very first re-encounter.

### 4. Config

New env vars (`.env` / `AppConfig`):

- `SPEAKER_DB_PATH` (default `data/jimmy.db`)
- `SPEAKER_MATCH_THRESHOLD` (default `0.75`, override without a rebuild
  while tuning against real hardware)
- `SPEAKER_ID_SERVICE_URL` (default derived from the existing
  `STT_SERVICE_URL` base — same host, `/identify` path)

## Error handling

- Python `/identify` unreachable/errors → log a warning, treat the turn as
  "unknown speaker" (same as a low-confidence match) rather than failing
  the whole voice turn. Speaker ID is additive; its failure must never
  block Jimmy from responding at all (same principle already applied to
  TTS failures elsewhere in this codebase).
- SQLite write failures → logged, turn proceeds without persisting that
  enrollment/name update (better to answer without remembering than to
  fail the turn over a storage hiccup).
- Corrupt/missing `data/jimmy.db` at startup → `SpeakerStore::new` creates
  it fresh (migrations are additive/idempotent), same spirit as the rest
  of this codebase's "degrade, don't crash" error handling.

## Testing

- Rust: unit tests for `SpeakerStore` (enroll, match above/below threshold,
  name assignment) against an in-memory SQLite connection (`:memory:`) —
  no real audio needed for this layer.
- Rust: unit tests for the name-extraction heuristic against a table of
  sample utterances.
- Python: a small script/test feeding a few real short recordings of the
  same speaker through `/identify` twice, confirming similarity ≥ threshold
  against each other and < threshold against a different speaker's
  recording — this is the piece that actually needs real hardware/mic
  input to validate meaningfully; can't be fully verified in this
  environment.
- Manual/hardware-in-hand verification (called out explicitly, not
  skippable): confirm the 0.75 threshold against the Pi's actual onboard
  mic in the actual room Jimmy lives in, and retune if needed.

## Open questions carried into the plan

- Exact Resemblyzer inference latency on Pi 5 is not yet measured in this
  environment (no Pi available here) — the plan should include a step to
  measure it early and revisit the "runs concurrently, adds no latency"
  assumption if it turns out to be unexpectedly slow.
- Whether `speakers.name` uniqueness should be enforced (two different
  fingerprints both named "Daan") is left unenforced for now — a
  reasonable real-world case (multiple people with the same first name)
  that Sub-project B's memory layer is better positioned to disambiguate
  further if it ever matters.
