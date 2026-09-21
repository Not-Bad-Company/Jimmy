use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::robot::emotion::RobotEmotion;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emotion: Option<RobotEmotion>,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ConversationStore {
    messages: Arc<RwLock<Vec<ChatMessage>>>,
    max_history: usize,
}

impl ConversationStore {
    pub fn new(max_history: usize) -> Self {
        Self {
            messages: Arc::new(RwLock::new(Vec::new())),
            max_history,
        }
    }

    pub async fn add_message(
        &self,
        role: &str,
        content: &str,
        emotion: Option<RobotEmotion>,
    ) -> ChatMessage {
        let mut list = self.messages.write().await;
        let msg = ChatMessage {
            id: Uuid::new_v4().to_string(),
            role: role.to_string(),
            content: content.to_string(),
            emotion,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        };
        list.push(msg.clone());

        // Keep recent context within limit
        if list.len() > self.max_history {
            let overflow = list.len() - self.max_history;
            list.drain(0..overflow);
        }

        msg
    }

    pub async fn get_messages(&self) -> Vec<ChatMessage> {
        self.messages.read().await.clone()
    }

    pub async fn get_recent_messages(&self, limit: usize) -> Vec<ChatMessage> {
        let list = self.messages.read().await;
        if list.len() <= limit {
            list.clone()
        } else {
            list[list.len() - limit..].to_vec()
        }
    }

    pub async fn clear(&self) {
        self.messages.write().await.clear();
    }
}
