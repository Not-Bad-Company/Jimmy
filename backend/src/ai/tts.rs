use anyhow::Result;
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TTSResponse {
    pub audio_bytes: Vec<u8>,
    pub mime_type: String,
    pub duration_s: f32,
    pub latency_ms: u64,
    pub voice: String,
}

#[async_trait]
pub trait TTSProvider: Send + Sync {
    async fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: Option<f32>,
    ) -> Result<TTSResponse>;
    async fn check_health(&self) -> bool;
    async fn list_voices(&self) -> Vec<String>;
    fn model_name(&self) -> &str;
    #[allow(dead_code)]
    fn default_voice(&self) -> &str;
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
    async fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: Option<f32>,
    ) -> Result<TTSResponse> {
        let start = Instant::now();
        let target_voice = voice.unwrap_or(&self.default_voice).to_string();

        let payload = serde_json::json!({
            "text": text,
            "voice": target_voice,
            "speed": speed.unwrap_or(1.0)
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
    async fn synthesize(
        &self,
        _text: &str,
        voice: Option<&str>,
        _speed: Option<f32>,
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
