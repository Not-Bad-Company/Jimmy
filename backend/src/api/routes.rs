use axum::{
    extract::{Multipart, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tracing::{error, info, warn};

use crate::ai::tts::SegmentTiming;
use crate::conversation::ChatMessage;
use crate::robot::emotion::{GazeDirection, RobotEmotion, RobotState};
use crate::robot::RobotEvent;
use crate::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub backend: bool,
    pub llm: bool,
    pub stt: bool,
    pub tts: bool,
    pub llm_model: String,
    pub stt_model: String,
    pub tts_model: String,
}

/// Result of attempting to speak a reply. When the real text gets rejected
/// by TTS, `override_*` carries the substituted rejection line — the
/// caller must use these (not the original LLM text/emotion) for whatever
/// it stores/displays/broadcasts, so what's shown never disagrees with what
/// was actually spoken.
struct TtsOutcome {
    audio_base64: Option<String>,
    latency_ms: u64,
    segment_timings: Vec<SegmentTiming>,
    override_text: Option<String>,
    override_emotion: Option<RobotEmotion>,
    override_intensity: Option<f32>,
}

/// Synthesizes a reply's segments. If that fails outright (safety
/// moderation, provider error) it substitutes a random pre-rendered
/// rejection line from `cache` instead of leaving the reply mute — cached
/// because these are fixed text with no reason to burn a network call/TTS
/// usage on them per failure (see `ai::rejection`). If the cache is empty
/// (e.g. it failed to warm at startup), falls back further to synthesizing
/// one on demand as a last resort.
async fn synthesize_with_fallback(
    tts: &dyn crate::ai::tts::TTSProvider,
    cache: &crate::ai::RejectionLineCache,
    segments: &[crate::ai::llm::EmotionSegment],
) -> TtsOutcome {
    use base64::Engine;

    if let Ok((tts_out, timings)) = tts.synthesize_segments(segments).await {
        return TtsOutcome {
            audio_base64: Some(
                base64::engine::general_purpose::STANDARD.encode(&tts_out.audio_bytes),
            ),
            latency_ms: tts_out.latency_ms,
            segment_timings: timings,
            override_text: None,
            override_emotion: None,
            override_intensity: None,
        };
    }

    warn!("TTS synthesis error, substituting a rejection line");

    if let Some(line) = cache.pick() {
        return TtsOutcome {
            audio_base64: Some(line.audio_base64.clone()),
            latency_ms: 0,
            segment_timings: vec![SegmentTiming {
                start_ms: 0,
                duration_ms: line.duration_ms,
                emotion: line.emotion,
                intensity: line.intensity,
            }],
            override_text: Some(line.text.to_string()),
            override_emotion: Some(line.emotion),
            override_intensity: Some(line.intensity),
        };
    }

    warn!("Rejection-line cache empty, synthesizing a fallback on demand");
    let (text, emotion, intensity) = crate::ai::rejection::REJECTION_LINES[0];
    let fallback_segment = crate::ai::llm::EmotionSegment {
        text: text.to_string(),
        emotion,
        intensity,
    };
    match tts
        .synthesize_segments(std::slice::from_ref(&fallback_segment))
        .await
    {
        Ok((tts_out, timings)) => TtsOutcome {
            audio_base64: Some(
                base64::engine::general_purpose::STANDARD.encode(&tts_out.audio_bytes),
            ),
            latency_ms: tts_out.latency_ms,
            segment_timings: timings,
            override_text: Some(text.to_string()),
            override_emotion: Some(emotion),
            override_intensity: Some(intensity),
        },
        Err(e2) => {
            warn!("Fallback TTS also failed (will continue without audio): {}", e2);
            TtsOutcome {
                audio_base64: None,
                latency_ms: 0,
                segment_timings: Vec::new(),
                override_text: None,
                override_emotion: None,
                override_intensity: None,
            }
        }
    }
}

pub async fn health_handler(State(state): State<AppState>) -> Json<HealthResponse> {
    let llm_healthy = state.llm.check_health().await;
    let stt_healthy = state.stt.check_health().await;
    let tts_healthy = state.tts.check_health().await;

    Json(HealthResponse {
        status: if llm_healthy && stt_healthy && tts_healthy {
            "healthy".into()
        } else {
            "degraded".into()
        },
        backend: true,
        llm: llm_healthy,
        stt: stt_healthy,
        tts: tts_healthy,
        llm_model: state.llm.model_name().to_string(),
        stt_model: state.stt.model_name().to_string(),
        tts_model: state.tts.model_name().to_string(),
    })
}

pub async fn get_status_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let current_state = state.state_machine.get_state().await;
    let cfg = state.config.read().await.clone();

    Json(serde_json::json!({
        "robot_state": current_state,
        "config": {
            "llm_provider": cfg.llm_provider,
            "llm_model": cfg.llm_model,
            "stt_provider": cfg.stt_provider,
            "stt_model": cfg.stt_model,
            "tts_provider": cfg.tts_provider,
            "tts_model": cfg.tts_model,
            "tts_voice": cfg.tts_voice,
        }
    }))
}

pub async fn get_conversation_handler(State(state): State<AppState>) -> Json<Vec<ChatMessage>> {
    let msgs = state.conversation.get_messages().await;
    Json(msgs)
}

pub async fn clear_conversation_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.conversation.clear().await;
    state.state_machine.set_idle().await;
    Json(serde_json::json!({ "cleared": true }))
}

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub synthesize_audio: Option<bool>,
    /// Currently unused: per-segment synthesis picks a voice per-emotion
    /// automatically (see `MistralTTSProvider::voice_id_for`), so there's
    /// no single voice to override for a whole (potentially multi-emotion)
    /// reply. Kept on the request type for API compatibility.
    pub voice: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub message: String,
    pub emotion: RobotEmotion,
    pub intensity: f32,
    pub gaze: GazeDirection,
    pub audio_base64: Option<String>,
    /// Per-segment emotion timing within `audio_base64`, in playback order
    /// — lets the frontend switch the eyes' emotion in sync with which part
    /// of the single concatenated audio file is actually playing, instead
    /// of only ever showing one emotion for the whole reply.
    pub segments: Vec<SegmentTiming>,
    pub latency: LatencyMetrics,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct LatencyMetrics {
    pub stt_latency_ms: u64,
    pub llm_first_token_ms: u64,
    pub llm_total_ms: u64,
    pub tts_latency_ms: u64,
    pub total_pipeline_ms: u64,
    pub tokens_generated: u32,
}

pub async fn chat_handler(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    let user_text = req.message.trim().to_string();
    if user_text.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Message cannot be empty".into()));
    }

    let pipeline_start = Instant::now();

    // 1. Transition to Thinking
    state.state_machine.set_thinking().await;

    // 2. Add user message. If enough idle time passed since the last
    // message, this starts a fresh session (old history dropped) so a
    // long-stale, unrelated conversation doesn't leak into the new one.
    let (_, started_new_session) = state
        .conversation
        .add_message("user", &user_text, None)
        .await;
    if started_new_session {
        info!("Idle timeout exceeded — started a fresh conversation session");
    }

    // 3. Fetch recent history
    let history = state.conversation.get_recent_messages(6).await;

    // 4. Run LLM
    let token_tx = {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(50);
        let sm = state.state_machine.clone();
        tokio::spawn(async move {
            while let Some(token) = rx.recv().await {
                sm.broadcast_event(RobotEvent {
                    event_type: "token".to_string(),
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    emotion_state: sm.get_state().await,
                    text: Some(token),
                    audio_url: None,
                    latency: None,
                });
            }
        });
        Some(tx)
    };

    let llm_res = match state
        .llm
        .generate_response(
            &state.system_prompt,
            &history[..history.len() - 1], // Exclude the user message just added to prevent duplicate in payload
            &user_text,
            token_tx,
        )
        .await
    {
        Ok(res) => res,
        Err(e) => {
            error!("LLM error: {}", e);
            state
                .state_machine
                .set_error(&format!("LLM error: {}", e))
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("LLM error: {}", e),
            ));
        }
    };

    // 5. Optional TTS synthesis. This runs BEFORE storing/broadcasting the
    // response (below) — a TTS rejection substitutes a rejection line (see
    // `synthesize_with_fallback`), and what's stored in conversation
    // history / broadcast / returned to the client must reflect what Jimmy
    // actually said, not the original (possibly rejected) LLM text, or the
    // transcript and the audio would disagree.
    let mut audio_base64 = None;
    let mut tts_latency_ms = 0u64;
    let mut segment_timings: Vec<SegmentTiming> = Vec::new();
    let mut final_text = llm_res.text;
    let mut final_emotion = llm_res.emotion;
    let mut final_intensity = llm_res.intensity;
    let final_gaze = llm_res.gaze;

    if req.synthesize_audio.unwrap_or(true) && !llm_res.segments.is_empty() {
        let outcome =
            synthesize_with_fallback(state.tts.as_ref(), &state.rejection_cache, &llm_res.segments)
                .await;
        audio_base64 = outcome.audio_base64;
        tts_latency_ms = outcome.latency_ms;
        segment_timings = outcome.segment_timings;
        if let Some(text) = outcome.override_text {
            final_text = text;
            final_emotion = outcome.override_emotion.unwrap_or(final_emotion);
            final_intensity = outcome.override_intensity.unwrap_or(final_intensity);
        }
    }

    // 6. Store the response actually spoken (see note above).
    state
        .conversation
        .add_message("assistant", &final_text, Some(final_emotion))
        .await;

    // 7. Transition to Speaking only if there's actually audio to play. TTS
    // can fail (provider rejects the text, network error, etc.) — broadcasting
    // Speaking unconditionally told every WS client (not just the one that
    // made this request) to start the speaking animation, and since no audio
    // ever plays, nothing ever sends `speech_finished` to clear it: the UI
    // was left glitching in a permanent "talking" pose over silence.
    if audio_base64.is_some() {
        state
            .state_machine
            .set_speaking(Some(final_emotion), Some(final_intensity), Some(final_gaze))
            .await;
    } else {
        state.state_machine.set_idle().await;
    }

    let total_pipeline_ms = pipeline_start.elapsed().as_millis() as u64;

    let latency = LatencyMetrics {
        stt_latency_ms: 0,
        llm_first_token_ms: llm_res.first_token_latency_ms,
        llm_total_ms: llm_res.total_latency_ms,
        tts_latency_ms,
        total_pipeline_ms,
        tokens_generated: llm_res.tokens_generated,
    };

    // Broadcast completion event
    state.state_machine.broadcast_event(RobotEvent {
        event_type: "response_complete".to_string(),
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        emotion_state: state.state_machine.get_state().await,
        text: Some(final_text.clone()),
        audio_url: None,
        latency: serde_json::to_value(&latency).ok(),
    });

    Ok(Json(ChatResponse {
        message: final_text,
        emotion: final_emotion,
        intensity: final_intensity,
        gaze: final_gaze,
        audio_base64,
        segments: segment_timings,
        latency,
    }))
}

pub async fn voice_turn_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    let pipeline_start = Instant::now();

    // 1. Transition to Listening
    state.state_machine.set_listening().await;

    let mut audio_bytes = Vec::new();
    let mut file_name = "audio.wav".to_string();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "audio" || name == "file" {
            if let Some(fname) = field.file_name() {
                file_name = fname.to_string();
            }
            if let Ok(bytes) = field.bytes().await {
                audio_bytes = bytes.to_vec();
            }
        }
    }

    if audio_bytes.is_empty() {
        state.state_machine.set_idle().await;
        return Err((StatusCode::BAD_REQUEST, "No audio provided".into()));
    }

    // 2. Transition to Thinking & transcribe audio with STT
    state.state_machine.set_thinking().await;
    let stt_start = Instant::now();
    let stt_res = match state.stt.transcribe(audio_bytes, &file_name).await {
        Ok(res) => res,
        Err(e) => {
            error!("STT error: {}", e);
            state
                .state_machine
                .set_error(&format!("STT error: {}", e))
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("STT error: {}", e),
            ));
        }
    };
    let stt_latency = stt_start.elapsed().as_millis() as u64;

    let transcribed_text = stt_res.text.trim().to_string();
    info!("STT Result: '{}' in {}ms", transcribed_text, stt_latency);

    if transcribed_text.is_empty() {
        state.state_machine.set_idle().await;
        return Err((StatusCode::BAD_REQUEST, "Speech was not recognized".into()));
    }

    // Broadcast transcription event
    state.state_machine.broadcast_event(RobotEvent {
        event_type: "transcription".to_string(),
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        emotion_state: state.state_machine.get_state().await,
        text: Some(transcribed_text.clone()),
        audio_url: None,
        latency: None,
    });

    // 3. Add user message (may start a fresh session — see chat_handler)
    let (_, started_new_session) = state
        .conversation
        .add_message("user", &transcribed_text, None)
        .await;
    if started_new_session {
        info!("Idle timeout exceeded — started a fresh conversation session");
    }

    // 4. Fetch context
    let history = state.conversation.get_recent_messages(6).await;

    // 5. LLM Response
    let token_tx = {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(50);
        let sm = state.state_machine.clone();
        tokio::spawn(async move {
            while let Some(token) = rx.recv().await {
                sm.broadcast_event(RobotEvent {
                    event_type: "token".to_string(),
                    timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    emotion_state: sm.get_state().await,
                    text: Some(token),
                    audio_url: None,
                    latency: None,
                });
            }
        });
        Some(tx)
    };

    let llm_res = match state
        .llm
        .generate_response(
            &state.system_prompt,
            &history[..history.len() - 1],
            &transcribed_text,
            token_tx,
        )
        .await
    {
        Ok(res) => res,
        Err(e) => {
            error!("LLM error: {}", e);
            state
                .state_machine
                .set_error(&format!("LLM error: {}", e))
                .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("LLM error: {}", e),
            ));
        }
    };

    // 6. TTS Synthesis, BEFORE recording/broadcasting the response (see the
    // matching comment in chat_handler() — a TTS rejection substitutes a
    // rejection line, and stored/broadcast/returned text must match what
    // was actually spoken).
    let mut audio_base64 = None;
    let mut tts_latency = 0u64;
    let mut segment_timings: Vec<SegmentTiming> = Vec::new();
    let mut final_text = llm_res.text;
    let mut final_emotion = llm_res.emotion;
    let mut final_intensity = llm_res.intensity;
    let final_gaze = llm_res.gaze;

    if !llm_res.segments.is_empty() {
        let outcome =
            synthesize_with_fallback(state.tts.as_ref(), &state.rejection_cache, &llm_res.segments)
                .await;
        audio_base64 = outcome.audio_base64;
        tts_latency = outcome.latency_ms;
        segment_timings = outcome.segment_timings;
        if let Some(text) = outcome.override_text {
            final_text = text;
            final_emotion = outcome.override_emotion.unwrap_or(final_emotion);
            final_intensity = outcome.override_intensity.unwrap_or(final_intensity);
        }
    }

    // 7. Record the response actually spoken.
    state
        .conversation
        .add_message("assistant", &final_text, Some(final_emotion))
        .await;

    // 8. Transition to Speaking only if there's actually audio to play — see
    // the matching comment in chat_handler() for why (TTS failure must not
    // leave clients stuck animating speech over silence).
    if audio_base64.is_some() {
        state
            .state_machine
            .set_speaking(Some(final_emotion), Some(final_intensity), Some(final_gaze))
            .await;
    } else {
        state.state_machine.set_idle().await;
    }

    let total_ms = pipeline_start.elapsed().as_millis() as u64;

    let latency = LatencyMetrics {
        stt_latency_ms: stt_latency,
        llm_first_token_ms: llm_res.first_token_latency_ms,
        llm_total_ms: llm_res.total_latency_ms,
        tts_latency_ms: tts_latency,
        total_pipeline_ms: total_ms,
        tokens_generated: llm_res.tokens_generated,
    };

    state.state_machine.broadcast_event(RobotEvent {
        event_type: "response_complete".to_string(),
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        emotion_state: state.state_machine.get_state().await,
        text: Some(final_text.clone()),
        audio_url: None,
        latency: serde_json::to_value(&latency).ok(),
    });

    Ok(Json(ChatResponse {
        message: final_text,
        emotion: final_emotion,
        intensity: final_intensity,
        gaze: final_gaze,
        audio_base64,
        segments: segment_timings,
        latency,
    }))
}

#[derive(Deserialize)]
pub struct SynthesizeRequest {
    pub text: String,
    pub voice: Option<String>,
    pub speed: Option<f32>,
}

pub async fn synthesize_handler(
    State(state): State<AppState>,
    Json(req): Json<SynthesizeRequest>,
) -> Result<Response, (StatusCode, String)> {
    let tts_res = state
        .tts
        .synthesize(&req.text, req.voice.as_deref(), req.speed)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("TTS error: {}", e),
            )
        })?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "audio/wav".parse().unwrap());
    headers.insert(
        "X-Latency-Ms",
        tts_res.latency_ms.to_string().parse().unwrap(),
    );

    Ok((headers, tts_res.audio_bytes).into_response())
}

pub async fn list_voices_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let voices = state.tts.list_voices().await;
    Json(serde_json::json!({ "voices": voices }))
}

#[derive(Deserialize)]
pub struct OverrideRequest {
    pub state: Option<RobotState>,
    pub emotion: Option<RobotEmotion>,
    pub intensity: Option<f32>,
    pub gaze: Option<GazeDirection>,
    pub action: Option<String>,
}

pub async fn override_handler(
    State(state): State<AppState>,
    Json(req): Json<OverrideRequest>,
) -> Json<serde_json::Value> {
    let current = state.state_machine.get_state().await;
    let new_state = req.state.unwrap_or(current.state);
    let updated = state
        .state_machine
        .transition_to(new_state, req.emotion, req.intensity, req.gaze, req.action)
        .await;

    Json(serde_json::json!({ "success": true, "state": updated }))
}
