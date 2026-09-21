use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tracing::debug;

use crate::robot::emotion::{GazeDirection, RobotEmotion, RobotState};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ClientWsMessage {
    #[serde(rename = "force_emotion")]
    ForceEmotion {
        emotion: RobotEmotion,
        intensity: Option<f32>,
        gaze: Option<GazeDirection>,
    },
    #[serde(rename = "force_state")]
    ForceState { state: RobotState },
    #[serde(rename = "force_gaze")]
    ForceGaze { gaze: GazeDirection },
    #[serde(rename = "speech_finished")]
    SpeechFinished,
    #[serde(rename = "ping")]
    Ping,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.state_machine.subscribe();

    // Send initial state immediately
    let initial_state = state.state_machine.get_state().await;
    let initial_payload = serde_json::json!({
        "event_type": "initial_state",
        "timestamp_ms": chrono::Utc::now().timestamp_millis(),
        "emotion_state": initial_state,
    });

    if let Ok(json_text) = serde_json::to_string(&initial_payload) {
        if sender.send(Message::Text(json_text.into())).await.is_err() {
            return;
        }
    }

    // Task to forward robot events to the client
    let mut send_task = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let Ok(msg_text) = serde_json::to_string(&event) {
                if sender.send(Message::Text(msg_text.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    // Task to process incoming messages from the client
    let state_clone = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(cmd) = serde_json::from_str::<ClientWsMessage>(&text) {
                        match cmd {
                            ClientWsMessage::ForceEmotion {
                                emotion,
                                intensity,
                                gaze,
                            } => {
                                state_clone
                                    .state_machine
                                    .transition_to(
                                        RobotState::Idle,
                                        Some(emotion),
                                        intensity,
                                        gaze,
                                        Some("manual_override".to_string()),
                                    )
                                    .await;
                            }
                            ClientWsMessage::ForceState { state } => {
                                state_clone
                                    .state_machine
                                    .transition_to(
                                        state,
                                        None,
                                        None,
                                        None,
                                        Some("manual_override".to_string()),
                                    )
                                    .await;
                            }
                            ClientWsMessage::ForceGaze { gaze } => {
                                let current = state_clone.state_machine.get_state().await;
                                state_clone
                                    .state_machine
                                    .transition_to(
                                        current.state,
                                        Some(current.emotion),
                                        Some(current.intensity),
                                        Some(gaze),
                                        None,
                                    )
                                    .await;
                            }
                            ClientWsMessage::SpeechFinished => {
                                debug!("Client reported speech playback finished.");
                                state_clone.state_machine.set_idle().await;
                            }
                            ClientWsMessage::Ping => {}
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // If either task finishes, abort the other
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}
