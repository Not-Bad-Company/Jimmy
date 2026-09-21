/**
 * AnimationController and EmotionController:
 * Bridge high-level semantic robot state into RoboEyes operations.
 */

import { EmotionState, GazeDirection, RobotEmotion, RobotState } from './types';
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
  private isRunning = false;
  private animFrameId: number | null = null;

  constructor(renderer: FaceRenderer) {
    this.renderer = renderer;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = (now: number) => {
      if (!this.isRunning) return;
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
