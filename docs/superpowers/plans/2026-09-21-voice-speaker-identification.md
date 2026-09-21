# Voice Speaker Identification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jimmy recognizes who's speaking from voice alone (unlimited distinct people), and when it doesn't recognize a voice, it naturally works finding out the person's name into conversation and remembers them from then on.

**Architecture:** The local Python STT/TTS service gets a new `/identify` endpoint that turns a voice clip into a 256-d fingerprint (Resemblyzer). The Rust backend calls that endpoint concurrently with transcription on every voice turn, matches the fingerprint against a SQLite table of known speakers (cosine similarity, in-process — no vector DB needed at this scale), and injects the result (a known name, or "unidentified — find out naturally") into the system prompt for that turn. A small heuristic pulls a name out of the next reply when one is offered.

**Tech Stack:** Python: `resemblyzer` (CPU-only PyTorch) in `services/stt_tts_service.py`. Rust: `rusqlite` (bundled SQLite) in a new `backend/src/speaker/` module.

**Spec:** `docs/superpowers/specs/2026-09-21-voice-speaker-identification-design.md`

## Global Constraints

- Target hardware is eventually a Raspberry Pi 5 (8GB, active cooling, NVMe) — active development stays on the current laptop until the software is feature-complete, but model/dependency choices must stay Pi-feasible (small, CPU-only, no CUDA).
- Storage is SQLite, not Postgres — this is the project's first persistent storage of any kind; keep it that way (no new storage system introduced for this feature).
- Speaker embeddings come from Resemblyzer, not a heavier model (e.g. SpeechBrain ECAPA-TDNN) — chosen specifically for Pi-class CPU inference.
- Speaker identification is a dedicated `/identify` endpoint on the Python service, independent of which `STT_PROVIDER` (`local` or `mistral`) is configured for transcription — it must keep working regardless of that setting.
- Rust owns all SQLite writes; the Python service stays stateless (returns only a fingerprint vector, does no matching/storage itself).
- Match threshold (cosine similarity) starts at `0.75`, must be overridable via `SPEAKER_MATCH_THRESHOLD` env var without a rebuild — it is an unverified starting guess pending real hardware/mic testing.
- Any failure in speaker identification (model down, network error, DB write failure) must degrade to "unknown speaker" and let the voice turn continue — it must never fail or block a reply, matching this codebase's existing TTS/STT failure-handling style (see `synthesize_with_fallback` in `backend/src/api/routes.rs`).

---

## File Structure

- **Create** `backend/src/speaker/mod.rs` — module root, re-exports.
- **Create** `backend/src/speaker/store.rs` — `SpeakerStore`: SQLite-backed enrollment + cosine-similarity matching.
- **Create** `backend/src/speaker/client.rs` — `SpeakerIdClient`: HTTP client for the Python `/identify` endpoint.
- **Create** `backend/src/speaker/name_extract.rs` — `extract_name()`: best-effort name heuristic.
- **Modify** `backend/Cargo.toml` — add `rusqlite`.
- **Modify** `backend/src/lib.rs` (or `main.rs`, whichever declares top-level modules — checked in Task 2) — add `mod speaker;`.
- **Modify** `backend/src/config/mod.rs` — add `speaker_db_path`, `speaker_match_threshold`, `speaker_id_service_url`.
- **Modify** `backend/src/state/mod.rs` — add `speaker_store: Arc<SpeakerStore>` and `speaker_id_client: Arc<SpeakerIdClient>` to `AppState`.
- **Modify** `backend/src/api/routes.rs` — wire speaker identification into `voice_turn_handler`.
- **Modify** `services/stt_tts_service.py` — add Resemblyzer model loading + `/identify` endpoint.
- **Create** `tests/test_speaker_identify.py` — manual Python-side similarity check script (same style as `tests/test_full_system.py`).

---

### Task 1: Python — Resemblyzer speaker embedding + `/identify` endpoint

**Files:**
- Modify: `services/stt_tts_service.py`
- Create: `tests/test_speaker_identify.py`

**Interfaces:**
- Produces: `POST /identify` (multipart file upload, field name `file`) → `{"fingerprint": [f32; 256]}` on success, `503` if the model isn't loaded, `400` on empty/undecodable audio, `500` on other errors.

- [x] **Step 1: Install Resemblyzer with CPU-only PyTorch**

The default `resemblyzer` install pulls full CUDA PyTorch (verified: `nvidia-cusparselt-cu13`, `nvidia-nccl-cu13`, etc. — multi-GB, and irrelevant since Pi 5 has no CUDA GPU anyway). Install CPU-only PyTorch first so `resemblyzer` sees it already satisfied:

```bash
cd /home/daanh/Projects/code/private/jimmy
uv pip install --python services/.venv "torch==2.14.0" \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  --index-strategy unsafe-best-match
uv pip install --python services/.venv resemblyzer
```

Verify it landed as the CPU build, not CUDA:
```bash
services/.venv/bin/python -c "import torch; print(torch.__version__)"
```
Expected: version string ending in `+cpu` (e.g. `2.14.0+cpu`), not `+cu*`.

**Known install snag (verified against a real environment):** `resemblyzer`
pulls in `webrtcvad`, which imports `pkg_resources` at module load time.
Newer `setuptools` (81+) dropped `pkg_resources`, so importing
`resemblyzer` fails with `ModuleNotFoundError: No module named
'pkg_resources'` unless `setuptools` is pinned below 81:
```bash
uv pip install --python services/.venv "setuptools<81"
```
Verify the whole import chain actually works (not just that pip resolved
it — resemblyzer loads its bundled pretrained model here too, so this
also confirms no network access is needed at runtime):
```bash
services/.venv/bin/python -c "
from resemblyzer import VoiceEncoder
enc = VoiceEncoder('cpu')
print('OK')
"
```
Expected: prints `Loaded the voice encoder model on cpu in ...` then `OK`
(a `pkg_resources is deprecated` UserWarning is harmless noise, not an
error). Measured load time in this environment: ~0.08s — comfortably fast
enough for Pi 5, even accounting for a slower CPU.

- [x] **Step 2: Add the speaker encoder to service startup**

In `services/stt_tts_service.py`, near the top with the other model globals (`whisper_model`, `kokoro_model`):

```python
from resemblyzer import VoiceEncoder
```

Add a global:
```python
speaker_encoder: Optional[VoiceEncoder] = None
```

In the `lifespan()` function, after the Kokoro TTS loading block, add (same try/except-and-warn style as the other two models — a missing speaker model must not prevent STT/TTS from working):

```python
    # Load Resemblyzer speaker encoder
    try:
        logger.info("Loading Resemblyzer speaker encoder...")
        global speaker_encoder
        speaker_encoder = VoiceEncoder("cpu")
        logger.info("Speaker encoder loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load speaker encoder: {e}")
```

- [x] **Step 3: Add the audio-decode helper and `/identify` endpoint**

Add near the top of the file, with the other imports:
```python
import subprocess
```

Add this helper function (place it above the `/identify` endpoint, after the existing `/synthesize` handler):

```python
def _decode_audio_to_16k_mono(audio_bytes: bytes) -> np.ndarray:
    """Decodes arbitrary-format audio bytes (webm/opus from the frontend
    recorder, wav from test scripts, etc.) to a 16kHz mono float32
    waveform via ffmpeg — the format Resemblyzer's pretrained encoder
    expects. ffmpeg is already a hard runtime dependency of this service
    (faster-whisper relies on it too for decoding non-WAV uploads), so
    this adds no new system dependency.
    """
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1",
        ],
        input=audio_bytes,
        capture_output=True,
        check=True,
    )
    wav_buf = io.BytesIO(proc.stdout)
    samples, _ = sf.read(wav_buf, dtype="float32")
    return samples


@app.post("/identify")
async def identify(file: UploadFile = File(...)):
    if not speaker_encoder:
        raise HTTPException(status_code=503, detail="Speaker ID model is not loaded")

    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")

        wav = _decode_audio_to_16k_mono(audio_bytes)
        embedding = speaker_encoder.embed_utterance(wav)
        return {"fingerprint": embedding.tolist()}
    except HTTPException:
        raise
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="replace") if e.stderr else ""
        logger.error(f"Speaker ID audio decode failed: {stderr}")
        raise HTTPException(status_code=400, detail="Could not decode audio")
    except Exception as e:
        logger.error(f"Speaker identification error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
```

- [x] **Step 4: Add speaker-ID status to the `/health` endpoint**

Find the existing `health()` function and add a `"speaker_id"` key to its returned dict, matching the `stt`/`tts` shape:

```python
        "speaker_id": {
            "loaded": speaker_encoder is not None,
            "model": "resemblyzer",
        },
```

- [x] **Step 5: Restart the service and verify by hand**

```bash
# Find and kill the running instance, then restart it the same way it's
# normally started (see start.sh) — e.g.:
pkill -f "stt_tts_service.py" || true
services/.venv/bin/python services/stt_tts_service.py &
sleep 3
curl -s http://127.0.0.1:8001/health
```
Expected: JSON includes `"speaker_id": {"loaded": true, ...}`.

- [x] **Step 6: Write the manual similarity verification script**

Real mic input isn't available in a dev sandbox — this script is meant to be run by hand against two short recordings of the same person and one of a different person once real hardware/mic is available. Create `tests/test_speaker_identify.py`:

```python
#!/usr/bin/env python3
"""
Manual verification for the /identify endpoint's speaker-embedding
similarity. Not part of the automated suite — requires real recorded
voice samples, which aren't available in a dev sandbox.

Usage:
    python tests/test_speaker_identify.py same_a.wav same_b.wav different.wav

same_a.wav and same_b.wav should be two short (2-5s) recordings of the
SAME person; different.wav a recording of a DIFFERENT person. Prints the
cosine similarity for same-speaker and different-speaker pairs so the
0.75 match threshold (backend/src/speaker/store.rs) can be sanity-checked
and retuned against real hardware.
"""

import sys
import json
import math
import urllib.request

BASE_URL = "http://127.0.0.1:8001"


def identify(path: str) -> list[float]:
    with open(path, "rb") as f:
        data = f.read()
    boundary = "----jimmyspeakertest"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{BASE_URL}/identify",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["fingerprint"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)

    same_a, same_b, different = sys.argv[1], sys.argv[2], sys.argv[3]

    fp_a = identify(same_a)
    fp_b = identify(same_b)
    fp_c = identify(different)

    same_sim = cosine_similarity(fp_a, fp_b)
    diff_sim = cosine_similarity(fp_a, fp_c)

    print(f"Same-speaker similarity:      {same_sim:.4f}")
    print(f"Different-speaker similarity: {diff_sim:.4f}")
    print(f"Current match threshold:      0.75")

    if same_sim < 0.75:
        print("WARNING: same-speaker similarity is BELOW the 0.75 threshold — "
              "the threshold needs lowering, or the recordings are too short/noisy.")
    if diff_sim >= 0.75:
        print("WARNING: different-speaker similarity is ABOVE the 0.75 threshold — "
              "the threshold needs raising, false-match risk.")
    if same_sim >= 0.75 > diff_sim:
        print("OK: threshold cleanly separates same- vs different-speaker in this sample.")


if __name__ == "__main__":
    main()
```

This step has no pass/fail here — it's a tool for later hardware-in-hand tuning, called out explicitly in the spec's testing section. Commit it as-is.

- [x] **Step 7: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add services/stt_tts_service.py tests/test_speaker_identify.py
git commit -m "feat: add Resemblyzer speaker-embedding /identify endpoint"
```

---

### Task 2: Rust — `SpeakerStore` (SQLite enrollment + matching)

**Files:**
- Modify: `backend/Cargo.toml`
- Create: `backend/src/speaker/mod.rs`
- Create: `backend/src/speaker/store.rs`
- Modify: whichever of `backend/src/lib.rs` / `backend/src/main.rs` declares `mod` statements (check both — `main.rs` currently has `mod ai; mod api; mod config; mod conversation; mod robot; mod state;`; add `mod speaker;` there. If `lib.rs` also declares its own module tree, add it there too so both binary and any lib-target tests can see it.)

**Interfaces:**
- Produces:
  - `pub struct SpeakerMatch { pub speaker_id: i64, pub name: Option<String>, pub confidence: f32 }`
  - `pub struct SpeakerStore` with:
    - `pub fn new(db_path: &str, match_threshold: f32) -> anyhow::Result<Self>`
    - `pub fn in_memory(match_threshold: f32) -> anyhow::Result<Self>` (for tests)
    - `pub fn find_best_match(&self, fingerprint: &[f32]) -> anyhow::Result<Option<SpeakerMatch>>`
    - `pub fn enroll(&self, fingerprint: &[f32], name: Option<&str>) -> anyhow::Result<i64>`
    - `pub fn set_name(&self, speaker_id: i64, name: &str) -> anyhow::Result<()>`
    - `pub fn touch_last_seen(&self, speaker_id: i64) -> anyhow::Result<()>`

- [x] **Step 1: Add the `rusqlite` dependency**

In `backend/Cargo.toml`, under `[dependencies]`, add:
```toml
rusqlite = { version = "0.40", features = ["bundled"] }
```
The `bundled` feature compiles SQLite from source as part of the build — no system SQLite library needed, which matters for a clean Pi build later.

- [x] **Step 2: Write the failing tests**

Create `backend/src/speaker/store.rs` with just the struct skeleton and tests first:

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use std::sync::Mutex;

pub struct SpeakerMatch {
    pub speaker_id: i64,
    pub name: Option<String>,
    pub confidence: f32,
}

pub struct SpeakerStore {
    conn: Mutex<Connection>,
    match_threshold: f32,
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS speakers (
    id INTEGER PRIMARY KEY,
    name TEXT,
    fingerprint BLOB NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);";

impl SpeakerStore {
    pub fn new(db_path: &str, match_threshold: f32) -> Result<Self> {
        todo!()
    }

    pub fn in_memory(match_threshold: f32) -> Result<Self> {
        todo!()
    }

    pub fn find_best_match(&self, fingerprint: &[f32]) -> Result<Option<SpeakerMatch>> {
        todo!()
    }

    pub fn enroll(&self, fingerprint: &[f32], name: Option<&str>) -> Result<i64> {
        todo!()
    }

    pub fn set_name(&self, speaker_id: i64, name: &str) -> Result<()> {
        todo!()
    }

    pub fn touch_last_seen(&self, speaker_id: i64) -> Result<()> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-fingerprint for tests: `seed` picks a
    /// direction in 256-d space so two different seeds are guaranteed to
    /// cosine-differ, and the same seed always reproduces the same vector.
    fn fake_fingerprint(seed: u32) -> Vec<f32> {
        (0..256)
            .map(|i| ((seed as f32 + 1.0) * (i as f32 + 1.0)).sin())
            .collect()
    }

    #[test]
    fn enroll_then_find_best_match_above_threshold() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let fp = fake_fingerprint(1);
        let id = store.enroll(&fp, Some("Daan")).unwrap();

        let result = store.find_best_match(&fp).unwrap().expect("should match itself");
        assert_eq!(result.speaker_id, id);
        assert_eq!(result.name.as_deref(), Some("Daan"));
        assert!(result.confidence > 0.99, "identical fingerprint should be ~1.0 similarity");
    }

    #[test]
    fn no_match_below_threshold() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        store.enroll(&fake_fingerprint(1), Some("Daan")).unwrap();

        let unrelated = fake_fingerprint(999);
        let result = store.find_best_match(&unrelated).unwrap();
        assert!(result.is_none(), "an unrelated fingerprint must not match");
    }

    #[test]
    fn enroll_without_name_then_set_name() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let fp = fake_fingerprint(2);
        let id = store.enroll(&fp, None).unwrap();

        let before = store.find_best_match(&fp).unwrap().unwrap();
        assert_eq!(before.name, None);

        store.set_name(id, "Sarah").unwrap();

        let after = store.find_best_match(&fp).unwrap().unwrap();
        assert_eq!(after.name.as_deref(), Some("Sarah"));
    }

    #[test]
    fn finds_the_closest_of_multiple_enrolled_speakers() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let id_a = store.enroll(&fake_fingerprint(1), Some("A")).unwrap();
        store.enroll(&fake_fingerprint(50), Some("B")).unwrap();
        store.enroll(&fake_fingerprint(100), Some("C")).unwrap();

        let result = store.find_best_match(&fake_fingerprint(1)).unwrap().unwrap();
        assert_eq!(result.speaker_id, id_a);
    }
}
```

- [x] **Step 3: Create `backend/src/speaker/mod.rs`**

```rust
pub mod client;
pub mod name_extract;
pub mod store;

pub use client::SpeakerIdClient;
pub use name_extract::extract_name;
pub use store::{SpeakerMatch, SpeakerStore};
```

(`client` and `name_extract` don't exist yet — Tasks 3 and 4 create them. For this task, temporarily comment out the `pub mod client;` / `pub use client::SpeakerIdClient;` lines and the `pub mod name_extract;` / `pub use name_extract::extract_name;` lines so this task compiles standalone; Task 3 and 4 will uncomment them.)

- [x] **Step 4: Add `mod speaker;` to the binary's module list**

In `backend/src/main.rs`, find:
```rust
mod ai;
mod api;
mod config;
mod conversation;
mod robot;
mod state;
```
Add `mod speaker;` to that list (alphabetical order, after `mod robot;`).

Check `backend/src/lib.rs` for a similar module list — if one exists, add `mod speaker;` (or `pub mod speaker;`, matching however the other modules are declared there) too.

- [x] **Step 5: Run the tests to confirm they fail to compile (todo!() panics)**

```bash
cd backend && cargo test speaker::store
```
Expected: compiles (once Step 3's temporary comment-outs are in place), tests panic with "not yet implemented" at runtime.

- [x] **Step 6: Implement `SpeakerStore`**

Replace the `todo!()` bodies in `backend/src/speaker/store.rs`:

```rust
impl SpeakerStore {
    pub fn new(db_path: &str, match_threshold: f32) -> Result<Self> {
        if let Some(parent) = std::path::Path::new(db_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            match_threshold,
        })
    }

    pub fn in_memory(match_threshold: f32) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            match_threshold,
        })
    }

    fn encode_fingerprint(fp: &[f32]) -> Vec<u8> {
        fp.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    fn decode_fingerprint(blob: &[u8]) -> Vec<f32> {
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        dot / (norm_a * norm_b)
    }

    pub fn find_best_match(&self, fingerprint: &[f32]) -> Result<Option<SpeakerMatch>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, fingerprint FROM speakers")?;
        let rows = stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let name: Option<String> = row.get(1)?;
            let blob: Vec<u8> = row.get(2)?;
            Ok((id, name, blob))
        })?;

        let mut best: Option<(i64, Option<String>, f32)> = None;
        for row in rows {
            let (id, name, blob) = row?;
            let stored_fp = Self::decode_fingerprint(&blob);
            let sim = Self::cosine_similarity(fingerprint, &stored_fp);
            let is_better = best.as_ref().map(|(_, _, best_sim)| sim > *best_sim).unwrap_or(true);
            if is_better {
                best = Some((id, name, sim));
            }
        }

        Ok(best.and_then(|(id, name, sim)| {
            if sim >= self.match_threshold {
                Some(SpeakerMatch {
                    speaker_id: id,
                    name,
                    confidence: sim,
                })
            } else {
                None
            }
        }))
    }

    pub fn enroll(&self, fingerprint: &[f32], name: Option<&str>) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let blob = Self::encode_fingerprint(fingerprint);
        conn.execute(
            "INSERT INTO speakers (name, fingerprint, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)",
            params![name, blob, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_name(&self, speaker_id: i64, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE speakers SET name = ?1 WHERE id = ?2",
            params![name, speaker_id],
        )?;
        Ok(())
    }

    pub fn touch_last_seen(&self, speaker_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE speakers SET last_seen_at = ?1 WHERE id = ?2",
            params![now, speaker_id],
        )?;
        Ok(())
    }
}
```

- [x] **Step 7: Run the tests to confirm they pass**

```bash
cd backend && cargo test speaker::store
```
Expected: all 4 tests pass.

- [x] **Step 8: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add backend/Cargo.toml backend/Cargo.lock backend/src/speaker/mod.rs backend/src/speaker/store.rs backend/src/main.rs backend/src/lib.rs
git commit -m "feat: add SQLite-backed SpeakerStore for voice speaker identification"
```

---

### Task 3: Rust — `SpeakerIdClient` (HTTP client for the Python `/identify` endpoint)

**Files:**
- Create: `backend/src/speaker/client.rs`
- Modify: `backend/src/speaker/mod.rs` (uncomment the `client` lines from Task 2 Step 3)

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone HTTP client, same shape as `FasterWhisperProvider` in `backend/src/ai/stt.rs`).
- Produces: `pub struct SpeakerIdClient` with `pub fn new(service_url: String) -> Self` and `pub async fn identify(&self, audio_bytes: Vec<u8>, file_name: &str) -> anyhow::Result<Vec<f32>>`.

This task has no meaningful unit test of its own (it's a thin HTTP wrapper around a live network call — the existing codebase doesn't unit-test its other HTTP client wrappers like `FasterWhisperProvider` either, for the same reason). It's exercised by Task 5's manual end-to-end verification instead.

- [x] **Step 1: Write `backend/src/speaker/client.rs`**

```rust
use anyhow::Result;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;

/// Calls the local Python service's `/identify` endpoint to get a voice
/// fingerprint. Independent of whichever `STTProvider` is configured for
/// transcription (`local` or `mistral`) — Mistral has no speaker-embedding
/// API, so this always goes to the local service regardless.
pub struct SpeakerIdClient {
    client: Client,
    service_url: String,
}

impl SpeakerIdClient {
    pub fn new(service_url: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            service_url,
        }
    }

    /// Returns the 256-d voice fingerprint for this audio clip. Callers
    /// must treat failure as "unknown speaker" and continue the voice
    /// turn — never fail the whole turn over this (same principle as
    /// this codebase's TTS/STT failure handling).
    pub async fn identify(&self, audio_bytes: Vec<u8>, file_name: &str) -> Result<Vec<f32>> {
        let part = Part::bytes(audio_bytes).file_name(file_name.to_string());
        let form = Form::new().part("file", part);

        let res = self
            .client
            .post(&self.service_url)
            .multipart(form)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            anyhow::bail!("Speaker identification failed ({}): {}", status, err_text);
        }

        #[derive(Deserialize)]
        struct IdentifyResponse {
            fingerprint: Vec<f32>,
        }
        let parsed: IdentifyResponse = res.json().await?;
        Ok(parsed.fingerprint)
    }
}
```

- [x] **Step 2: Uncomment the `client` module in `backend/src/speaker/mod.rs`**

It should now read:
```rust
pub mod client;
pub mod name_extract;
pub mod store;

pub use client::SpeakerIdClient;
pub use name_extract::extract_name;
pub use store::{SpeakerMatch, SpeakerStore};
```
(the `name_extract` lines stay commented out until Task 4 — leave them as they were from Task 2 Step 3).

- [x] **Step 3: Confirm it compiles**

```bash
cd backend && cargo build
```
Expected: builds cleanly (with the `name_extract` references still commented out).

- [x] **Step 4: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add backend/src/speaker/client.rs backend/src/speaker/mod.rs
git commit -m "feat: add SpeakerIdClient for the local speaker-ID HTTP endpoint"
```

---

### Task 4: Rust — name-extraction heuristic

**Files:**
- Create: `backend/src/speaker/name_extract.rs`
- Modify: `backend/src/speaker/mod.rs` (uncomment the `name_extract` lines)

**Interfaces:**
- Produces: `pub fn extract_name(utterance: &str) -> Option<String>`

- [x] **Step 1: Write the failing tests**

Create `backend/src/speaker/name_extract.rs`:

```rust
pub fn extract_name(_utterance: &str) -> Option<String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_from_my_name_is() {
        assert_eq!(extract_name("My name is Daan."), Some("Daan".to_string()));
    }

    #[test]
    fn extracts_from_im_contraction() {
        assert_eq!(extract_name("I'm Sarah"), Some("Sarah".to_string()));
    }

    #[test]
    fn extracts_from_call_me() {
        assert_eq!(extract_name("call me Mo."), Some("Mo".to_string()));
    }

    #[test]
    fn extracts_bare_single_word_reply() {
        assert_eq!(extract_name("Daan"), Some("Daan".to_string()));
    }

    #[test]
    fn rejects_non_name_words_after_im() {
        // "I'm not sure" must NOT extract "Not" as a name — this is
        // exactly the false-positive the stoplist exists to catch.
        assert_eq!(extract_name("I'm not sure"), None);
        assert_eq!(extract_name("I'm just tired"), None);
    }

    #[test]
    fn rejects_unrelated_sentences() {
        assert_eq!(extract_name("I don't know what you mean"), None);
        assert_eq!(extract_name("what time is it"), None);
    }

    #[test]
    fn rejects_multi_word_bare_replies() {
        // A full sentence of alphabetic words shouldn't be mistaken for a
        // bare name reply.
        assert_eq!(extract_name("no idea honestly"), None);
    }
}
```

- [x] **Step 2: Run the tests to confirm they fail**

```bash
cd backend && cargo test speaker::name_extract
```
Expected: panics with "not yet implemented".

- [x] **Step 3: Implement `extract_name`**

```rust
/// Best-effort extraction of a spoken name from a reply given after Jimmy
/// asked (or might ask) who's speaking. Deliberately simple pattern
/// matching, not a full NLU pipeline — this is intentionally run on every
/// message from an unidentified speaker rather than requiring a "we just
/// asked for a name" flag (there's no clean signal for that without
/// parsing the LLM's own output), so the stoplist below carries the real
/// weight of avoiding false positives on ordinary sentences. A miss just
/// means Jimmy asks again next turn — that's the LLM's job, not this
/// function's.
const NON_NAME_WORDS: &[&str] = &[
    "not", "just", "still", "also", "going", "trying", "kind", "sort", "really", "very", "so",
    "feeling", "doing", "gonna", "about", "here", "done", "fine", "good", "okay", "ok", "tired",
    "busy", "sorry", "sure", "confused", "curious", "no", "yes", "maybe",
];

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

pub fn extract_name(utterance: &str) -> Option<String> {
    let lower = utterance.to_lowercase();
    let patterns = [
        "my name is ",
        "i'm ",
        "im ",
        "i am ",
        "it's ",
        "its ",
        "this is ",
        "call me ",
    ];

    for pat in patterns {
        if let Some(idx) = lower.find(pat) {
            let after = &utterance[idx + pat.len()..];
            if let Some(word) = after.split(|c: char| !c.is_alphanumeric()).find(|w| !w.is_empty()) {
                if word.len() >= 2 && !NON_NAME_WORDS.contains(&word.to_lowercase().as_str()) {
                    return Some(capitalize(word));
                }
            }
        }
    }

    // Bare single-word reply (e.g. just "Daan.") — one alphabetic word,
    // short enough to plausibly be a name rather than a sentence.
    let trimmed = utterance.trim().trim_end_matches(['.', '!', '?']);
    if !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_alphabetic())
        && trimmed.split_whitespace().count() == 1
        && trimmed.len() <= 20
        && !NON_NAME_WORDS.contains(&trimmed.to_lowercase().as_str())
    {
        return Some(capitalize(trimmed));
    }

    None
}
```

- [x] **Step 4: Run the tests to confirm they pass**

```bash
cd backend && cargo test speaker::name_extract
```
Expected: all 7 tests pass.

- [x] **Step 5: Uncomment the `name_extract` module in `backend/src/speaker/mod.rs`**

It should now read exactly as shown in Task 2 Step 3 (nothing commented out):
```rust
pub mod client;
pub mod name_extract;
pub mod store;

pub use client::SpeakerIdClient;
pub use name_extract::extract_name;
pub use store::{SpeakerMatch, SpeakerStore};
```

- [x] **Step 6: Confirm the whole crate still builds and all speaker tests pass**

```bash
cd backend && cargo build && cargo test speaker::
```

- [x] **Step 7: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add backend/src/speaker/name_extract.rs backend/src/speaker/mod.rs
git commit -m "feat: add name-extraction heuristic for unidentified speakers"
```

---

### Task 5: Rust — config + `AppState` wiring

**Files:**
- Modify: `backend/src/config/mod.rs`
- Modify: `backend/src/state/mod.rs`
- Modify: `.env.example` (document the new vars)

**Interfaces:**
- Consumes: `SpeakerStore::new`, `SpeakerIdClient::new` (Task 2, Task 3).
- Produces: `AppConfig.speaker_db_path: String`, `AppConfig.speaker_match_threshold: f32`, `AppConfig.speaker_id_service_url: String`; `AppState.speaker_store: Arc<SpeakerStore>`, `AppState.speaker_id_client: Arc<SpeakerIdClient>`.

- [x] **Step 1: Add config fields**

In `backend/src/config/mod.rs`, add to the `AppConfig` struct (after the `tts_*`/`audio_output_device` fields, before `// Conversation`):

```rust
    // Speaker identification
    pub speaker_db_path: String,
    pub speaker_match_threshold: f32,
    pub speaker_id_service_url: String,
```

In `AppConfig::from_env()`, add (after the `tts_*` block, before `session_idle_timeout_minutes`):

```rust
            speaker_db_path: env::var("SPEAKER_DB_PATH")
                .unwrap_or_else(|_| "data/jimmy.db".to_string()),
            speaker_match_threshold: env::var("SPEAKER_MATCH_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.75),
            speaker_id_service_url: env::var("SPEAKER_ID_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001/identify".to_string()),
```

- [x] **Step 2: Add fields to `AppState`**

In `backend/src/state/mod.rs`, add the import:
```rust
use crate::speaker::{SpeakerIdClient, SpeakerStore};
```

Add fields to the `AppState` struct (after `rejection_cache`):
```rust
    pub speaker_store: Arc<SpeakerStore>,
    pub speaker_id_client: Arc<SpeakerIdClient>,
```

In `AppState::new()`, before the final `Self { ... }` construction, add:
```rust
        let speaker_store = match SpeakerStore::new(&config.speaker_db_path, config.speaker_match_threshold) {
            Ok(store) => Arc::new(store),
            Err(e) => {
                // Same degrade-don't-crash principle as everything else in
                // this file: a broken speaker DB must not prevent Jimmy
                // from starting at all. An in-memory fallback still lets
                // identification run for the current process lifetime,
                // just without persistence across restarts.
                tracing::error!("Failed to open speaker DB at {}: {} — using in-memory fallback (no persistence)", config.speaker_db_path, e);
                Arc::new(
                    SpeakerStore::in_memory(config.speaker_match_threshold)
                        .expect("in-memory SQLite must always succeed"),
                )
            }
        };
        let speaker_id_client = Arc::new(SpeakerIdClient::new(config.speaker_id_service_url.clone()));
```

Add `speaker_store` and `speaker_id_client` to the `Self { ... }` construction, alongside the other fields.

- [x] **Step 3: Document the new env vars**

In `.env.example`, add (near the existing `STT_*`/`TTS_*` vars):
```
# Speaker identification (voice recognition)
SPEAKER_DB_PATH=data/jimmy.db
SPEAKER_MATCH_THRESHOLD=0.75
SPEAKER_ID_SERVICE_URL=http://127.0.0.1:8001/identify
```

- [x] **Step 4: Confirm it builds**

```bash
cd backend && cargo build
```
Expected: builds cleanly. (`speaker_store`/`speaker_id_client` aren't used anywhere yet — that's fine, Task 6 wires them in; if the compiler warns about unused fields that's expected at this point and resolves once Task 6 lands.)

- [x] **Step 5: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add backend/src/config/mod.rs backend/src/state/mod.rs .env.example
git commit -m "feat: wire SpeakerStore and SpeakerIdClient into AppConfig/AppState"
```

---

### Task 6: Rust — wire speaker identification into `voice_turn_handler`

**Files:**
- Modify: `backend/src/api/routes.rs`

**Interfaces:**
- Consumes: `state.speaker_id_client.identify(audio_bytes, file_name) -> Result<Vec<f32>>`, `state.speaker_store.find_best_match(&fp) -> Result<Option<SpeakerMatch>>`, `state.speaker_store.enroll(&fp, name) -> Result<i64>`, `state.speaker_store.set_name(id, name) -> Result<()>`, `state.speaker_store.touch_last_seen(id) -> Result<()>`, `crate::speaker::extract_name(&str) -> Option<String>`.

This task has no isolated unit test — it's a sequence of calls glued into an existing handler that's already covered by the manual end-to-end verification in Step 4 below (the codebase's existing pattern: `voice_turn_handler` itself has no unit tests today either, since it's an HTTP handler wiring several I/O-bound calls together).

- [x] **Step 1: Add the import**

At the top of `backend/src/api/routes.rs`, add:
```rust
use crate::speaker::extract_name;
```

- [x] **Step 2: Clone the audio bytes before they're consumed by STT, and run identification concurrently**

Find (currently around line 390-406):
```rust
    // 2. Transition to Thinking & transcribe audio with STT
    state.state_machine.set_thinking().await;
    let stt_start = Instant::now();
    let stt_res = match state.stt.transcribe(audio_bytes, &file_name).await {
        Ok(res) => res,
        Err(e) => {
            error!("STT error: {}", e);
            state
                .state_machine
                .set_error(&format!("STT error: {}", e))
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("STT error: {}", e),
            ));
        }
    };
    let stt_latency = stt_start.elapsed().as_millis() as u64;
```

Replace with (clones `audio_bytes`/`file_name` once for the concurrent identify call — `state.stt.transcribe` takes ownership of the original, so both calls need their own copy):

```rust
    // 2. Transition to Thinking. Transcribe with STT and identify the
    // speaker's voice concurrently — independent operations on the same
    // audio, no reason to pay their latencies sequentially. Speaker ID
    // always goes to the local service regardless of which STTProvider is
    // configured for transcription (see SpeakerIdClient's doc comment).
    state.state_machine.set_thinking().await;
    let stt_start = Instant::now();
    let audio_for_id = audio_bytes.clone();
    let file_name_for_id = file_name.clone();

    let (stt_result, identify_result) = tokio::join!(
        state.stt.transcribe(audio_bytes, &file_name),
        state.speaker_id_client.identify(audio_for_id, &file_name_for_id)
    );

    let stt_res = match stt_result {
        Ok(res) => res,
        Err(e) => {
            error!("STT error: {}", e);
            state
                .state_machine
                .set_error(&format!("STT error: {}", e))
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("STT error: {}", e),
            ));
        }
    };
    let stt_latency = stt_start.elapsed().as_millis() as u64;

    // Speaker identification failure degrades to "unknown speaker" and
    // never fails the turn — same principle as TTS/STT fallback handling
    // elsewhere in this file.
    let speaker_match = match identify_result {
        Ok(fingerprint) => match state.speaker_store.find_best_match(&fingerprint) {
            Ok(Some(m)) => {
                let _ = state.speaker_store.touch_last_seen(m.speaker_id);
                Some(m)
            }
            Ok(None) => {
                // New voice — enroll it now (unnamed) so even before a
                // name is known, re-encountering this voice is recognized
                // as "the same person as last time".
                match state.speaker_store.enroll(&fingerprint, None) {
                    Ok(id) => Some(crate::speaker::SpeakerMatch {
                        speaker_id: id,
                        name: None,
                        confidence: 1.0,
                    }),
                    Err(e) => {
                        warn!("Failed to enroll new speaker: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                warn!("Speaker match lookup failed: {}", e);
                None
            }
        },
        Err(e) => {
            warn!("Speaker identification unavailable: {}", e);
            None
        }
    };
```

- [x] **Step 3: Build the speaker-aware system prompt and extract a name if one was offered**

Find (currently around lines 409-437, right after the `transcribed_text.is_empty()` check and the transcription broadcast):
```rust
    // 3. Add user message (may start a fresh session — see chat_handler)
    let (_, started_new_session) = state
        .conversation
        .add_message("user", &transcribed_text, None)
        .await;
    if started_new_session {
        info!("Idle timeout exceeded — started a fresh conversation session");
    }

    // 4. Fetch context
    let history = state.conversation.get_recent_messages(6).await;

    // 5. LLM Response
```

Replace with:
```rust
    // 3. If this speaker is known but unnamed, see if THIS message offers
    // a name (best-effort — see extract_name's doc comment for why this
    // runs unconditionally rather than only when a name was just asked
    // for). Do this before adding the message to history so the stored
    // system-prompt note below reflects the freshly-learned name.
    let mut speaker_name: Option<String> = speaker_match.as_ref().and_then(|m| m.name.clone());
    if let Some(ref m) = speaker_match {
        if m.name.is_none() {
            if let Some(name) = extract_name(&transcribed_text) {
                if let Err(e) = state.speaker_store.set_name(m.speaker_id, &name) {
                    warn!("Failed to save speaker name: {}", e);
                } else {
                    info!("Learned speaker name: {}", name);
                    speaker_name = Some(name);
                }
            }
        }
    }

    // 4. Add user message (may start a fresh session — see chat_handler)
    let (_, started_new_session) = state
        .conversation
        .add_message("user", &transcribed_text, None)
        .await;
    if started_new_session {
        info!("Idle timeout exceeded — started a fresh conversation session");
    }

    // 5. Fetch context
    let history = state.conversation.get_recent_messages(6).await;

    // Speaker-aware system prompt for THIS turn only — appended, not
    // written back to the prompt file, since it varies every request.
    let speaker_note = match &speaker_name {
        Some(name) => format!("\n\n## Current Speaker\nYou know who this is: {name}. Address them naturally as yourself would with someone you know — you don't need to re-introduce yourself or ask their name again."),
        None => "\n\n## Current Speaker\nYou do not recognize this voice. Naturally work finding out their name into the conversation somewhere in this reply or the next few — don't interrogate, don't break character, don't make it the whole reply unless it fits naturally.".to_string(),
    };
    let turn_system_prompt = format!("{}{}", state.system_prompt, speaker_note);

    // 6. LLM Response
```

- [x] **Step 4: Use `turn_system_prompt` instead of `&state.system_prompt` for this handler's LLM call**

Find (currently around lines 458-466):
```rust
    let llm_res = match state
        .llm
        .generate_response(
            &state.system_prompt,
            &history[..history.len() - 1],
            &transcribed_text,
            token_tx,
        )
        .await
```

Replace with:
```rust
    let llm_res = match state
        .llm
        .generate_response(
            &turn_system_prompt,
            &history[..history.len() - 1],
            &transcribed_text,
            token_tx,
        )
        .await
```

- [x] **Step 5: Renumber the remaining comments**

The handler's later step comments (`// 6. TTS Synthesis...`, `// 7. Record...`, `// 8. Transition to Speaking...`) are now off by one/two — update them to `// 7.`, `// 8.`, `// 9.` respectively so the numbering stays sequential (purely cosmetic, but leaving it wrong makes the handler confusing to read later).

- [x] **Step 6: Build**

```bash
cd backend && cargo build
```
Expected: builds cleanly.

- [x] **Step 7: Manual end-to-end verification**

This is the actual test for this task — a real voice turn through the running system.

```bash
# Ensure the Python service (with /identify from Task 1) and the Rust
# backend (rebuilt with this task's changes) are both running — restart
# both if they were already running from before this task's changes.

# Simulate a voice turn with a short recorded WAV (any short speech clip):
curl -s -X POST http://127.0.0.1:3000/api/voice-turn \
  -F "audio=@/path/to/a/short/speech/clip.wav" | python3 -m json.tool
```

Expected on the FIRST call with a never-before-heard voice: the reply text should read as though Jimmy doesn't know who's talking (it will vary — the LLM decides how to work it in, per the prompt instruction). Check the backend log for `Learned speaker name: <X>` if your test clip happened to say a name.

Run it a SECOND time with a clip of the SAME voice (can be the same file): the reply should no longer prompt for a name, and if a name was learned on the first call, the backend log / reply tone should reflect that Jimmy now treats this as a known speaker.

Also verify graceful degradation: temporarily stop the Python service (`pkill -f stt_tts_service.py`) and confirm a voice-turn request still gets a normal reply (just without speaker awareness) rather than an error — this proves the "identification failure never blocks the turn" constraint actually holds. Restart the Python service afterward.

- [x] **Step 8: Commit**

```bash
cd /home/daanh/Projects/code/private/jimmy
git add backend/src/api/routes.rs
git commit -m "feat: wire speaker identification into voice_turn_handler"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture overview (concurrent identify, dedicated endpoint, Rust owns DB) → Tasks 2/3/6. Python component → Task 1. SQLite schema → Task 2 Step 6 (`SCHEMA` constant matches the spec's `CREATE TABLE speakers` exactly). Config → Task 5. Conversation flow (known/unknown/name-extraction/enrollment) → Task 6. Error handling (Python unreachable, SQLite failures, corrupt DB) → Task 1 Step 3 (try/except), Task 5 Step 2 (in-memory fallback), Task 6 Step 2 (identify/match failures degrade to `None`). Testing section → Task 1 Step 6 (Python manual script), Task 2 (Rust unit tests), Task 4 (name-extraction unit tests), Task 6 Step 7 (manual end-to-end + degradation check). Open questions (Pi latency, name uniqueness) are explicitly deferred in the spec itself — no task needed.
- **Placeholder scan:** The only `todo!()`s are the intentional TDD red-step ones in Tasks 2 and 4, each immediately followed by a real implementation step — not left unresolved.
- **Type consistency:** `SpeakerMatch { speaker_id: i64, name: Option<String>, confidence: f32 }` is defined once in Task 2 and used with those exact field names in Task 6. `extract_name(&str) -> Option<String>` matches its Task 4 definition and Task 6 usage. `SpeakerIdClient::identify(Vec<u8>, &str) -> Result<Vec<f32>>` matches between Task 3's definition and Task 6's `tokio::join!` call.
