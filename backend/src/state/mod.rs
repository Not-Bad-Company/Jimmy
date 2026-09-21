use std::sync::Arc;
use tokio::sync::RwLock;

use crate::ai::{
    FasterWhisperProvider, LLMProvider, MistralSTTProvider, MistralTTSProvider,
    OpenAICompatibleProvider, LocalTTSProvider, MockLLMProvider, MockSTTProvider, MockTTSProvider,
    RejectionLineCache, STTProvider, TTSProvider,
};
use crate::config::AppConfig;
use crate::conversation::ConversationStore;
use crate::robot::RobotStateMachine;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<AppConfig>>,
    pub state_machine: RobotStateMachine,
    pub conversation: ConversationStore,
    pub llm: Arc<dyn LLMProvider>,
    pub stt: Arc<dyn STTProvider>,
    pub tts: Arc<dyn TTSProvider>,
    pub system_prompt: Arc<String>,
    /// Pre-rendered "no"/"not saying that" style lines used when the real
    /// reply's TTS gets rejected — populated once via `warm_rejection_cache`
    /// after construction (it needs `.await`, `new()` doesn't), empty until
    /// then. See `ai::rejection`.
    pub rejection_cache: Arc<RejectionLineCache>,
}

impl AppState {
    pub fn new(config: AppConfig, system_prompt: String) -> Self {
        let is_mock_llm = config.llm_provider.eq_ignore_ascii_case("mock");
        let is_mock_stt = config.stt_provider.eq_ignore_ascii_case("mock");
        let is_mock_tts = config.tts_provider.eq_ignore_ascii_case("mock");

        let llm: Arc<dyn LLMProvider> = if is_mock_llm {
            Arc::new(MockLLMProvider::new(config.llm_model.clone()))
        } else {
            // Mistral's La Plateforme API needs a Bearer token; a local
            // endpoint (Ollama) needs none. Read MISTRAL_KEY directly
            // rather than a generic LLM_API_KEY name since that's what's
            // actually documented/set in .env for this provider.
            let api_key = if config.llm_provider.eq_ignore_ascii_case("mistral") {
                std::env::var("MISTRAL_KEY").ok()
            } else {
                None
            };
            Arc::new(
                OpenAICompatibleProvider::with_api_key(
                    config.llm_base_url.clone(),
                    config.llm_model.clone(),
                    config.llm_temperature,
                    config.llm_top_p,
                    config.llm_max_tokens,
                    api_key,
                )
                .with_reasoning(config.llm_reasoning),
            )
        };

        let stt: Arc<dyn STTProvider> = if is_mock_stt {
            Arc::new(MockSTTProvider::new(config.stt_model.clone()))
        } else if config.stt_provider.eq_ignore_ascii_case("mistral") {
            let api_key = std::env::var("MISTRAL_KEY").unwrap_or_default();
            Arc::new(MistralSTTProvider::new(
                config.stt_service_url.clone(),
                config.stt_model.clone(),
                api_key,
            ))
        } else {
            Arc::new(FasterWhisperProvider::new(
                config.stt_service_url.clone(),
                config.stt_model.clone(),
            ))
        };

        let tts: Arc<dyn TTSProvider> = if is_mock_tts {
            Arc::new(MockTTSProvider::new(
                config.tts_model.clone(),
                config.tts_voice.clone(),
            ))
        } else if config.tts_provider.eq_ignore_ascii_case("mistral") {
            let api_key = std::env::var("MISTRAL_KEY").unwrap_or_default();
            Arc::new(MistralTTSProvider::new(
                config.tts_service_url.clone(),
                config.tts_model.clone(),
                api_key,
            ))
        } else {
            Arc::new(LocalTTSProvider::new(
                config.tts_service_url.clone(),
                config.tts_model.clone(),
                config.tts_voice.clone(),
            ))
        };

        let session_idle_timeout_minutes = config.session_idle_timeout_minutes;

        Self {
            config: Arc::new(RwLock::new(config)),
            state_machine: RobotStateMachine::new(),
            conversation: ConversationStore::new(30)
                .with_session_timeout(session_idle_timeout_minutes),
            llm,
            stt,
            tts,
            system_prompt: Arc::new(system_prompt),
            rejection_cache: Arc::new(RejectionLineCache::default()),
        }
    }

    /// Pre-synthesizes the rejection-line pool via the real TTS provider.
    /// Separate from `new()` because it needs network I/O — call once at
    /// startup, before serving requests.
    pub async fn warm_rejection_cache(&mut self) {
        self.rejection_cache = Arc::new(RejectionLineCache::warm(self.tts.as_ref()).await);
    }
}
