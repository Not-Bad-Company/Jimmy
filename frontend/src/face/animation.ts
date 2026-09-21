/**
 * AnimationController and EmotionController:
 * Bridge high-level semantic robot state into RoboEyes operations.
 */

import { EmotionState, GazeDirection, RobotEmotion, RobotState, SegmentTiming } from './types';
import { RoboEyes } from './robo_eyes';
import { FaceRenderer } from './renderer';

export class EmotionController {
  private eyes: RoboEyes;
  private currentState: EmotionState;

  constructor(eyes: RoboEyes) {
    this.eyes = eyes;
    this.currentState = {
      state: 'idle',
      emotion: 'neutral',
      intensity: 0.6,
      gaze: 'center',
    };
  }

  /**
   * Stage the target emotion/gaze (e.g. once a chat response arrives) WITHOUT
   * flipping eyes.speaking on yet. Audio decode/playback-start still has to
   * happen after this point, and eyes.speaking driving the pulse animation
   * before real audio is actually playing was reported as a visible desync
   * ("eyes start animating just before the TTS starts"). Call forceState()
   * with 'speaking' from the real playback-start event instead, once
   * currentState has already been staged here.
   */
  stageEmotion(emotion: RobotEmotion, intensity: number, gaze: GazeDirection) {
    this.currentState = { ...this.currentState, emotion, intensity, gaze };
    this.eyes.setPosition(gaze);
    this.eyes.setEmotion(emotion, intensity);
  }

  /**
   * Switch emotion mid-speech (one reply segment ending, the next one's
   * emotion starting) without resetting gaze (fixed once per reply, not
   * per-segment) and without breaking the speaking pulse. `eyes.setEmotion`
   * unconditionally clears `eyes.speaking` as part of resetting all mood
   * flags — that's correct for a normal state change, but wrong here since
   * we're still mid-utterance; restore it right after.
   */
  applySegmentEmotion(emotion: RobotEmotion, intensity: number) {
    this.currentState = { ...this.currentState, emotion, intensity };
    this.eyes.setEmotion(emotion, intensity);
    this.eyes.speaking = true;
  }

  applyState(newState: EmotionState) {
    this.currentState = { ...newState };

    // Apply gaze
    this.eyes.setPosition(newState.gaze);

    // Apply emotion
    this.eyes.setEmotion(newState.emotion, newState.intensity);

    // Handle robot operational states
    switch (newState.state) {
      case 'listening':
        this.eyes.speaking = false;
        this.eyes.thinking = false;
        this.eyes.setPosition('center');
        break;
      case 'thinking':
        this.eyes.thinking = true;
        this.eyes.speaking = false;
        this.eyes.setPosition('up');
        break;
      case 'speaking':
        this.eyes.speaking = true;
        this.eyes.thinking = false;
        break;
      case 'error':
        this.eyes.speaking = false;
        this.eyes.thinking = false;
        this.eyes.setEmotion('error', 0.9);
        break;
      case 'idle':
      default:
        this.eyes.speaking = false;
        this.eyes.thinking = false;
        break;
    }
  }

  forceEmotion(emotion: RobotEmotion, intensity: number = 0.7, gaze: GazeDirection = 'center') {
    this.applyState({
      state: 'idle',
      emotion,
      intensity,
      gaze,
    });
  }

  forceState(state: RobotState) {
    this.applyState({
      ...this.currentState,
      state,
    });
  }

  triggerBlink() {
    this.eyes.blink();
  }

  getCurrentState(): EmotionState {
    return { ...this.currentState };
  }
}

export class AnimationController {
  private renderer: FaceRenderer;
  private eyes: RoboEyes;
  private isRunning = false;
  private animFrameId: number | null = null;
  private getAmplitude: (() => number) | null = null;

  // Multi-emotion-per-reply segment scheduling: which part of the current
  // reply's audio is actually playing right now, so the eyes can switch
  // emotion in sync with it instead of only once at the start of playback.
  private segments: SegmentTiming[] = [];
  private activeSegmentIndex = -1;
  private getPlaybackTimeMs: (() => number) | null = null;
  private onSegmentChange: ((seg: SegmentTiming) => void) | null = null;

  constructor(renderer: FaceRenderer, eyes: RoboEyes) {
    this.renderer = renderer;
    this.eyes = eyes;
  }

  /** Called once per frame while speaking so the eye pulse tracks real
   * playback loudness instead of a fixed sine wave with no relation to the
   * actual audio. */
  setAmplitudeSource(getAmplitude: () => number) {
    this.getAmplitude = getAmplitude;
  }

  /** Arms the per-segment emotion schedule for the reply about to play.
   * `getPlaybackTimeMs` should return the current audio position in ms
   * (0 if not yet playing) — segments only advance once eyes.speaking is
   * true, so arming this before playback actually starts is fine. */
  setSegmentSchedule(
    segments: SegmentTiming[],
    getPlaybackTimeMs: () => number,
    onSegmentChange: (seg: SegmentTiming) => void
  ) {
    this.segments = segments;
    this.activeSegmentIndex = -1;
    this.getPlaybackTimeMs = getPlaybackTimeMs;
    this.onSegmentChange = onSegmentChange;
  }

  clearSegmentSchedule() {
    this.segments = [];
    this.activeSegmentIndex = -1;
    this.getPlaybackTimeMs = null;
    this.onSegmentChange = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = (now: number) => {
      if (!this.isRunning) return;
      if (this.eyes.speaking) {
        if (this.getAmplitude) {
          this.eyes.speakingAmplitude = this.getAmplitude();
        }
        if (this.segments.length > 0 && this.getPlaybackTimeMs) {
          const t = this.getPlaybackTimeMs();
          let idx = 0;
          for (let i = 0; i < this.segments.length; i++) {
            if (this.segments[i].start_ms <= t) idx = i;
            else break;
          }
          if (idx !== this.activeSegmentIndex) {
            this.activeSegmentIndex = idx;
            this.onSegmentChange?.(this.segments[idx]);
          }
        }
      }
      this.renderer.render(now);
      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  stop() {
    this.isRunning = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }
}
