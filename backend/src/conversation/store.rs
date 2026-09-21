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
    /// If more than this many minutes pass between messages, the next
    /// add_message() starts a fresh session (drops prior history) instead
    /// of treating a stale, possibly unrelated conversation as still live.
    /// None disables session boundaries entirely (old behavior: a single
    /// ever-sliding window with no time-based reset).
    session_idle_timeout_minutes: Option<i64>,
}

impl ConversationStore {
    pub fn new(max_history: usize) -> Self {
        Self {
            messages: Arc::new(RwLock::new(Vec::new())),
            max_history,
            session_idle_timeout_minutes: None,
        }
    }

    pub fn with_session_timeout(mut self, minutes: i64) -> Self {
        self.session_idle_timeout_minutes = Some(minutes);
        self
    }

    /// Returns true if this call started a fresh session (prior history was
    /// dropped due to the idle gap), so callers can log/surface it.
    pub async fn add_message(
        &self,
        role: &str,
        content: &str,
        emotion: Option<RobotEmotion>,
    ) -> (ChatMessage, bool) {
        let mut list = self.messages.write().await;

        let mut started_new_session = false;
        if let (Some(timeout_min), Some(last)) =
            (self.session_idle_timeout_minutes, list.last())
        {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let gap_ms = now_ms - last.timestamp_ms;
            if gap_ms > timeout_min * 60_000 {
                list.clear();
                started_new_session = true;
            }
        }

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

        (msg, started_new_session)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_session_reset_within_idle_window() {
        let store = ConversationStore::new(30).with_session_timeout(20);
        store.add_message("user", "Hello", None).await;
        let (_, started_new) = store.add_message("user", "Still here", None).await;
        assert!(!started_new);
        assert_eq!(store.get_messages().await.len(), 2);
    }

    #[tokio::test]
    async fn session_resets_after_idle_timeout_exceeded() {
        let store = ConversationStore::new(30).with_session_timeout(20);
        {
            // Directly seed a message far enough in the past to simulate an
            // idle gap without actually sleeping in the test.
            let mut list = store.messages.write().await;
            list.push(ChatMessage {
                id: "seed".to_string(),
                role: "user".to_string(),
                content: "Old conversation".to_string(),
                emotion: None,
                timestamp_ms: chrono::Utc::now().timestamp_millis() - 30 * 60_000,
            });
        }

        let (_, started_new) = store.add_message("user", "New conversation", None).await;
        assert!(started_new);

        let msgs = store.get_messages().await;
        assert_eq!(msgs.len(), 1, "old history must be dropped on session reset");
        assert_eq!(msgs[0].content, "New conversation");
    }

    #[tokio::test]
    async fn no_session_timeout_configured_never_resets() {
        let store = ConversationStore::new(30); // no .with_session_timeout()
        {
            let mut list = store.messages.write().await;
            list.push(ChatMessage {
                id: "seed".to_string(),
                role: "user".to_string(),
                content: "Very old".to_string(),
                emotion: None,
                timestamp_ms: 0, // effectively decades ago
            });
        }
        let (_, started_new) = store.add_message("user", "New message", None).await;
        assert!(!started_new);
        assert_eq!(store.get_messages().await.len(), 2);
    }
}
