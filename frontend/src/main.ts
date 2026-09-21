import './style.css';
import { RoboEyes } from './face/robo_eyes';
import { FaceRenderer } from './face/renderer';
import { AnimationController, EmotionController } from './face/animation';
import { RobotConnection } from './state/connection';
import { TranscriptManager } from './chat/transcript';
import { AudioRecorder } from './audio/recorder';
import { AudioPlayer } from './audio/player';
import { EmotionState, RobotEmotion, SegmentTiming } from './face/types';

document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Face Engine
  const canvas = document.getElementById('faceCanvas') as HTMLCanvasElement;
  const faceStage = document.getElementById('faceStage') as HTMLElement;
  const eyes = new RoboEyes();
  const renderer = new FaceRenderer(canvas, eyes);
  const emotionCtrl = new EmotionController(eyes);
  const animCtrl = new AnimationController(renderer, eyes);

  // 2. Initialize Audio & Subsystems
  const connection = new RobotConnection();
  const rawLogEl = document.getElementById('rawLog') as HTMLElement;
  const transcript = new TranscriptManager(rawLogEl);
  transcript.clear(); // renders the initial "no activity yet" empty state
  const recorder = new AudioRecorder();
  const player = new AudioPlayer();

  // Drive the speaking eye pulse from real playback loudness instead of a
  // fixed sine wave (see face/animation.ts + audio/player.ts for why).
  animCtrl.setAmplitudeSource(() => player.getAmplitude());
  animCtrl.start();

  // 3. UI Elements
  const sidebar = document.getElementById('sidebar') as HTMLElement;
  const btnToggleSidebar = document.getElementById('btnToggleSidebar') as HTMLButtonElement;
  const btnOpenSidebar = document.getElementById('btnOpenSidebar') as HTMLButtonElement;
  const btnClearTranscript = document.getElementById('btnClearTranscript') as HTMLButtonElement;
  const btnToggleDebug = document.getElementById('btnToggleDebug') as HTMLButtonElement;
  const listeningIndicator = document.getElementById('listeningIndicator') as HTMLElement;

  const statState = document.getElementById('statState') as HTMLElement;
  const statEmotion = document.getElementById('statEmotion') as HTMLElement;
  const statLatency = document.getElementById('statLatency') as HTMLElement;

  const devTextInput = document.getElementById('devTextInput') as HTMLElement;
  const cliInput = document.getElementById('cliInput') as HTMLInputElement;

  // 4. Sidebar Toggle Logic
  const urlParams = new URLSearchParams(window.location.search);
  const initialSidebar = urlParams.get('sidebar');
  const storedSidebar = localStorage.getItem('jimmy_sidebar');

  if (initialSidebar === '0' || initialSidebar === 'false' || storedSidebar === 'collapsed') {
    sidebar.classList.add('collapsed');
  }

  function toggleSidebar(forceState?: boolean) {
    const isCollapsed = sidebar.classList.contains('collapsed');
    const shouldCollapse = forceState !== undefined ? forceState : !isCollapsed;
    if (shouldCollapse) {
      sidebar.classList.add('collapsed');
      localStorage.setItem('jimmy_sidebar', 'collapsed');
    } else {
      sidebar.classList.remove('collapsed');
      localStorage.setItem('jimmy_sidebar', 'open');
    }
    // Trigger canvas resize after transition
    setTimeout(() => {
      renderer.handleResize();
    }, 260);
  }

  btnToggleSidebar.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar(true);
  });

  btnOpenSidebar.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar(false);
  });

  btnClearTranscript.addEventListener('click', async (e) => {
    e.stopPropagation();
    transcript.clear();
    await fetch('/api/conversation/clear', { method: 'POST' }).catch(() => {});
  });

  // Debug log visibility (latency/system lines) — hidden by default so the
  // log reads as a clean conversation transcript; toggle to see internals.
  let showDebugLogs = localStorage.getItem('jimmy_debug_logs') === '1';
  transcript.setShowSystemLogs(showDebugLogs);
  btnToggleDebug.classList.toggle('active', showDebugLogs);

  btnToggleDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    showDebugLogs = !showDebugLogs;
    transcript.setShowSystemLogs(showDebugLogs);
    btnToggleDebug.classList.toggle('active', showDebugLogs);
    localStorage.setItem('jimmy_debug_logs', showDebugLogs ? '1' : '0');
  });

  // 5. State Synchronization
  function updateUIState(state: EmotionState) {
    if (statState) statState.textContent = `STATE: ${state.state.toUpperCase()}`;
    if (statEmotion) statEmotion.textContent = `EMO: ${state.emotion.toUpperCase()}`;
    emotionCtrl.applyState(state);
  }

  connection.onStateChange = (state) => {
    updateUIState(state);
  };

  // Tokens arrive as raw structured-JSON fragments (the LLM speaks JSON, not
  // plain text), so they are not human-readable mid-stream. Don't render them
  // live; finalizeStreaming() below swaps in the clean parsed text once done.
  connection.onToken = (_token) => {};

  connection.onEvent = (event) => {
    if (event.event_type === 'transcription' && event.text) {
      transcript.addMessage('user', event.text);
      transcript.startStreamingAssistant();
    } else if (event.event_type === 'response_complete') {
      if (event.text) {
        transcript.finalizeStreaming(event.text, event.emotion_state.emotion);
      }
      if (event.latency) {
        statLatency.textContent = `LATENCY: ${event.latency.total_pipeline_ms}ms`;
        transcript.addSystemLog(
          `latency: stt=${event.latency.stt_latency_ms}ms | first_token=${event.latency.llm_first_token_ms}ms | llm_total=${event.latency.llm_total_ms}ms | tts=${event.latency.tts_latency_ms}ms | total=${event.latency.total_pipeline_ms}ms`
        );
      }
    }
  };

  connection.connect();

  // 6. Audio Playback Event Handlers
  player.onPlaybackStart = () => {
    emotionCtrl.forceState('speaking');
    statState.textContent = 'STATE: SPEAKING';
  };

  player.onPlaybackEnd = () => {
    animCtrl.clearSegmentSchedule();
    emotionCtrl.forceState('idle');
    statState.textContent = 'STATE: IDLE';
    connection.notifySpeechFinished();
  };

  /** Arms the per-segment emotion schedule for a reply that's about to
   * play, so the eyes switch emotion in sync with which part of the (single
   * concatenated) audio file is actually playing. No-op if the backend sent
   * no segment timing (e.g. TTS synthesis failed but text still came back). */
  function armSegmentSchedule(segments: SegmentTiming[] | undefined) {
    if (!segments || segments.length === 0) return;
    animCtrl.setSegmentSchedule(
      segments,
      () => player.getCurrentTimeMs(),
      (seg) => {
        emotionCtrl.applySegmentEmotion(seg.emotion, seg.intensity);
        statEmotion.textContent = `EMO: ${seg.emotion.toUpperCase()}`;
      }
    );
  }

  // 7. Push-To-Talk Voice Flow (Click or Spacebar)
  let isRecording = false;
  // Separate from isRecording: covers the window between stopRecording()
  // (recording ends, isRecording already false) and the /api/voice-turn
  // response coming back. Without this, a fast double-tap of Space/click
  // during that window starts a SECOND recording while the first request
  // is still in flight, firing two overlapping requests against the
  // backend's single global robot state machine — observed in practice as
  // a "Voice turn failed: Bad Request" (the second request's state
  // transition gets rejected because the first one is still Thinking).
  let isProcessing = false;

  async function startRecording() {
    if (isRecording || isProcessing) return;
    const ok = await recorder.start();
    if (ok) {
      isRecording = true;
      listeningIndicator.classList.add('active');
      emotionCtrl.forceState('listening');
      statState.textContent = 'STATE: LISTENING';
      statEmotion.textContent = 'EMO: LISTENING';
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    listeningIndicator.classList.remove('active');
    recorder.stop();
  }

  recorder.onRecordingStop = async (audioBlob) => {
    isProcessing = true;
    emotionCtrl.forceState('thinking');
    statState.textContent = 'STATE: THINKING';
    statEmotion.textContent = 'EMO: THINKING';

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
        statLatency.textContent = `LATENCY: ${data.latency.total_pipeline_ms}ms`;
        transcript.addSystemLog(
          `voice-turn latency: stt=${data.latency.stt_latency_ms}ms | llm=${data.latency.llm_total_ms}ms | tts=${data.latency.tts_latency_ms}ms | total=${data.latency.total_pipeline_ms}ms`
        );
      }

      // Release the lock here, once the backend round trip is done — this
      // is the window that mattered for the concurrent-request bug. Audio
      // playback happening after this is fine to interrupt via a new
      // recording (barge-in).
      isProcessing = false;

      if (data.audio_base64) {
        armSegmentSchedule(data.segments);
        await player.playBase64(data.audio_base64);
      } else {
        emotionCtrl.forceState('idle');
        statState.textContent = 'STATE: IDLE';
      }
    } catch (err: any) {
      console.error('Voice turn error:', err);
      transcript.addSystemLog(`ERROR: ${err.message}`);
      isProcessing = false;
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
    console.error('Audio recorder error:', err);
    transcript.addSystemLog(`MIC ERROR: ${err.message}`);
    stopRecording();
  };

  // Face click to toggle or hold to record
  faceStage.addEventListener('mousedown', (e) => {
    // Ignore clicks on developer input
    if ((e.target as HTMLElement).closest('.dev-text-input')) return;
    startRecording();
  });

  window.addEventListener('mouseup', () => {
    if (isRecording) {
      stopRecording();
    }
  });

  // Touch screen support
  faceStage.addEventListener('touchstart', (e) => {
    if ((e.target as HTMLElement).closest('.dev-text-input')) return;
    e.preventDefault();
    startRecording();
  });

  window.addEventListener('touchend', () => {
    if (isRecording) {
      stopRecording();
    }
  });

  // 8. Developer Text Input (Toggled with 'T')
  async function submitTextInput() {
    const text = cliInput.value.trim();
    if (!text) return;

    cliInput.value = '';
    devTextInput.classList.add('hidden');

    transcript.addMessage('user', text);
    transcript.startStreamingAssistant();

    emotionCtrl.forceState('thinking');
    statState.textContent = 'STATE: THINKING';
    statEmotion.textContent = 'EMO: THINKING';

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
        statLatency.textContent = `LATENCY: ${data.latency.total_pipeline_ms}ms`;
        transcript.addSystemLog(
          `chat latency: first_token=${data.latency.llm_first_token_ms}ms | llm_total=${data.latency.llm_total_ms}ms | tts=${data.latency.tts_latency_ms}ms | total=${data.latency.total_pipeline_ms}ms`
        );
      }

      // Stage the FIRST segment's emotion/gaze now (not the overall/last
      // one — that's what should be showing the instant speech starts),
      // but don't flip eyes.speaking on until playback actually starts
      // (player.onPlaybackStart below handles that) — otherwise the eyes
      // visibly start "talking" before any audio decode/playback has
      // actually begun.
      const firstSegment = data.segments?.[0];
      emotionCtrl.stageEmotion(
        firstSegment?.emotion ?? data.emotion,
        firstSegment?.intensity ?? data.intensity,
        data.gaze
      );

      if (data.audio_base64) {
        armSegmentSchedule(data.segments);
        await player.playBase64(data.audio_base64);
      } else {
        emotionCtrl.forceState('idle');
        statState.textContent = 'STATE: IDLE';
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      transcript.addSystemLog(`ERROR: ${err.message}`);
      emotionCtrl.applyState({
        state: 'error',
        emotion: 'error',
        intensity: 0.8,
        gaze: 'center',
      });
      setTimeout(() => emotionCtrl.forceState('idle'), 2500);
    }
  }

  cliInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitTextInput();
    } else if (e.key === 'Escape') {
      devTextInput.classList.add('hidden');
      cliInput.value = '';
    }
  });

  // 9. Keyboard Controls (Space = PTT, D = Sidebar, T = Text, 1-9 = Emotions)
  let spaceHeld = false;

  window.addEventListener('keydown', (e) => {
    // If typing in input, only Escape or Enter matters
    if (document.activeElement === cliInput) {
      return;
    }

    if (e.code === 'Space' && !spaceHeld) {
      e.preventDefault();
      spaceHeld = true;
      startRecording();
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      devTextInput.classList.toggle('hidden');
      if (!devTextInput.classList.contains('hidden')) {
        cliInput.focus();
      }
    } else if (e.key === '0') {
      emotionCtrl.triggerBlink();
    } else if (e.key >= '1' && e.key <= '9') {
      const emoMap: Record<string, RobotEmotion> = {
        '1': 'neutral',
        '2': 'happy',
        '3': 'curious',
        '4': 'thinking',
        '5': 'angry',
        '6': 'confused',
        '7': 'sad',
        '8': 'surprised',
        '9': 'sleepy',
      };
      const emo = emoMap[e.key];
      if (emo) {
        emotionCtrl.forceEmotion(emo, 0.8, 'center');
        transcript.addSystemLog(`Manual emotion override: ${emo.toUpperCase()}`);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      spaceHeld = false;
      stopRecording();
    }
  });

  // Initial load of existing conversation
  fetch('/api/conversation')
    .then((r) => r.json())
    .then((msgs: any[]) => {
      for (const m of msgs) {
        transcript.addMessage(m.role, m.content, m.emotion);
      }
    })
    .catch(() => {});

  // Expose for developer testing & programmatic control
  (window as any).jimmy = {
    emotionCtrl,
    eyes,
    renderer,
    transcript,
    recorder,
    player,
    toggleSidebar,
  };
});
