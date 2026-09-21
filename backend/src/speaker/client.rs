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
