use rocky_backend::ai::{
    LLMProvider, MockLLMProvider, MockSTTProvider, MockTTSProvider, STTProvider, TTSProvider,
};
use rocky_backend::conversation::ConversationStore;
use rocky_backend::robot::emotion::{GazeDirection, RobotEmotion, RobotState};
use rocky_backend::robot::RobotStateMachine;

#[tokio::test]
async fn test_robot_state_machine_transitions() {
    let sm = RobotStateMachine::new();
    let initial = sm.get_state().await;
    assert_eq!(initial.state, RobotState::Idle);
    assert_eq!(initial.emotion, RobotEmotion::Neutral);

    // Transition to Listening
    let listening = sm.set_listening().await;
    assert_eq!(listening.state, RobotState::Listening);
    assert_eq!(listening.emotion, RobotEmotion::Listening);

    // Transition to Thinking
    let thinking = sm.set_thinking().await;
    assert_eq!(thinking.state, RobotState::Thinking);
    assert_eq!(thinking.emotion, RobotEmotion::Thinking);

    // Transition to Speaking with custom emotion
    let speaking = sm
        .set_speaking(
            Some(RobotEmotion::Happy),
            Some(0.8),
            Some(GazeDirection::Center),
        )
        .await;
    assert_eq!(speaking.state, RobotState::Speaking);
    assert_eq!(speaking.emotion, RobotEmotion::Happy);
    assert!((speaking.intensity - 0.8).abs() < f32::EPSILON);

    // Return to Idle
    let idle = sm.set_idle().await;
    assert_eq!(idle.state, RobotState::Idle);
    assert_eq!(idle.emotion, RobotEmotion::Neutral);
}

#[tokio::test]
async fn test_conversation_store_and_pruning() {
    let store = ConversationStore::new(3);

    store.add_message("user", "Message 1", None).await;
    store
        .add_message("assistant", "Message 2", Some(RobotEmotion::Happy))
        .await;
    store.add_message("user", "Message 3", None).await;

    let msgs = store.get_messages().await;
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].content, "Message 1");

    // Add 4th message - should prune the first
    store
        .add_message("assistant", "Message 4", Some(RobotEmotion::Curious))
        .await;
    let pruned = store.get_messages().await;
    assert_eq!(pruned.len(), 3);
    assert_eq!(pruned[0].content, "Message 2");
    assert_eq!(pruned[2].content, "Message 4");

    // Test clear
    store.clear().await;
    assert_eq!(store.get_messages().await.len(), 0);
}

#[tokio::test]
async fn test_mock_llm_responses() {
    let mock = MockLLMProvider::new("qwen2.5:3b".to_string());
    assert!(mock.check_health().await);

    // Test "How are you?"
    let res1 = mock
        .generate_response("prompt", &[], "How are you?", None)
        .await
        .unwrap();
    assert_eq!(res1.emotion, RobotEmotion::Happy);
    assert!(res1.text.contains("subsystems nominal"));

    // Test "bad idea"
    let res2 = mock
        .generate_response("prompt", &[], "That was a bad idea", None)
        .await
        .unwrap();
    assert_eq!(res2.emotion, RobotEmotion::Angry);
    assert!(res2.text.contains("Bad idea"));

    // Test "server is broken"
    let res3 = mock
        .generate_response("prompt", &[], "My server is broken", None)
        .await
        .unwrap();
    assert_eq!(res3.emotion, RobotEmotion::Curious);
    assert!(res3.text.contains("Inspect logs"));

    // Test "photosynthesis"
    let res4 = mock
        .generate_response("prompt", &[], "Explain photosynthesis", None)
        .await
        .unwrap();
    assert_eq!(res4.emotion, RobotEmotion::Neutral);
    assert!(res4.text.contains("photons"));
}

#[tokio::test]
async fn test_mock_stt_and_tts() {
    let stt = MockSTTProvider::new("base.en".to_string());
    assert!(stt.check_health().await);
    let stt_res = stt.transcribe(vec![1, 2, 3], "test.wav").await.unwrap();
    assert_eq!(stt_res.text, "Hello Rocky.");
    assert!(stt_res.latency_ms > 0);

    let tts = MockTTSProvider::new("kokoro-v1.0".to_string(), "bm_george".to_string());
    assert!(tts.check_health().await);
    let tts_res = tts.synthesize("Hello Rocky.", None, None).await.unwrap();
    assert!(!tts_res.audio_bytes.is_empty());
    assert_eq!(&tts_res.audio_bytes[0..4], b"RIFF");
    assert_eq!(tts_res.mime_type, "audio/wav");
    assert!(tts_res.latency_ms > 0);
}

#[tokio::test]
async fn test_mock_pipeline_end_to_end() {
    use axum::extract::State;
    use axum::Json;
    use rocky_backend::api::{chat_handler, ChatRequest};
    use rocky_backend::config::AppConfig;
    use rocky_backend::state::AppState;

    let mut cfg = AppConfig::from_env();
    cfg.llm_provider = "mock".to_string();
    cfg.stt_provider = "mock".to_string();
    cfg.tts_provider = "mock".to_string();

    let state = AppState::new(cfg, "Test system prompt".to_string());

    // 1. Initial state is Idle
    assert_eq!(
        state.state_machine.get_state().await.state,
        RobotState::Idle
    );

    // 2. Chat with Rocky in mock mode
    let req = ChatRequest {
        message: "How are you?".to_string(),
        synthesize_audio: Some(true),
        voice: None,
    };

    let res = chat_handler(State(state.clone()), Json(req)).await.unwrap();
    assert!(res.message.contains("subsystems nominal"));
    assert_eq!(res.emotion, RobotEmotion::Happy);
    assert!(res.audio_base64.is_some());
    assert!(res.latency.llm_first_token_ms > 0);
    assert!(res.latency.total_pipeline_ms > 0);

    // 3. State should transition to Speaking
    let cur = state.state_machine.get_state().await;
    assert_eq!(cur.state, RobotState::Speaking);
    assert_eq!(cur.emotion, RobotEmotion::Happy);
}
