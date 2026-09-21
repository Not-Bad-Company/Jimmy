use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,

    // LLM
    pub llm_provider: String,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_temperature: f32,
    pub llm_top_p: f32,
    pub llm_max_tokens: u32,
    pub llm_reasoning: bool,

    // STT
    pub stt_provider: String,
    pub stt_service_url: String,
    pub stt_model: String,
    pub audio_input_device: String,

    // TTS
    pub tts_provider: String,
    pub tts_service_url: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub audio_output_device: String,

    // Speaker identification
    pub speaker_db_path: String,
    pub speaker_match_threshold: f32,
    pub speaker_id_service_url: String,

    // Conversation
    /// If more than this many minutes pass with no new message, the next
    /// message starts a fresh conversation (old history is dropped) instead
    /// of being appended to a stale, possibly unrelated context.
    pub session_idle_timeout_minutes: i64,
}

impl AppConfig {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();

        Self {
            host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3000),

            llm_provider: env::var("LLM_PROVIDER").unwrap_or_else(|_| "local".to_string()),
            llm_base_url: env::var("LLM_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:11435/v1".to_string()),
            llm_model: env::var("LLM_MODEL").unwrap_or_else(|_| "qwen2.5:3b".to_string()),
            llm_temperature: env::var("LLM_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.3),
            llm_top_p: env::var("LLM_TOP_P")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.9),
            llm_max_tokens: env::var("LLM_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
            llm_reasoning: env::var("LLM_REASONING")
                .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
                .unwrap_or(false),

            stt_provider: env::var("STT_PROVIDER").unwrap_or_else(|_| "local".to_string()),
            stt_service_url: env::var("STT_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001/transcribe".to_string()),
            stt_model: env::var("STT_MODEL").unwrap_or_else(|_| "base.en".to_string()),
            audio_input_device: env::var("AUDIO_INPUT_DEVICE")
                .unwrap_or_else(|_| "default".to_string()),

            tts_provider: env::var("TTS_PROVIDER").unwrap_or_else(|_| "local".to_string()),
            tts_service_url: env::var("TTS_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001/synthesize".to_string()),
            tts_model: env::var("TTS_MODEL").unwrap_or_else(|_| "kokoro-v1.0".to_string()),
            tts_voice: env::var("TTS_VOICE").unwrap_or_else(|_| "bm_george".to_string()),
            audio_output_device: env::var("AUDIO_OUTPUT_DEVICE")
                .unwrap_or_else(|_| "default".to_string()),

            speaker_db_path: env::var("SPEAKER_DB_PATH")
                .unwrap_or_else(|_| "data/jimmy.db".to_string()),
            speaker_match_threshold: env::var("SPEAKER_MATCH_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.75),
            speaker_id_service_url: env::var("SPEAKER_ID_SERVICE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8001/identify".to_string()),

            session_idle_timeout_minutes: env::var("SESSION_IDLE_TIMEOUT_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(20),
        }
    }
}
