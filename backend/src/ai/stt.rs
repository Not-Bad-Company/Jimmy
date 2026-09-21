use anyhow::Result;
use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct STTResponse {
    pub text: String,
    pub duration_s: f32,
    pub latency_ms: u64,
}

#[async_trait]
pub trait STTProvider: Send + Sync {
    async fn transcribe(&self, audio_bytes: Vec<u8>, file_name: &str) -> Result<STTResponse>;
    async fn check_health(&self) -> bool;
    fn model_name(&self) -> &str;
}

/// The frontend actually records `audio/webm;codecs=opus` (see
/// `frontend/src/audio/recorder.ts`), not WAV — infer the real mime type
/// from the uploaded filename's extension instead of assuming WAV, since a
/// mismatched declared Content-Type can cause stricter remote APIs (Mistral)
/// to reject or mis-decode the upload even though lenient local decoders
/// (faster-whisper via ffmpeg) tolerate it by sniffing actual file content.
fn mime_for_filename(file_name: &str) -> &'static str {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".webm") {
        "audio/webm"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".m4a") || lower.ends_with(".mp4") {
        "audio/mp4"
    } else {
        "audio/wav"
    }
}

pub struct FasterWhisperProvider {
    client: Client,
    service_url: String,
    model_name: String,
}

impl FasterWhisperProvider {
    pub fn new(service_url: String, model_name: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            service_url,
            model_name,
        }
    }
}

#[async_trait]
impl STTProvider for FasterWhisperProvider {
    async fn transcribe(&self, audio_bytes: Vec<u8>, file_name: &str) -> Result<STTResponse> {
        let start = Instant::now();

        let part = Part::bytes(audio_bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_for_filename(file_name))?;

        let form = Form::new().part("file", part);

        let res = self
            .client
            .post(&self.service_url)
            .multipart(form)
            .send()
            .await?;

        if !res.status().is_success() {
            let err_text = res.text().await.unwrap_or_default();
            anyhow::bail!("STT transcription failed: {}", err_text);
        }

        #[derive(Deserialize)]
        struct ServiceTranscribeResponse {
            text: String,
            duration: Option<f32>,
            latency_ms: Option<f32>,
        }

        let parsed: ServiceTranscribeResponse = res.json().await?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(STTResponse {
            text: parsed.text,
            duration_s: parsed.duration.unwrap_or(0.0),
            latency_ms: parsed.latency_ms.map(|v| v as u64).unwrap_or(elapsed),
        })
    }

    async fn check_health(&self) -> bool {
        let health_url = self.service_url.replace("/transcribe", "/health");
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

    fn model_name(&self) -> &str {
        &self.model_name
    }
}

/// Mistral's Voxtral transcription API (`POST /v1/audio/transcriptions`).
/// $0.003/minute for `voxtral-mini-latest` batch transcription — cheap
/// enough that cost isn't a real concern for short push-to-talk utterances,
/// and it removes the need for local STT compute entirely (relevant for
/// the eventual Raspberry Pi target).
pub struct MistralSTTProvider {
    client: Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl MistralSTTProvider {
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
}

#[async_trait]
impl STTProvider for MistralSTTProvider {
    async fn transcribe(&self, audio_bytes: Vec<u8>, file_name: &str) -> Result<STTResponse> {
        let start = Instant::now();
        let endpoint = format!(
            "{}/audio/transcriptions",
            self.base_url.trim_end_matches('/')
        );

        let part = Part::bytes(audio_bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_for_filename(file_name))?;

        let form = Form::new()
            .text("model", self.model.clone())
            .part("file", part);

        let res = self
            .client
            .post(&endpoint)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            anyhow::bail!("Mistral STT transcription failed ({}): {}", status, err_text);
        }

        #[derive(Deserialize)]
        struct VoxtralResponse {
            text: String,
            usage: Option<VoxtralUsage>,
        }
        #[derive(Deserialize)]
        struct VoxtralUsage {
            prompt_audio_seconds: Option<f32>,
        }

        let parsed: VoxtralResponse = res.json().await?;
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(STTResponse {
            text: parsed.text,
            duration_s: parsed
                .usage
                .and_then(|u| u.prompt_audio_seconds)
                .unwrap_or(0.0),
            latency_ms: elapsed,
        })
    }

    async fn check_health(&self) -> bool {
        // No cheap dedicated health endpoint; a valid Bearer token against
        // the models list is a reasonable proxy (same approach used by
        // OpenAICompatibleProvider for the LLM).
        let endpoint = format!("{}/models", self.base_url.trim_end_matches('/'));
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

    fn model_name(&self) -> &str {
        &self.model
    }
}

pub struct MockSTTProvider {
    model_name: String,
}

impl MockSTTProvider {
    pub fn new(model_name: String) -> Self {
        Self { model_name }
    }
}

#[async_trait]
impl STTProvider for MockSTTProvider {
    async fn transcribe(&self, _audio_bytes: Vec<u8>, _file_name: &str) -> Result<STTResponse> {
        tokio::time::sleep(std::time::Duration::from_millis(85)).await;
        Ok(STTResponse {
            text: "Hello Jimmy.".to_string(),
            duration_s: 1.2,
            latency_ms: 85,
        })
    }

    async fn check_health(&self) -> bool {
        true
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }
}
