use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RobotState {
    #[default]
    Idle,
    Listening,
    Thinking,
    Speaking,
    Error,
}

impl std::fmt::Display for RobotState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RobotState::Idle => write!(f, "idle"),
            RobotState::Listening => write!(f, "listening"),
            RobotState::Thinking => write!(f, "thinking"),
            RobotState::Speaking => write!(f, "speaking"),
            RobotState::Error => write!(f, "error"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RobotEmotion {
    #[default]
    Neutral,
    Happy,
    Sad,
    Angry,
    Surprised,
    Curious,
    Confused,
    Sleepy,
    Thinking,
    Listening,
    Speaking,
    Error,
}

impl std::fmt::Display for RobotEmotion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RobotEmotion::Neutral => write!(f, "neutral"),
            RobotEmotion::Happy => write!(f, "happy"),
            RobotEmotion::Sad => write!(f, "sad"),
            RobotEmotion::Angry => write!(f, "angry"),
            RobotEmotion::Surprised => write!(f, "surprised"),
            RobotEmotion::Curious => write!(f, "curious"),
            RobotEmotion::Confused => write!(f, "confused"),
            RobotEmotion::Sleepy => write!(f, "sleepy"),
            RobotEmotion::Thinking => write!(f, "thinking"),
            RobotEmotion::Listening => write!(f, "listening"),
            RobotEmotion::Speaking => write!(f, "speaking"),
            RobotEmotion::Error => write!(f, "error"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum GazeDirection {
    #[default]
    Center,
    Up,
    Down,
    Left,
    Right,
    UpLeft,
    UpRight,
    DownLeft,
    DownRight,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionState {
    pub state: RobotState,
    pub emotion: RobotEmotion,
    pub intensity: f32,
    pub gaze: GazeDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

impl Default for EmotionState {
    fn default() -> Self {
        Self {
            state: RobotState::Idle,
            emotion: RobotEmotion::Neutral,
            intensity: 0.6,
            gaze: GazeDirection::Center,
            action: None,
        }
    }
}
