use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

use crate::ai::llm::EmotionSegment;
use crate::ai::tts::TTSProvider;
use crate::robot::emotion::RobotEmotion;

/// Short, in-character lines Jimmy speaks when the real reply's TTS gets
/// rejected (safety moderation, transient provider error) — several options
/// so a failure doesn't always play the exact same line, which would read
/// as an obviously canned error rather than just Jimmy being Jimmy.
pub const REJECTION_LINES: &[(&str, RobotEmotion, f32)] = &[
    ("No.", RobotEmotion::Annoyed, 0.6),
    ("Not saying that.", RobotEmotion::Annoyed, 0.55),
    ("Nope.", RobotEmotion::Bored, 0.4),
    ("Hard pass.", RobotEmotion::Skeptical, 0.5),
    ("Not happening.", RobotEmotion::Annoyed, 0.6),
    ("Zip it.", RobotEmotion::Annoyed, 0.65),
    ("Watch it.", RobotEmotion::Angry, 0.65),
    ("Enough.", RobotEmotion::Angry, 0.6),
];

#[derive(Clone)]
pub struct CachedRejectionLine {
    pub text: &'static str,
    pub emotion: RobotEmotion,
    pub intensity: f32,
    pub audio_base64: String,
    pub duration_ms: u64,
}

/// These lines are fixed text — there is no reason to spend a network call
/// (and provider usage) re-synthesizing one every time a reply gets
/// rejected. `warm()` synthesizes each one exactly once, at startup, and
/// `pick()` afterwards just samples the cache — the runtime fallback path
/// never has to call the TTS provider at all.
#[derive(Default)]
pub struct RejectionLineCache {
    lines: Vec<CachedRejectionLine>,
}

impl RejectionLineCache {
    /// Best-effort: a line that fails to pre-render (provider unreachable
    /// at boot, etc.) is just skipped, not retried. An empty result just
    /// means `pick()` always returns `None` and callers fall back to
    /// synthesizing on demand instead.
    pub async fn warm(tts: &dyn TTSProvider) -> Self {
        let mut lines = Vec::new();
        for (text, emotion, intensity) in REJECTION_LINES {
            let segment = EmotionSegment {
                text: (*text).to_string(),
                emotion: *emotion,
                intensity: *intensity,
            };
            match tts
                .synthesize_segments(std::slice::from_ref(&segment))
                .await
            {
                Ok((tts_out, timings)) => {
                    use base64::Engine;
                    let duration_ms = timings.first().map(|t| t.duration_ms).unwrap_or(0);
                    lines.push(CachedRejectionLine {
                        text,
                        emotion: *emotion,
                        intensity: *intensity,
                        audio_base64: base64::engine::general_purpose::STANDARD
                            .encode(&tts_out.audio_bytes),
                        duration_ms,
                    });
                }
                Err(e) => {
                    warn!("Could not pre-render rejection line {:?}: {}", text, e);
                }
            }
        }
        info!(
            "Pre-rendered {}/{} rejection lines for TTS fallback",
            lines.len(),
            REJECTION_LINES.len()
        );
        Self { lines }
    }

    pub fn pick(&self) -> Option<&CachedRejectionLine> {
        if self.lines.is_empty() {
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let idx = (nanos as usize) % self.lines.len();
        self.lines.get(idx)
    }
}
