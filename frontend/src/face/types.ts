export type RobotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export type RobotEmotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'curious'
  | 'confused'
  | 'sleepy'
  | 'thinking'
  | 'listening'
  | 'speaking'
  | 'error';

export type GazeDirection =
  | 'center'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'up-left'
  | 'up-right'
  | 'down-left'
  | 'down-right';

export interface EmotionState {
  state: RobotState;
  emotion: RobotEmotion;
  intensity: number;
  gaze: GazeDirection;
  action?: string;
}

export interface LatencyMetrics {
  stt_latency_ms: number;
  llm_first_token_ms: number;
  llm_total_ms: number;
  tts_latency_ms: number;
  total_pipeline_ms: number;
  tokens_generated: number;
}

export interface RobotEvent {
  event_type: string;
  timestamp_ms: number;
  emotion_state: EmotionState;
  text?: string;
  audio_url?: string;
  latency?: LatencyMetrics;
}
