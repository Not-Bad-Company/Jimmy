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

/// One emotionally-tagged chunk of a reply. A real reply is rarely one flat
/// emotion start-to-finish (a person's tone shifts within a single
/// sentence) — Jimmy previously carried exactly one {emotion, intensity}
/// for an entire response. `segments` lets each piece of text (and its
/// synthesized speech + the eyes during that speech) carry its own emotion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionSegment {
    pub text: String,
    pub emotion: RobotEmotion,
    pub intensity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMResponse {
    /// Full reply text, segment texts joined with spaces — kept for
    /// callers/logging that just want "what did Jimmy say", and for
    /// conversation history storage.
    pub text: String,
    pub segments: Vec<EmotionSegment>,
    /// Overall emotion/intensity = the LAST segment's — this is what's
    /// broadcast as Jimmy's resting emotional state once speech finishes,
    /// and what non-segment-aware consumers see.
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

pub struct OpenAICompatibleProvider {
    client: Client,
    base_url: String,
    model: String,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    /// Bearer token for remote providers (e.g. Mistral's La Plateforme API).
    /// None for a local endpoint like Ollama, which needs no auth.
    api_key: Option<String>,
    /// Sent as `reasoning_effort` on providers that support it (e.g.
    /// Mistral's hybrid instruct/reasoning models). The brief requires low
    /// latency, concise, non-chain-of-thought output, so this defaults to
    /// false ("none" — answer directly, no reasoning tokens). Providers
    /// that don't recognize the field (e.g. Ollama) ignore the extra key.
    reasoning: bool,
}

impl OpenAICompatibleProvider {
    pub fn new(
        base_url: String,
        model: String,
        temperature: f32,
        top_p: f32,
        max_tokens: u32,
    ) -> Self {
        Self::with_api_key(base_url, model, temperature, top_p, max_tokens, None)
    }

    pub fn with_api_key(
        base_url: String,
        model: String,
        temperature: f32,
        top_p: f32,
        max_tokens: u32,
        api_key: Option<String>,
    ) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(90))
                .build()
                .unwrap_or_default(),
            base_url,
            model,
            temperature,
            top_p,
            max_tokens,
            api_key,
            reasoning: false,
        }
    }

    pub fn with_reasoning(mut self, reasoning: bool) -> Self {
        self.reasoning = reasoning;
        self
    }

    fn parse_emotion_str(s: &str) -> Option<RobotEmotion> {
        match s.to_lowercase().as_str() {
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
            "amused" => Some(RobotEmotion::Amused),
            "proud" => Some(RobotEmotion::Proud),
            "bored" => Some(RobotEmotion::Bored),
            "annoyed" => Some(RobotEmotion::Annoyed),
            "skeptical" => Some(RobotEmotion::Skeptical),
            "determined" => Some(RobotEmotion::Determined),
            "worried" => Some(RobotEmotion::Worried),
            "excited" => Some(RobotEmotion::Excited),
            _ => None,
        }
    }

    fn parse_gaze_str(s: &str) -> Option<GazeDirection> {
        match s.to_lowercase().as_str() {
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
        }
    }

    /// A safe, never-empty, never-garbage single segment used whenever
    /// parsing fails entirely. Storing empty/garbage text into conversation
    /// history was observed to cascade into every subsequent turn also
    /// degenerating (the model echoes its own broken prior turn) — never
    /// return that; fall back to a short in-character line instead.
    fn fallback_segment() -> (Vec<EmotionSegment>, GazeDirection) {
        (
            vec![EmotionSegment {
                text: "Hm. Say again?".to_string(),
                emotion: RobotEmotion::Confused,
                intensity: 0.4,
            }],
            GazeDirection::Center,
        )
    }

    fn parse_structured_output(&self, raw: &str) -> (Vec<EmotionSegment>, GazeDirection) {
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
            let gaze = v
                .get("gaze")
                .and_then(|g| g.as_str())
                .and_then(Self::parse_gaze_str)
                .unwrap_or(GazeDirection::Center);

            // Preferred schema: an array of emotionally-tagged segments.
            if let Some(arr) = v.get("segments").and_then(|s| s.as_array()) {
                let segments: Vec<EmotionSegment> = arr
                    .iter()
                    .filter_map(|item| {
                        let text = item.get("text").and_then(|t| t.as_str())?.trim();
                        if text.is_empty() {
                            return None;
                        }
                        let emotion = item
                            .get("emotion")
                            .and_then(|e| e.as_str())
                            .and_then(Self::parse_emotion_str)
                            .unwrap_or_else(|| self.infer_emotion_from_text(text));
                        let intensity = item
                            .get("intensity")
                            .and_then(|i| i.as_f64())
                            .map(|i| i as f32)
                            .unwrap_or(0.65)
                            .clamp(0.1, 1.0);
                        Some(EmotionSegment {
                            text: text.to_string(),
                            emotion,
                            intensity,
                        })
                    })
                    .collect();

                if !segments.is_empty() {
                    return (segments, gaze);
                }
            }

            // Legacy/fallback flat schema (single response + emotion) —
            // kept so an occasional model slip into the old format still
            // works, wrapped as a single segment.
            let resp = v
                .get("response")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if !resp.is_empty() {
                let emotion = v
                    .get("emotion")
                    .and_then(|e| e.as_str())
                    .and_then(Self::parse_emotion_str)
                    .unwrap_or_else(|| self.infer_emotion_from_text(&resp));
                let intensity = v
                    .get("intensity")
                    .and_then(|i| i.as_f64())
                    .map(|i| i as f32)
                    .unwrap_or(0.65)
                    .clamp(0.1, 1.0);
                return (
                    vec![EmotionSegment {
                        text: resp,
                        emotion,
                        intensity,
                    }],
                    gaze,
                );
            }
        }

        // Fallback: raw text cleaning
        let cleaned = trimmed
            .replace("```json", "")
            .replace("```", "")
            .trim()
            .to_string();

        // A generation can occasionally come back empty or as bare JSON
        // punctuation with no actual words (observed: single-token
        // truncated streams, or rare degenerate/repetitive sampling).
        if cleaned.is_empty() || !cleaned.chars().any(|c| c.is_alphabetic()) {
            return Self::fallback_segment();
        }

        let emotion = self.infer_emotion_from_text(&cleaned);
        (
            vec![EmotionSegment {
                text: cleaned,
                emotion,
                intensity: 0.6,
            }],
            GazeDirection::Center,
        )
    }

    fn infer_emotion_from_text(&self, text: &str) -> RobotEmotion {
        let lower = text.to_lowercase();
        // Word-level matching (not substring) so "fixed" doesn't accidentally
        // match "fix", "broken" doesn't match "bad", etc.
        let words: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect();
        let has_any = |set: &[&str]| words.iter().any(|w| set.contains(w));

        // Negative/failure signals take priority over incidental positive
        // words (e.g. "cannot be fixed" must not read as happy just because
        // it contains "fixed").
        if has_any(&["broken", "cannot", "lost", "fail", "failed", "failure"]) {
            RobotEmotion::Sad
        } else if has_any(&["bad", "danger", "dangerous", "stop"]) {
            RobotEmotion::Angry
        } else if has_any(&["confused", "contradiction"]) {
            RobotEmotion::Confused
        } else if has_any(&["good", "excellent", "fix", "fixed", "yes"]) {
            RobotEmotion::Happy
        } else if has_any(&["curious", "interesting", "question"]) || lower.contains('?') {
            RobotEmotion::Curious
        } else {
            RobotEmotion::Neutral
        }
    }
}

#[async_trait]
impl LLMProvider for OpenAICompatibleProvider {
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
            "stream": true,
            "response_format": { "type": "json_object" },
            "reasoning_effort": if self.reasoning { "high" } else { "none" }
        });

        let start_time = Instant::now();
        let mut first_token_time: Option<Instant> = None;
        let mut full_accumulated = String::new();
        let mut token_count = 0u32;

        let mut request_builder = self.client.post(&endpoint).json(&request_payload);
        if let Some(ref key) = self.api_key {
            request_builder = request_builder.bearer_auth(key);
        }
        let response = request_builder.send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let err_body = response.text().await.unwrap_or_default();
            error!("Local LLM error {}: {}", status, err_body);
            anyhow::bail!("LLM request failed with status {}: {}", status, err_body);
        }

        let mut stream = response.bytes_stream();
        // SSE lines are not guaranteed to align with TCP/HTTP chunk
        // boundaries — a single `data: {...}` line can arrive split across
        // two separate poll_next() reads, especially at the higher token
        // throughput GPU inference produces. Processing chunk_str.lines()
        // independently per chunk silently drops any split line (the
        // partial JSON just fails to parse and is ignored), which was
        // observed to corrupt/truncate real responses under GPU load. A
        // persistent buffer across chunks, only consuming complete lines,
        // fixes this.
        let mut line_buffer = String::new();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res?;
            line_buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(newline_pos) = line_buffer.find('\n') {
                let line = line_buffer[..newline_pos].trim().to_string();
                line_buffer.drain(..=newline_pos);

                if line.is_empty() || line == "data: [DONE]" {
                    continue;
                }

                if let Some(json_str) = line.strip_prefix("data: ") {
                    match serde_json::from_str::<Value>(json_str) {
                        Ok(val) => {
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
                        Err(e) => {
                            error!("Failed to parse SSE JSON line (dropped token data): {} | line: {}", e, json_str);
                        }
                    }
                }
            }
        }

        let total_latency_ms = start_time.elapsed().as_millis() as u64;
        let first_token_latency_ms = first_token_time
            .map(|t| t.duration_since(start_time).as_millis() as u64)
            .unwrap_or(total_latency_ms);

        let (segments, gaze) = self.parse_structured_output(&full_accumulated);
        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        // Overall/resting emotion is the LAST segment's — whatever Jimmy's
        // tone lands on by the end of the reply is what the eyes settle
        // into and what gets broadcast as the current emotional state.
        let (emotion, intensity) = segments
            .last()
            .map(|s| (s.emotion, s.intensity))
            .unwrap_or((RobotEmotion::Neutral, 0.6));

        info!(
            "LLM finished: first token {}ms, total {}ms, {} tokens, {} segments. Overall emotion: {:?}",
            first_token_latency_ms, total_latency_ms, token_count, segments.len(), emotion
        );

        Ok(LLMResponse {
            text,
            segments,
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
        let mut req = self
            .client
            .get(&endpoint)
            .timeout(std::time::Duration::from_secs(5));
        if let Some(ref key) = self.api_key {
            req = req.bearer_auth(key);
        }
        match req.send().await {
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
            segments: vec![EmotionSegment {
                text: reply.to_string(),
                emotion,
                intensity,
            }],
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

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OpenAICompatibleProvider {
        OpenAICompatibleProvider::new(
            "http://127.0.0.1:11434/v1".to_string(),
            "test-model".to_string(),
            0.6,
            0.9,
            120,
        )
    }

    #[test]
    fn parses_segments_array() {
        let p = provider();
        let raw = r#"{"segments": [
            {"text": "Oh.", "emotion": "sad", "intensity": 0.6},
            {"text": "Jimmy fix it.", "emotion": "determined", "intensity": 0.7}
        ], "gaze": "down"}"#;
        let (segments, gaze) = p.parse_structured_output(raw);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Oh.");
        assert!(matches!(segments[0].emotion, RobotEmotion::Sad));
        assert_eq!(segments[1].text, "Jimmy fix it.");
        assert!(matches!(segments[1].emotion, RobotEmotion::Determined));
        assert_eq!(segments[1].intensity, 0.7);
        assert!(matches!(gaze, GazeDirection::Down));
    }

    #[test]
    fn segments_with_empty_text_are_dropped() {
        let p = provider();
        let raw = r#"{"segments": [
            {"text": "", "emotion": "happy", "intensity": 0.5},
            {"text": "Good.", "emotion": "happy", "intensity": 0.5}
        ]}"#;
        let (segments, _) = p.parse_structured_output(raw);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Good.");
    }

    #[test]
    fn falls_back_to_legacy_flat_schema_when_no_segments_array() {
        let p = provider();
        let raw = r#"{"response": "Bad idea. Bad, bad.", "emotion": "angry", "intensity": 0.8, "gaze": "center"}"#;
        let (segments, gaze) = p.parse_structured_output(raw);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Bad idea. Bad, bad.");
        assert!(matches!(segments[0].emotion, RobotEmotion::Angry));
        assert_eq!(segments[0].intensity, 0.8);
        assert!(matches!(gaze, GazeDirection::Center));
    }

    #[test]
    fn parses_json_wrapped_in_markdown_fence() {
        let p = provider();
        let raw = "```json\n{\"response\": \"Hello.\", \"emotion\": \"happy\", \"intensity\": 0.5, \"gaze\": \"center\"}\n```";
        let (segments, _) = p.parse_structured_output(raw);
        assert_eq!(segments[0].text, "Hello.");
        assert!(matches!(segments[0].emotion, RobotEmotion::Happy));
    }

    #[test]
    fn parses_json_with_leading_preamble_text() {
        let p = provider();
        let raw = r#"Sure, here is my response: {"response": "Good.", "emotion": "happy", "intensity": 0.5, "gaze": "center"}"#;
        let (segments, _) = p.parse_structured_output(raw);
        assert_eq!(segments[0].text, "Good.");
    }

    #[test]
    fn falls_back_to_raw_text_on_malformed_json() {
        let p = provider();
        let raw = r#"{"response": "Truncated because we ran out of tok"#;
        let (segments, gaze) = p.parse_structured_output(raw);
        // Malformed JSON must never crash or produce an empty response; it
        // degrades to the cleaned raw text instead.
        assert!(!segments[0].text.is_empty());
        assert!(matches!(gaze, GazeDirection::Center));
        assert!(matches!(
            segments[0].emotion,
            RobotEmotion::Neutral
                | RobotEmotion::Angry
                | RobotEmotion::Happy
                | RobotEmotion::Sad
                | RobotEmotion::Curious
                | RobotEmotion::Confused
        ));
    }

    #[test]
    fn falls_back_to_safe_text_on_empty_input() {
        let p = provider();
        let (segments, gaze) = p.parse_structured_output("");
        // Never return truly empty text: an empty assistant turn gets
        // stored into conversation history and fed back into every future
        // prompt, which is worse than a generic fallback line.
        assert!(!segments.is_empty());
        assert!(!segments[0].text.is_empty());
        assert!(matches!(gaze, GazeDirection::Center));
    }

    #[test]
    fn falls_back_to_safe_text_on_degenerate_punctuation_only_output() {
        let p = provider();
        // Observed in practice: a truncated/degenerate stream can produce
        // output that's technically non-empty but contains no actual words
        // (e.g. a lone brace, or a run of digits/punctuation). Storing this
        // verbatim into conversation history was observed to cascade into
        // every subsequent turn also degenerating.
        for raw in ["{", "{}", "1 1 1 8 8 7 7 9", "\"\\.,0,0"] {
            let (segments, _) = p.parse_structured_output(raw);
            assert!(
                segments[0].text.chars().any(|c| c.is_alphabetic()),
                "expected a safe word-containing fallback for input {:?}, got {:?}",
                raw,
                segments[0].text
            );
        }
    }

    #[test]
    fn unknown_emotion_string_infers_from_text_instead_of_failing() {
        let p = provider();
        let raw = r#"{"response": "This is broken and cannot be fixed.", "emotion": "not_a_real_emotion", "intensity": 0.5, "gaze": "center"}"#;
        let (segments, _) = p.parse_structured_output(raw);
        assert_eq!(segments[0].text, "This is broken and cannot be fixed.");
        assert!(matches!(segments[0].emotion, RobotEmotion::Sad));
    }

    #[test]
    fn intensity_is_clamped_to_valid_range() {
        let p = provider();
        let raw = r#"{"response": "Extreme.", "emotion": "angry", "intensity": 5.0, "gaze": "center"}"#;
        let (segments, _) = p.parse_structured_output(raw);
        assert_eq!(segments[0].intensity, 1.0);
    }
}
