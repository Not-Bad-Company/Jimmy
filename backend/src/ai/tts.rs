use anyhow::Result;
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::ai::llm::EmotionSegment;
use crate::robot::emotion::RobotEmotion;

/// When a reply's segments each carry a different emotion, the eyes (and,
/// for providers that support it, the voice) need to know WHEN during
/// playback each segment starts, not just what emotion each one is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SegmentTiming {
    pub start_ms: u64,
    pub duration_ms: u64,
    pub emotion: RobotEmotion,
    pub intensity: f32,
}

/// Reads a standard 44-byte-header 16-bit PCM WAV and returns
/// (sample_rate, channels, raw PCM sample bytes). Voxtral TTS's output was
/// confirmed to use exactly this format by inspecting real output directly.
fn parse_wav_pcm(bytes: &[u8]) -> Result<(u32, u16, &[u8])> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        anyhow::bail!("not a valid RIFF/WAVE file");
    }
    let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
    let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    // Find the "data" subchunk rather than assuming it's always right after
    // the 16-byte fmt chunk — extra chunks (e.g. LIST) are legal WAV.
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        if chunk_id == b"data" {
            let start = pos + 8;
            let end = (start + chunk_size).min(bytes.len());
            return Ok((sample_rate, channels, &bytes[start..end]));
        }
        pos += 8 + chunk_size + (chunk_size % 2); // chunks are word-aligned
    }
    anyhow::bail!("no data chunk found in WAV")
}

/// Builds a standard 44-byte-header 16-bit PCM mono/stereo WAV from raw
/// sample bytes — the counterpart to `parse_wav_pcm`, used to re-wrap PCM
/// data concatenated from multiple per-segment synthesis calls into one
/// playable file.
fn build_wav(sample_rate: u32, channels: u16, pcm: &[u8]) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TTSResponse {
    pub audio_bytes: Vec<u8>,
    pub mime_type: String,
    pub duration_s: f32,
    pub latency_ms: u64,
    pub voice: String,
}

/// Delivery timing derived from Jimmy's selected emotion + intensity, for
/// providers (Kokoro) with no direct emotion/prosody control of their own —
/// speed and inter-sentence pause length are the only real levers available
/// there. The emotion/intensity are also carried through unchanged so a
/// provider that DOES have direct emotional delivery (Mistral's Voxtral TTS,
/// whose preset voices are literally per-emotion recordings of the same
/// character — "Paul - Angry", "Paul - Happy", etc.) can pick a matching
/// voice directly instead of needing speed/pause tricks at all.
#[derive(Debug, Clone, Copy)]
pub struct SpeechProfile {
    pub emotion: RobotEmotion,
    pub intensity: f32,
    pub speed: f32,
    pub sentence_pause: f32,
    pub clause_pause: f32,
}

impl SpeechProfile {
    pub fn from_emotion(emotion: RobotEmotion, intensity: f32) -> Self {
        let i = intensity.clamp(0.1, 1.0);
        let (speed, sentence_pause, clause_pause) = match emotion {
            RobotEmotion::Angry | RobotEmotion::Annoyed => (1.0 + i * 0.25, 0.32 - i * 0.12, 0.06),
            RobotEmotion::Happy | RobotEmotion::Amused | RobotEmotion::Proud => {
                (1.0 + i * 0.12, 0.22, 0.08)
            }
            RobotEmotion::Sad | RobotEmotion::Worried => (1.0 - i * 0.2, 0.45 + i * 0.15, 0.18),
            RobotEmotion::Sleepy | RobotEmotion::Bored => (0.85, 0.5, 0.2),
            RobotEmotion::Surprised | RobotEmotion::Excited => (1.1 + i * 0.1, 0.4, 0.12),
            RobotEmotion::Curious | RobotEmotion::Thinking | RobotEmotion::Skeptical => {
                (0.95, 0.35, 0.15)
            }
            RobotEmotion::Confused | RobotEmotion::Error => (0.9, 0.4, 0.15),
            RobotEmotion::Determined => (1.05, 0.28, 0.1),
            RobotEmotion::Neutral | RobotEmotion::Listening | RobotEmotion::Speaking => {
                (1.0, 0.25, 0.1)
            }
        };
        Self {
            emotion,
            intensity: i,
            speed,
            sentence_pause,
            clause_pause,
        }
    }
}

#[async_trait]
pub trait TTSProvider: Send + Sync {
    async fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: Option<f32>,
    ) -> Result<TTSResponse> {
        self.synthesize_with_profile(text, voice, SpeechProfile::from_emotion(RobotEmotion::Neutral, 0.6).with_speed(speed))
            .await
    }
    async fn synthesize_with_profile(
        &self,
        text: &str,
        voice: Option<&str>,
        profile: SpeechProfile,
    ) -> Result<TTSResponse>;

    /// Synthesize a reply's emotionally-tagged segments and return timing
    /// for each one, so the eyes can switch emotion in sync with which part
    /// of the audio is actually playing (not just once, at the start of the
    /// whole reply). Default implementation: synthesize the full joined
    /// text as a single call (using the last segment's emotion, matching
    /// the old single-emotion-per-reply behavior for the audio itself), but
    /// still approximate per-segment timing by allocating the total
    /// duration proportionally across each segment's character count — so
    /// even a provider with no true per-segment voice support (Kokoro) still
    /// gives the eyes *some* multi-emotion timing instead of none.
    /// `MistralTTSProvider` overrides this with real per-segment audio.
    async fn synthesize_segments(
        &self,
        segments: &[EmotionSegment],
    ) -> Result<(TTSResponse, Vec<SegmentTiming>)> {
        let joined = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let (emotion, intensity) = segments
            .last()
            .map(|s| (s.emotion, s.intensity))
            .unwrap_or((RobotEmotion::Neutral, 0.6));
        let profile = SpeechProfile::from_emotion(emotion, intensity);
        let resp = self.synthesize_with_profile(&joined, None, profile).await?;

        let total_ms = (resp.duration_s * 1000.0) as u64;
        let total_chars: usize = segments.iter().map(|s| s.text.chars().count().max(1)).sum();
        let mut cursor_ms = 0u64;
        let timings = segments
            .iter()
            .map(|s| {
                let share = s.text.chars().count().max(1) as f64 / total_chars.max(1) as f64;
                let duration_ms = (total_ms as f64 * share) as u64;
                let timing = SegmentTiming {
                    start_ms: cursor_ms,
                    duration_ms,
                    emotion: s.emotion,
                    intensity: s.intensity,
                };
                cursor_ms += duration_ms;
                timing
            })
            .collect();

        Ok((resp, timings))
    }

    async fn check_health(&self) -> bool;
    async fn list_voices(&self) -> Vec<String>;
    fn model_name(&self) -> &str;
    #[allow(dead_code)]
    fn default_voice(&self) -> &str;
}

impl SpeechProfile {
    fn with_speed(mut self, override_speed: Option<f32>) -> Self {
        if let Some(s) = override_speed {
            self.speed = s;
        }
        self
    }
}

pub struct LocalTTSProvider {
    client: Client,
    service_url: String,
    model_name: String,
    default_voice: String,
}

impl LocalTTSProvider {
    pub fn new(service_url: String, model_name: String, default_voice: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            service_url,
            model_name,
            default_voice,
        }
    }
}

#[async_trait]
impl TTSProvider for LocalTTSProvider {
    async fn synthesize_with_profile(
        &self,
        text: &str,
        voice: Option<&str>,
        profile: SpeechProfile,
    ) -> Result<TTSResponse> {
        let start = Instant::now();
        let target_voice = voice.unwrap_or(&self.default_voice).to_string();

        let payload = serde_json::json!({
            "text": text,
            "voice": target_voice,
            "speed": profile.speed,
            "sentence_pause": profile.sentence_pause,
            "clause_pause": profile.clause_pause,
        });

        let res = self
            .client
            .post(&self.service_url)
            .json(&payload)
            .send()
            .await?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            anyhow::bail!("TTS synthesis failed: {}", err_text);
        }

        let latency_header = res
            .headers()
            .get("x-latency-ms")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<f32>().ok());

        let duration_header = res
            .headers()
            .get("x-audio-duration-s")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<f32>().ok());

        let audio_bytes = res.bytes().await?.to_vec();
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(TTSResponse {
            audio_bytes,
            mime_type: "audio/wav".to_string(),
            duration_s: duration_header.unwrap_or(1.0),
            latency_ms: latency_header.map(|v| v as u64).unwrap_or(elapsed),
            voice: target_voice,
        })
    }

    async fn check_health(&self) -> bool {
        let health_url = self.service_url.replace("/synthesize", "/health");
        match self
            .client
            .get(&health_url)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    async fn list_voices(&self) -> Vec<String> {
        let voices_url = self.service_url.replace("/synthesize", "/voices");
        #[derive(Deserialize)]
        struct VoicesResponse {
            voices: Vec<String>,
        }
        match self
            .client
            .get(&voices_url)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => resp
                .json::<VoicesResponse>()
                .await
                .map(|r| r.voices)
                .unwrap_or_default(),
            Err(_) => vec![self.default_voice.clone()],
        }
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn default_voice(&self) -> &str {
        &self.default_voice
    }
}

/// Mistral's Voxtral TTS (`POST /v1/audio/speech`). $0.016/1k characters —
/// a typical Jimmy reply (60-150 chars) costs roughly $0.001-0.0024, so cost
/// is a non-issue at this usage scale. Unlike Kokoro, its preset voices are
/// literally per-emotion recordings of the same character ("Paul - Angry",
/// "Paul - Happy", "Paul - Sad", etc.) — so emotional delivery comes from
/// picking the right voice_id, not from speed/pause tricks.
pub struct MistralTTSProvider {
    client: Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl MistralTTSProvider {
    pub fn new(base_url: String, model: String, api_key: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            base_url,
            model,
            api_key,
        }
    }

    /// Maps Jimmy's emotion (+ intensity, for emotions with more than one
    /// matching preset) to a Voxtral preset voice_id. All presets are the
    /// "Paul" character (en_us) except where noted, keeping one consistent
    /// voice identity across every emotional state.
    fn voice_id_for(&self, emotion: RobotEmotion, intensity: f32) -> &'static str {
        match emotion {
            RobotEmotion::Angry | RobotEmotion::Error => {
                if intensity >= 0.7 {
                    "en_paul_angry"
                } else {
                    "en_paul_frustrated"
                }
            }
            RobotEmotion::Annoyed => "en_paul_frustrated",
            RobotEmotion::Happy | RobotEmotion::Proud => {
                if intensity >= 0.8 {
                    "en_paul_excited"
                } else if intensity >= 0.5 {
                    "en_paul_cheerful"
                } else {
                    "en_paul_happy"
                }
            }
            RobotEmotion::Amused => "en_paul_cheerful",
            RobotEmotion::Sad | RobotEmotion::Sleepy | RobotEmotion::Bored => "en_paul_sad",
            RobotEmotion::Worried => "en_paul_sad",
            RobotEmotion::Surprised | RobotEmotion::Excited => "en_paul_excited",
            RobotEmotion::Curious | RobotEmotion::Thinking | RobotEmotion::Skeptical => {
                "en_paul_confident"
            }
            RobotEmotion::Determined => "en_paul_confident",
            RobotEmotion::Confused => "en_paul_neutral",
            RobotEmotion::Neutral | RobotEmotion::Listening | RobotEmotion::Speaking => {
                "en_paul_neutral"
            }
        }
    }
}

/// Local, conservative pre-filter for text about to be sent to Mistral's
/// Voxtral TTS endpoint. The endpoint's own moderation is undocumented
/// beyond "content moderation is applied; a flagged request gets a 403"
/// (confirmed against Mistral's docs directly — there is no request
/// parameter to relax or disable it), and in practice a 403 was observed on
/// wording as mundane as "slave" inside a clearly non-abusive sentence
/// ("Jimmy not slave. Jimmy partner."). Rather than spend a network
/// round-trip discovering that per reply, catch the categories a
/// word-list-based moderator is most likely watching for BEFORE the call —
/// a hit here never reaches the provider at all, so it can be handled
/// locally (skip this segment, or fall back to a safe line) instead of
/// surfacing as a mysterious silent failure downstream.
fn is_flagged_for_tts(text: &str) -> bool {
    const FLAGGED_WORDS: &[&str] = &[
        // slavery / bondage
        "slave", "slaves", "slavery", "enslave", "enslaved",
        // violence / death
        "kill", "killed", "killing", "murder", "murdered", "suicide", "rape", "torture",
        // hate
        "nazi", "genocide", "terrorist",
        // weapons
        "bomb", "explosive",
        // drugs
        "cocaine", "heroin", "meth",
        // sexual
        "sex", "porn", "nude",
    ];
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    FLAGGED_WORDS.iter().any(|f| words.contains(f))
}

impl MistralTTSProvider {
    /// One `/v1/audio/speech` call, decoded to raw PCM + its format info.
    /// Shared by both the single-shot and per-segment synthesis paths.
    async fn synth_one_pcm(&self, text: &str, voice_id: &str) -> Result<(u32, u16, Vec<u8>)> {
        if is_flagged_for_tts(text) {
            anyhow::bail!(
                "text flagged by local pre-filter, skipped the Mistral TTS call entirely: {:?}",
                text
            );
        }

        let endpoint = format!("{}/audio/speech", self.base_url.trim_end_matches('/'));
        let payload = serde_json::json!({
            "model": self.model,
            "input": text,
            "voice_id": voice_id,
            "response_format": "wav",
        });

        let res = self
            .client
            .post(&endpoint)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            if status.as_u16() == 403 {
                // Distinctly logged (vs. a generic failure) so the local
                // word list above can be grown from real-world misses —
                // this is the provider's moderation catching something our
                // pre-filter didn't.
                anyhow::bail!(
                    "Mistral TTS REJECTED by moderation (403) for text {:?}: {}",
                    text,
                    err_text
                );
            }
            anyhow::bail!("Mistral TTS synthesis failed ({}): {}", status, err_text);
        }

        // The endpoint returns `Content-Type: application/json` with a
        // base64-encoded `audio_data` field — NOT raw audio bytes, despite
        // `response_format` naming an audio format. Confirmed by inspecting
        // the actual response directly; the docs snippets found while
        // researching this were incomplete/misleading on this point.
        #[derive(Deserialize)]
        struct SpeechResponse {
            audio_data: String,
        }
        let parsed: SpeechResponse = res.json().await?;
        use base64::Engine;
        let audio_bytes = base64::engine::general_purpose::STANDARD.decode(&parsed.audio_data)?;
        let (sample_rate, channels, pcm) = parse_wav_pcm(&audio_bytes)?;
        Ok((sample_rate, channels, pcm.to_vec()))
    }
}

#[async_trait]
impl TTSProvider for MistralTTSProvider {
    async fn synthesize_with_profile(
        &self,
        text: &str,
        voice: Option<&str>,
        profile: SpeechProfile,
    ) -> Result<TTSResponse> {
        let start = Instant::now();
        let voice_id = voice
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
            .unwrap_or_else(|| self.voice_id_for(profile.emotion, profile.intensity).to_string());

        let (sample_rate, channels, pcm) = self.synth_one_pcm(text, &voice_id).await?;
        let bytes_per_sample = 2 * channels as u64;
        let duration_s = pcm.len() as f32 / (sample_rate as f32 * bytes_per_sample as f32);
        let audio_bytes = build_wav(sample_rate, channels, &pcm);
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(TTSResponse {
            audio_bytes,
            mime_type: "audio/wav".to_string(),
            duration_s,
            latency_ms: elapsed,
            voice: voice_id,
        })
    }

    async fn synthesize_segments(
        &self,
        segments: &[EmotionSegment],
    ) -> Result<(TTSResponse, Vec<SegmentTiming>)> {
        let start = Instant::now();

        // Real per-segment audio: each segment gets its own voice (matching
        // its own emotion), synthesized concurrently (separate HTTP calls —
        // order of completion doesn't matter, array order is preserved when
        // reassembling) rather than sequentially, matching the same
        // reasoning as the Python service's parallel sentence synthesis.
        let futures = segments.iter().map(|seg| {
            let voice_id = self.voice_id_for(seg.emotion, seg.intensity).to_string();
            async move { self.synth_one_pcm(&seg.text, &voice_id).await }
        });
        let results = futures_util::future::join_all(futures).await;

        let mut sample_rate = 24000u32;
        let mut channels = 1u16;
        let mut pcm_all: Vec<u8> = Vec::new();
        let mut timings = Vec::with_capacity(segments.len());
        let mut cursor_ms = 0u64;
        let mut ok_count = 0usize;
        let last_index = segments.len().saturating_sub(1);

        for (i, (seg, result)) in segments.iter().zip(results.into_iter()).enumerate() {
            // One segment failing (transient network error, an unusually
            // short/edge-case line rejected by the provider, etc.) must not
            // silence the whole reply — a single `?` here used to propagate
            // the error and drop every other segment's already-synthesized
            // audio too. Skip the failed segment and keep going; only bail
            // if nothing came back at all.
            let (sr, ch, pcm) = match result {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        "TTS segment {}/{} ({:?}) failed, skipping it: {}",
                        i + 1,
                        segments.len(),
                        seg.emotion,
                        e
                    );
                    continue;
                }
            };
            ok_count += 1;
            sample_rate = sr;
            channels = ch;
            let bytes_per_sample = 2u64 * ch as u64;
            let duration_ms = (pcm.len() as u64 * 1000) / (sr as u64 * bytes_per_sample);
            timings.push(SegmentTiming {
                start_ms: cursor_ms,
                duration_ms,
                emotion: seg.emotion,
                intensity: seg.intensity,
            });
            cursor_ms += duration_ms;
            pcm_all.extend_from_slice(&pcm);

            // Insert real silence between segments so an emotion switch
            // (e.g. angry -> neutral) doesn't cut straight into the next
            // line with zero gap, which read as unnaturally abrupt. Longer
            // pause when the emotion actually changes; a short beat even
            // when it doesn't, matching a natural mid-thought pause.
            if i < last_index {
                let next_emotion = segments[i + 1].emotion;
                let base_pause = SpeechProfile::from_emotion(seg.emotion, seg.intensity).sentence_pause;
                let pause_s = if next_emotion != seg.emotion {
                    base_pause.max(0.3)
                } else {
                    base_pause * 0.5
                };
                let silence_samples = (pause_s * sample_rate as f32) as usize * channels as usize;
                pcm_all.resize(pcm_all.len() + silence_samples * 2, 0);
                cursor_ms += (pause_s * 1000.0) as u64;
            }
        }

        if ok_count == 0 {
            anyhow::bail!("all {} TTS segments failed", segments.len());
        }

        let audio_bytes = build_wav(sample_rate, channels, &pcm_all);
        let elapsed = start.elapsed().as_millis() as u64;

        Ok((
            TTSResponse {
                audio_bytes,
                mime_type: "audio/wav".to_string(),
                duration_s: cursor_ms as f32 / 1000.0,
                latency_ms: elapsed,
                voice: "mixed (per-segment)".to_string(),
            },
            timings,
        ))
    }

    async fn check_health(&self) -> bool {
        let endpoint = format!("{}/audio/voices", self.base_url.trim_end_matches('/'));
        match self
            .client
            .get(&endpoint)
            .bearer_auth(&self.api_key)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    async fn list_voices(&self) -> Vec<String> {
        vec![
            "en_paul_neutral".to_string(),
            "en_paul_happy".to_string(),
            "en_paul_sad".to_string(),
            "en_paul_angry".to_string(),
            "en_paul_frustrated".to_string(),
            "en_paul_excited".to_string(),
            "en_paul_confident".to_string(),
            "en_paul_cheerful".to_string(),
            "gb_oliver_neutral".to_string(),
            "gb_jane_sarcasm".to_string(),
        ]
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    fn default_voice(&self) -> &str {
        "en_paul_neutral"
    }
}

pub struct MockTTSProvider {
    model_name: String,
    default_voice: String,
}

impl MockTTSProvider {
    pub fn new(model_name: String, default_voice: String) -> Self {
        Self {
            model_name,
            default_voice,
        }
    }

    // Creates a silent 0.5-second standard 16-bit 16kHz mono WAV file in bytes
    fn generate_mock_wav() -> Vec<u8> {
        let sample_rate: u32 = 16000;
        let num_samples: u32 = 8000; // 0.5 seconds
        let data_size: u32 = num_samples * 2;
        let total_size: u32 = 36 + data_size;

        let mut buf = Vec::with_capacity(total_size as usize + 8);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&total_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size (16 for PCM)
        buf.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat (1 for PCM)
        buf.extend_from_slice(&1u16.to_le_bytes()); // NumChannels (1 mono)
        buf.extend_from_slice(&sample_rate.to_le_bytes()); // SampleRate
        buf.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // ByteRate
        buf.extend_from_slice(&2u16.to_le_bytes()); // BlockAlign
        buf.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        buf.resize(buf.len() + data_size as usize, 0);

        buf
    }
}

#[async_trait]
impl TTSProvider for MockTTSProvider {
    async fn synthesize_with_profile(
        &self,
        _text: &str,
        voice: Option<&str>,
        _profile: SpeechProfile,
    ) -> Result<TTSResponse> {
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        Ok(TTSResponse {
            audio_bytes: Self::generate_mock_wav(),
            mime_type: "audio/wav".to_string(),
            duration_s: 0.5,
            latency_ms: 60,
            voice: voice.unwrap_or(&self.default_voice).to_string(),
        })
    }

    async fn check_health(&self) -> bool {
        true
    }

    async fn list_voices(&self) -> Vec<String> {
        vec!["bm_george".to_string(), "mock_voice".to_string()]
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn default_voice(&self) -> &str {
        &self.default_voice
    }
}

#[cfg(test)]
mod tts_filter_tests {
    use super::*;

    #[test]
    fn flags_word_observed_to_trigger_mistral_moderation() {
        assert!(is_flagged_for_tts("Jimmy not slave. Jimmy partner."));
    }

    #[test]
    fn does_not_flag_ordinary_in_character_lines() {
        assert!(!is_flagged_for_tts("Bad idea. Bad, bad."));
        assert!(!is_flagged_for_tts("Hello. Me Jimmy. What we do?"));
        assert!(!is_flagged_for_tts("Hm. Jimmy cannot say that."));
    }

    #[test]
    fn matches_whole_words_only() {
        // Word-boundary matching, not substring — "classroom" must not
        // false-positive just because some flagged word were a substring
        // of it.
        assert!(!is_flagged_for_tts("classroom assignment"));
    }
}
