use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use super::emotion::{EmotionState, GazeDirection, RobotEmotion, RobotState};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RobotEvent {
    pub event_type: String,
    pub timestamp_ms: i64,
    pub emotion_state: EmotionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<serde_json::Value>,
}

#[derive(Clone)]
pub struct RobotStateMachine {
    state: Arc<RwLock<EmotionState>>,
    event_tx: broadcast::Sender<RobotEvent>,
}

impl Default for RobotStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl RobotStateMachine {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(100);
        let sm = Self {
            state: Arc::new(RwLock::new(EmotionState::default())),
            event_tx: tx,
        };

        // Start background watchdog
        let sm_clone = sm.clone();
        tokio::spawn(async move {
            sm_clone.watchdog_loop().await;
        });

        sm
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RobotEvent> {
        self.event_tx.subscribe()
    }

    pub async fn get_state(&self) -> EmotionState {
        self.state.read().await.clone()
    }

    pub async fn transition_to(
        &self,
        new_state: RobotState,
        emotion: Option<RobotEmotion>,
        intensity: Option<f32>,
        gaze: Option<GazeDirection>,
        action: Option<String>,
    ) -> EmotionState {
        let mut current = self.state.write().await;
        let old_state = current.state;

        current.state = new_state;
        if let Some(emo) = emotion {
            current.emotion = emo;
        } else {
            // Default emotion mapping per state
            match new_state {
                RobotState::Listening => current.emotion = RobotEmotion::Listening,
                RobotState::Thinking => current.emotion = RobotEmotion::Thinking,
                RobotState::Speaking => current.emotion = RobotEmotion::Speaking,
                RobotState::Error => current.emotion = RobotEmotion::Error,
                RobotState::Idle => {
                    // Retain current emotion or reset to neutral if it was operational state
                    if matches!(
                        current.emotion,
                        RobotEmotion::Listening
                            | RobotEmotion::Thinking
                            | RobotEmotion::Speaking
                            | RobotEmotion::Error
                    ) {
                        current.emotion = RobotEmotion::Neutral;
                    }
                }
            }
        }

        if let Some(i) = intensity {
            current.intensity = i.clamp(0.1, 1.0);
        }

        if let Some(g) = gaze {
            current.gaze = g;
        }

        current.action = action;

        let result = current.clone();
        info!("State transition: {:?} -> {:?}", old_state, new_state);

        let event = RobotEvent {
            event_type: "state_change".to_string(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            emotion_state: result.clone(),
            text: None,
            audio_url: None,
            latency: None,
        };
        let _ = self.event_tx.send(event);

        result
    }

    pub async fn set_idle(&self) -> EmotionState {
        self.transition_to(
            RobotState::Idle,
            Some(RobotEmotion::Neutral),
            Some(0.5),
            Some(GazeDirection::Center),
            None,
        )
        .await
    }

    pub async fn set_listening(&self) -> EmotionState {
        self.transition_to(
            RobotState::Listening,
            Some(RobotEmotion::Listening),
            Some(0.7),
            Some(GazeDirection::Center),
            None,
        )
        .await
    }

    pub async fn set_thinking(&self) -> EmotionState {
        self.transition_to(
            RobotState::Thinking,
            Some(RobotEmotion::Thinking),
            Some(0.6),
            Some(GazeDirection::Up),
            None,
        )
        .await
    }

    pub async fn set_speaking(
        &self,
        emotion: Option<RobotEmotion>,
        intensity: Option<f32>,
        gaze: Option<GazeDirection>,
    ) -> EmotionState {
        self.transition_to(
            RobotState::Speaking,
            emotion.or(Some(RobotEmotion::Speaking)),
            intensity.or(Some(0.7)),
            gaze.or(Some(GazeDirection::Center)),
            None,
        )
        .await
    }

    pub async fn set_error(&self, message: &str) -> EmotionState {
        warn!("Robot error: {}", message);
        self.transition_to(
            RobotState::Error,
            Some(RobotEmotion::Error),
            Some(0.9),
            Some(GazeDirection::Center),
            Some(message.to_string()),
        )
        .await
    }

    pub fn broadcast_event(&self, event: RobotEvent) {
        let _ = self.event_tx.send(event);
    }

    async fn watchdog_loop(&self) {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        let mut state_timer = 0u64;
        let mut last_state = RobotState::Idle;

        loop {
            interval.tick().await;
            let current = self.state.read().await.clone();

            if current.state == last_state {
                state_timer += 5;
            } else {
                state_timer = 0;
                last_state = current.state;
            }

            match current.state {
                RobotState::Listening if state_timer >= 30 => {
                    warn!("Watchdog: Listening state timed out after 30s. Resetting to Idle.");
                    self.set_idle().await;
                }
                RobotState::Thinking if state_timer >= 60 => {
                    warn!("Watchdog: Thinking state timed out after 60s. Resetting to Error.");
                    self.set_error("Thinking timeout").await;
                }
                RobotState::Speaking if state_timer >= 60 => {
                    warn!("Watchdog: Speaking state timed out after 60s. Resetting to Idle.");
                    self.set_idle().await;
                }
                RobotState::Error if state_timer >= 10 => {
                    info!("Watchdog: Error state auto-recovered to Idle.");
                    self.set_idle().await;
                }
                _ => {}
            }
        }
    }
}
