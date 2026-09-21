import './style.css';
import { RoboEyes } from './face/robo_eyes';
import { FaceRenderer } from './face/renderer';
import { AnimationController, EmotionController } from './face/animation';
import { RobotConnection } from './state/connection';
import { TranscriptManager } from './chat/transcript';
import { AudioRecorder } from './audio/recorder';
import { AudioPlayer } from './audio/player';
import { EmotionState, GazeDirection, RobotEmotion } from './face/types';

document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Face Engine
  const canvas = document.getElementById('faceCanvas') as HTMLCanvasElement;
  const eyes = new RoboEyes();
  const renderer = new FaceRenderer(canvas, eyes);
  const emotionCtrl = new EmotionController(eyes);
  const animCtrl = new AnimationController(renderer);
  animCtrl.start();

  // 2. Initialize Subsystems
  const connection = new RobotConnection();
  const transcriptEl = document.getElementById('transcriptScroll') as HTMLElement;
  const transcript = new TranscriptManager(transcriptEl);
  const recorder = new AudioRecorder();
  const player = new AudioPlayer();

  // 3. UI Elements
  const stateLabel = document.getElementById('stateLabel') as HTMLElement;
  const emotionLabel = document.getElementById('emotionLabel') as HTMLElement;
  const connectionDot = document.getElementById('connectionDot') as HTMLElement;
  const connectionText = document.getElementById('connectionText') as HTMLElement;
  const tokenCountLabel = document.getElementById('tokenCountLabel') as HTMLElement;
  const btnMic = document.getElementById('btnMic') as HTMLButtonElement;
  const micLabel = document.getElementById('micLabel') as HTMLElement;
  const chatForm = document.getElementById('chatForm') as HTMLFormElement;
  const chatInput = document.getElementById('chatInput') as HTMLInputElement;
  const devToggle = document.getElementById('devToggle') as HTMLButtonElement;
  const devPanel = document.getElementById('devPanel') as HTMLElement;

  // Latency Metrics
  const metricStt = document.getElementById('metricStt') as HTMLElement;
  const metricFirstToken = document.getElementById('metricFirstToken') as HTMLElement;
  const metricLlmTotal = document.getElementById('metricLlmTotal') as HTMLElement;
  const metricTts = document.getElementById('metricTts') as HTMLElement;
  const metricTotal = document.getElementById('metricTotal') as HTMLElement;
  const metricModel = document.getElementById('metricModel') as HTMLElement;

  let totalTokensGenerated = 0;

  // 4. Bind State Changes
  function updateUIState(state: EmotionState) {
    stateLabel.textContent = state.state.toUpperCase();
    emotionLabel.textContent = state.emotion.toUpperCase();
    emotionCtrl.applyState(state);
  }

  connection.onStatusChange = (status) => {
    connectionDot.className = `status-dot ${status}`;
    connectionText.textContent = status.toUpperCase();
  };

  connection.onStateChange = (state) => {
    updateUIState(state);
  };

  connection.onToken = (token) => {
    transcript.appendStreamToken(token);
  };

  connection.onEvent = (event) => {
    if (event.event_type === 'transcription' && event.text) {
      transcript.addMessage('user', event.text);
      transcript.startStreamingAssistant();
    } else if (event.event_type === 'response_complete') {
      if (event.text) {
        transcript.finalizeStreaming(event.text, event.emotion_state.emotion);
      }
      if (event.latency) {
        metricStt.textContent = `${event.latency.stt_latency_ms} ms`;
        metricFirstToken.textContent = `${event.latency.llm_first_token_ms} ms`;
        metricLlmTotal.textContent = `${event.latency.llm_total_ms} ms`;
        metricTts.textContent = `${event.latency.tts_latency_ms} ms`;
        metricTotal.textContent = `${event.latency.total_pipeline_ms} ms`;
        totalTokensGenerated += event.latency.tokens_generated;
        tokenCountLabel.textContent = `${totalTokensGenerated} TOKENS`;
      }
    }
  };

  connection.connect();

  // 5. Audio Playback Event Handlers
  player.onPlaybackStart = () => {
    emotionCtrl.forceState('speaking');
    stateLabel.textContent = 'SPEAKING';
  };

  player.onPlaybackEnd = () => {
    emotionCtrl.forceState('idle');
    stateLabel.textContent = 'IDLE';
    connection.notifySpeechFinished();
  };

  // 6. Voice Recording Flow (Push-to-Talk)
  let isRecording = false;

  async function startRecording() {
    if (isRecording) return;
    const ok = await recorder.start();
    if (ok) {
      isRecording = true;
      btnMic.classList.add('recording');
      micLabel.textContent = 'LISTENING...';
      connection.forceState('listening');
      stateLabel.textContent = 'LISTENING';
      emotionLabel.textContent = 'LISTENING';
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    btnMic.classList.remove('recording');
    micLabel.textContent = 'PUSH TO TALK';
    recorder.stop();
  }

  recorder.onRecordingStop = async (audioBlob) => {
    emotionCtrl.forceState('thinking');
    stateLabel.textContent = 'THINKING';
    emotionLabel.textContent = 'THINKING';

    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    try {
      const response = await fetch('/api/voice-turn', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Voice turn failed: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.latency) {
        metricStt.textContent = `${data.latency.stt_latency_ms} ms`;
        metricFirstToken.textContent = `${data.latency.llm_first_token_ms} ms`;
        metricLlmTotal.textContent = `${data.latency.llm_total_ms} ms`;
        metricTts.textContent = `${data.latency.tts_latency_ms} ms`;
        metricTotal.textContent = `${data.latency.total_pipeline_ms} ms`;
        totalTokensGenerated += data.latency.tokens_generated;
        tokenCountLabel.textContent = `${totalTokensGenerated} TOKENS`;
      }

      if (data.audio_base64) {
        await player.playBase64(data.audio_base64);
      } else {
        emotionCtrl.forceState('idle');
        stateLabel.textContent = 'IDLE';
      }
    } catch (err: any) {
      console.error('Voice turn error:', err);
      emotionCtrl.applyState({
        state: 'error',
        emotion: 'error',
        intensity: 0.8,
        gaze: 'center',
      });
      setTimeout(() => emotionCtrl.forceState('idle'), 2500);
    }
  };

  recorder.onError = (err) => {
    console.error('Microphone recorder error:', err);
    stopRecording();
    alert(`Microphone error: ${err.message}`);
  };

  // PTT Button interactions
  btnMic.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startRecording();
  });
  window.addEventListener('mouseup', () => {
    if (isRecording) {
      stopRecording();
    }
  });

  // Touch support for mobile / touchpads
  btnMic.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startRecording();
  });
  window.addEventListener('touchend', () => {
    if (isRecording) {
      stopRecording();
    }
  });

  // 7. Text Chat Form (Fallback)
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    chatInput.value = '';
    transcript.addMessage('user', text);
    transcript.startStreamingAssistant();

    emotionCtrl.forceState('thinking');
    stateLabel.textContent = 'THINKING';
    emotionLabel.textContent = 'THINKING';

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, synthesize_audio: true }),
      });

      if (!resp.ok) {
        throw new Error(`Chat error: ${resp.statusText}`);
      }

      const data = await resp.json();
      transcript.finalizeStreaming(data.message, data.emotion);

      if (data.latency) {
        metricFirstToken.textContent = `${data.latency.llm_first_token_ms} ms`;
        metricLlmTotal.textContent = `${data.latency.llm_total_ms} ms`;
        metricTts.textContent = `${data.latency.tts_latency_ms} ms`;
        metricTotal.textContent = `${data.latency.total_pipeline_ms} ms`;
        totalTokensGenerated += data.latency.tokens_generated;
        tokenCountLabel.textContent = `${totalTokensGenerated} TOKENS`;
      }

      emotionCtrl.applyState({
        state: 'speaking',
        emotion: data.emotion,
        intensity: data.intensity,
        gaze: data.gaze,
      });

      if (data.audio_base64) {
        await player.playBase64(data.audio_base64);
      } else {
        setTimeout(() => {
          emotionCtrl.forceState('idle');
          stateLabel.textContent = 'IDLE';
        }, 1500);
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      emotionCtrl.applyState({
        state: 'error',
        emotion: 'error',
        intensity: 0.8,
        gaze: 'center',
      });
      setTimeout(() => emotionCtrl.forceState('idle'), 2500);
    }
  });

  // 8. Developer Panel & Manual Controls
  devToggle.addEventListener('click', () => {
    devPanel.classList.toggle('open');
  });

  document.querySelectorAll('.btn-dev[data-emotion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emo = (btn as HTMLElement).dataset.emotion as RobotEmotion;
      connection.forceEmotion(emo, 0.8, 'center');
    });
  });

  document.querySelectorAll('.btn-dev[data-gaze]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gaze = (btn as HTMLElement).dataset.gaze as GazeDirection;
      connection.forceGaze(gaze);
    });
  });

  document.getElementById('btnDevBlink')?.addEventListener('click', () => {
    emotionCtrl.triggerBlink();
  });

  document.getElementById('btnClearChat')?.addEventListener('click', async () => {
    transcript.clear();
    await fetch('/api/conversation/clear', { method: 'POST' });
  });

  // Fetch initial config and messages for developer panel and transcript
  fetch('/api/status')
    .then((r) => r.json())
    .then((d) => {
      if (d.config?.llm_model) {
        metricModel.textContent = d.config.llm_model;
      }
    })
    .catch(() => {});

  fetch('/api/conversation')
    .then((r) => r.json())
    .then((msgs: any[]) => {
      for (const m of msgs) {
        transcript.addMessage(m.role, m.content, m.emotion);
      }
    })
    .catch(() => {});
});
