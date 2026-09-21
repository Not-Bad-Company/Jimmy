use anyhow::Result;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;
use tracing::{error, info};

use crate::conversation::ChatMessage;
use crate::robot::emotion::{GazeDirection, RobotEmotion};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMResponse {
    pub text: String,
    pub emotion: RobotEmotion,
    pub intensity: f32,
    pub gaze: GazeDirection,
    pub first_token_latency_ms: u64,
    pub total_latency_ms: u64,
    pub tokens_generated: u32,
    pub model_name: String,
}

#[async_trait]
pub trait LLMProvider: Send + Sync {
    async fn generate_response(
        &self,
        system_prompt: &str,
        history: &[ChatMessage],
        user_message: &str,
        token_callback: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<LLMResponse>;

    async fn check_health(&self) -> bool;
    fn model_name(&self) -> &str;
}

pub struct LocalLlamaCppProvider {
    client: Client,
    base_url: String,
    model: String,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
}

impl LocalLlamaCppProvider {
    pub fn new(
        base_url: String,
        model: String,
        temperature: f32,
        top_p: f32,
        max_tokens: u32,
    ) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(45))
                .build()
                .unwrap_or_default(),
            base_url,
            model,
            temperature,
            top_p,
            max_tokens,
        }
    }

    fn parse_structured_output(&self, raw: &str) -> (String, RobotEmotion, f32, GazeDirection) {
        // Try parsing JSON directly or extract JSON block
        let trimmed = raw.trim();
        let json_candidate = if let Some(start) = trimmed.find('{') {
            if let Some(end) = trimmed.rfind('}') {
                if end > start {
                    &trimmed[start..=end]
                } else {
                    trimmed
                }
            } else {
                trimmed
            }
        } else {
            trimmed
        };

        if let Ok(v) = serde_json::from_str::<Value>(json_candidate) {
            let resp = v
                .get("response")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            let emotion = v
                .get("emotion")
                .and_then(|e| e.as_str())
                .and_then(|e_str| match e_str.to_lowercase().as_str() {
                    "happy" => Some(RobotEmotion::Happy),
                    "sad" => Some(RobotEmotion::Sad),
                    "angry" => Some(RobotEmotion::Angry),
                    "surprised" => Some(RobotEmotion::Surprised),
                    "curious" => Some(RobotEmotion::Curious),
                    "confused" => Some(RobotEmotion::Confused),
                    "sleepy" => Some(RobotEmotion::Sleepy),
                    "thinking" => Some(RobotEmotion::Thinking),
                    "listening" => Some(RobotEmotion::Listening),
                    "speaking" => Some(RobotEmotion::Speaking),
                    "error" => Some(RobotEmotion::Error),
                    "neutral" => Some(RobotEmotion::Neutral),
                    _ => None,
                })
                .unwrap_or_else(|| self.infer_emotion_from_text(&resp));

            let intensity = v
                .get("intensity")
                .and_then(|i| i.as_f64())
                .map(|i| i as f32)
                .unwrap_or(0.65)
                .clamp(0.1, 1.0);

            let gaze = v
                .get("gaze")
                .and_then(|g| g.as_str())
                .and_then(|g_str| match g_str.to_lowercase().as_str() {
                    "up" => Some(GazeDirection::Up),
                    "down" => Some(GazeDirection::Down),
                    "left" => Some(GazeDirection::Left),
                    "right" => Some(GazeDirection::Right),
                    "up-left" => Some(GazeDirection::UpLeft),
                    "up-right" => Some(GazeDirection::UpRight),
                    "down-left" => Some(GazeDirection::DownLeft),
                    "down-right" => Some(GazeDirection::DownRight),
                    "center" => Some(GazeDirection::Center),
                    _ => None,
                })
                .unwrap_or(GazeDirection::Center);

            if !resp.is_empty() {
                return (resp, emotion, intensity, gaze);
            }
        }

        // Fallback: raw text cleaning
        let cleaned = trimmed
            .replace("```json", "")
            .replace("```", "")
            .trim()
            .to_string();

        let emotion = self.infer_emotion_from_text(&cleaned);
        (cleaned, emotion, 0.6, GazeDirection::Center)
    }

    fn infer_emotion_from_text(&self, text: &str) -> RobotEmotion {
        let lower = text.to_lowercase();
        if lower.contains("bad") || lower.contains("danger") || lower.contains("stop") {
            RobotEmotion::Angry
        } else if lower.contains("good")
            || lower.contains("excellent")
            || lower.contains("fix")
            || lower.contains("yes")
        {
            RobotEmotion::Happy
        } else if lower.contains("curious")
            || lower.contains("interesting")
            || lower.contains("question")
            || lower.contains("?")
        {
            RobotEmotion::Curious
        } else if lower.contains("broken")
            || lower.contains("cannot")
            || lower.contains("lost")
            || lower.contains("fail")
        {
            RobotEmotion::Sad
        } else if lower.contains("confused") || lower.contains("contradiction") {
            RobotEmotion::Confused
        } else {
            RobotEmotion::Neutral
        }
    }
}

#[async_trait]
impl LLMProvider for LocalLlamaCppProvider {
    async fn generate_response(
        &self,
        system_prompt: &str,
        history: &[ChatMessage],
        user_message: &str,
        token_callback: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<LLMResponse> {
        let endpoint = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));

        let mut messages = Vec::new();
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_prompt
        }));

        for msg in history {
            messages.push(serde_json::json!({
                "role": msg.role,
                "content": msg.content
            }));
        }

        messages.push(serde_json::json!({
            "role": "user",
            "content": user_message
        }));

        let request_payload = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "max_tokens": self.max_tokens,
            "stream": true
        });

        let start_time = Instant::now();
        let mut first_token_time: Option<Instant> = None;
        let mut full_accumulated = String::new();
        let mut token_count = 0u32;

        let response = self
            .client
            .post(&endpoint)
            .json(&request_payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let err_body = response.text().await.unwrap_or_default();
            error!("Local LLM error {}: {}", status, err_body);
            anyhow::bail!("LLM request failed with status {}: {}", status, err_body);
        }

        let mut stream = response.bytes_stream();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res?;
            let chunk_str = String::from_utf8_lossy(&chunk);

            for line in chunk_str.lines() {
                let line = line.trim();
                if line.is_empty() || line == "data: [DONE]" {
                    continue;
                }

                if let Some(json_str) = line.strip_prefix("data: ") {
                    if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                        if let Some(delta) = val
                            .pointer("/choices/0/delta/content")
                            .and_then(|c| c.as_str())
                        {
                            if !delta.is_empty() {
                                if first_token_time.is_none() {
                                    first_token_time = Some(Instant::now());
                                }
                                token_count += 1;
                                full_accumulated.push_str(delta);

                                if let Some(ref cb) = token_callback {
                                    let _ = cb.send(delta.to_string()).await;
                                }
                            }
                        }
                    }
                }
            }
        }

        let total_latency_ms = start_time.elapsed().as_millis() as u64;
        let first_token_latency_ms = first_token_time
            .map(|t| t.duration_since(start_time).as_millis() as u64)
            .unwrap_or(total_latency_ms);

        let (text, emotion, intensity, gaze) = self.parse_structured_output(&full_accumulated);

        info!(
            "LLM finished: first token {}ms, total {}ms, {} tokens. Emotion: {:?}",
            first_token_latency_ms, total_latency_ms, token_count, emotion
        );

        Ok(LLMResponse {
            text,
            emotion,
            intensity,
            gaze,
            first_token_latency_ms,
            total_latency_ms,
            tokens_generated: token_count,
            model_name: self.model.clone(),
        })
    }

    async fn check_health(&self) -> bool {
        let endpoint = format!("{}/models", self.base_url.trim_end_matches('/'));
        match self
            .client
            .get(&endpoint)
            .timeout(std::time::Duration::from_secs(2))
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

pub struct MockLLMProvider {
    model: String,
}

impl MockLLMProvider {
    pub fn new(model: String) -> Self {
        Self { model }
    }
}

#[async_trait]
impl LLMProvider for MockLLMProvider {
    async fn generate_response(
        &self,
        _system_prompt: &str,
        _history: &[ChatMessage],
        user_message: &str,
        token_callback: Option<tokio::sync::mpsc::Sender<String>>,
    ) -> Result<LLMResponse> {
        let lower = user_message.to_lowercase();
        let (reply, emotion, intensity, gaze) = if lower.contains("how are you") {
            (
                "Functional. All subsystems nominal. Good.",
                RobotEmotion::Happy,
                0.7,
                GazeDirection::Center,
            )
        } else if lower.contains("bad idea") {
            (
                "Agreed. Bad idea. Very bad. We do not repeat.",
                RobotEmotion::Angry,
                0.85,
                GazeDirection::Down,
            )
        } else if lower.contains("server is broken") || lower.contains("broken") {
            (
                "Bad. Inspect logs first. We can fix this.",
                RobotEmotion::Curious,
                0.75,
                GazeDirection::Up,
            )
        } else if lower.contains("photosynthesis") {
            ("Light photons excite electrons. Water splits. Produces sugar and oxygen. Elegant system.", RobotEmotion::Neutral, 0.6, GazeDirection::Center)
        } else if lower.contains("like me") {
            (
                "Yes. You are partner. Together we solve problems.",
                RobotEmotion::Happy,
                0.9,
                GazeDirection::Center,
            )
        } else if lower.contains("why did you") {
            (
                "Calculated optimal outcome. Efficiency improved.",
                RobotEmotion::Thinking,
                0.7,
                GazeDirection::UpRight,
            )
        } else if lower.contains("hello") || lower.contains("hi") {
            (
                "Good to see you. System active. Question?",
                RobotEmotion::Happy,
                0.8,
                GazeDirection::Center,
            )
        } else {
            (
                "Understood. Simple and clear. We proceed.",
                RobotEmotion::Neutral,
                0.5,
                GazeDirection::Center,
            )
        };

        // Simulate streaming tokens with low latency
        let words: Vec<&str> = reply.split_whitespace().collect();
        let token_delay = std::time::Duration::from_millis(30);

        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        let first_token_latency = 40u64;

        for word in words {
            if let Some(ref cb) = token_callback {
                let _ = cb.send(format!("{} ", word)).await;
            }
            tokio::time::sleep(token_delay).await;
        }

        let total_latency = 40 + (reply.split_whitespace().count() as u64 * 30);

        Ok(LLMResponse {
            text: reply.to_string(),
            emotion,
            intensity,
            gaze,
            first_token_latency_ms: first_token_latency,
            total_latency_ms: total_latency,
            tokens_generated: reply.split_whitespace().count() as u32,
            model_name: format!("{}-mock", self.model),
        })
    }

    async fn check_health(&self) -> bool {
        true
    }

    fn model_name(&self) -> &str {
        &self.model
    }
}
