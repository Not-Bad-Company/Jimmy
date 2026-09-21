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
            .mime_str("audio/wav")?;

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
            text: "Hello Rocky.".to_string(),
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
