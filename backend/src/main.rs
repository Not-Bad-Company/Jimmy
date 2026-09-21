use axum::{
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use std::path::Path;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod ai;
mod api;
mod config;
mod conversation;
mod robot;
mod state;

use api::{
    chat_handler, clear_conversation_handler, get_conversation_handler, get_status_handler,
    health_handler, list_voices_handler, override_handler, synthesize_handler, voice_turn_handler,
    ws_handler,
};
use config::AppConfig;
use state::AppState;

const DEFAULT_PROMPT: &str = r#"
You are Jimmy, a small, highly intelligent robotic companion.
Speak in concise, simplified English with unusual phrasing.
Be technically capable, direct, and pragmatic.
Output JSON: {"response": "Spoken text.", "emotion": "happy", "intensity": 0.7, "gaze": "center"}
"#;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,jimmy_backend=debug,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    let config = AppConfig::from_env();
    info!("Starting Jimmy Backend on {}:{}", config.host, config.port);
    info!(
        "LLM Provider: {} (Model: {})",
        config.llm_provider, config.llm_model
    );
    info!(
        "STT Provider: {} (Model: {})",
        config.stt_provider, config.stt_model
    );
    info!(
        "TTS Provider: {} (Voice: {})",
        config.tts_provider, config.tts_voice
    );

    // Load personality prompt from file or fallback (try jimmy.md, then rocky.md)
    let prompt_paths = [
        Path::new("prompts/jimmy.md"),
        Path::new("../prompts/jimmy.md"),
        Path::new("prompts/rocky.md"),
        Path::new("../prompts/rocky.md"),
    ];

    let mut system_prompt = DEFAULT_PROMPT.to_string();
    for p in &prompt_paths {
        if p.exists() {
            if let Ok(content) = std::fs::read_to_string(p) {
                info!("Loaded personality prompt from {:?}", p);
                system_prompt = content;
                break;
            }
        }
    }

    let app_state = AppState::new(config.clone(), system_prompt);

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build Axum API routes
    let api_routes = Router::new()
        .route("/health", get(health_handler))
        .route("/api/status", get(get_status_handler))
        .route("/api/conversation", get(get_conversation_handler))
        .route("/api/conversation/clear", post(clear_conversation_handler))
        .route("/api/chat", post(chat_handler))
        .route("/api/voice-turn", post(voice_turn_handler))
        .route("/api/synthesize", post(synthesize_handler))
        .route("/api/voices", get(list_voices_handler))
        .route("/api/robot/override", post(override_handler))
        .route("/ws", get(ws_handler));

    // Serve static files from frontend/dist if built, otherwise just fallback
    let frontend_dist = Path::new("frontend/dist");
    let fallback_dist = Path::new("../frontend/dist");
    let dist_path = if frontend_dist.exists() {
        Some(frontend_dist)
    } else if fallback_dist.exists() {
        Some(fallback_dist)
    } else {
        None
    };

    let app = if let Some(path) = dist_path {
        info!("Serving frontend static files from {:?}", path);
        api_routes.fallback_service(ServeDir::new(path))
    } else {
        info!("Frontend dist not found; API only mode");
        api_routes
    }
    .layer(cors)
    .layer(TraceLayer::new_for_http())
    .with_state(app_state);

    // Bind to requested port, or find next available port gracefully if in use
    let mut current_port = config.port;
    let max_port = config.port + 50;
    let listener = loop {
        let addr: SocketAddr = format!("{}:{}", config.host, current_port).parse()?;
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                if current_port != config.port {
                    info!(
                        "Notice: Port {} was already in use. Automatically switched to port {}.",
                        config.port, current_port
                    );
                }
                break l;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && current_port < max_port => {
                info!("Port {} in use, trying port {}...", current_port, current_port + 1);
                current_port += 1;
            }
            Err(e) => {
                error!("Failed to bind to {}:{}: {}", config.host, current_port, e);
                return Err(e.into());
            }
        }
    };

    let local_addr = listener.local_addr()?;
    info!("Jimmy backend listening on http://{}", local_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Jimmy backend shutdown complete.");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("Termination signal received, shutting down gracefully...");
}
