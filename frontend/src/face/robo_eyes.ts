/**
 * RoboEyes Engine for HTML5 Canvas
 *
 * Adapted and ported to Canvas 2D from the FluxGarage RoboEyes library
 * Originally created for Arduino/OLED displays:
 * Copyright (C) 2024-2025 Dennis Hoelscher (www.fluxgarage.com)
 * Licensed under the GNU General Public License v3.0 (GPL-3.0)
 *
 * This implementation maintains the canonical 128x64 logical coordinate space
 * and mathematical tweening algorithms of RoboEyes, with extensions for
 * speech animation, thinking gaze patterns, and emotional intensity.
 */

import { GazeDirection, RobotEmotion } from './types';

export class RoboEyes {
  // Screen size (canonical OLED 128x64)
  readonly screenWidth = 128;
  readonly screenHeight = 64;

  // Colors
  bgColor = '#000000';
  mainColor = '#FFFFFF'; // Luminous solid white OLED
  glowColor = 'rgba(255, 255, 255, 0.2)';

  // Mood states
  tired = false;
  angry = false;
  happy = false;
  curious = true; // outer eye expands when looking sideways
  cyclops = false;
  sad = false;

  // Eye left geometry
  eyeLwidthDefault = 36;
  eyeLheightDefault = 36;
  eyeLwidthCurrent = 36;
  eyeLheightCurrent = 36;
  eyeLwidthNext = 36;
  eyeLheightNext = 36;
  eyeLheightOffset = 0;
  eyeLborderRadiusDefault = 8;
  eyeLborderRadiusCurrent = 8;
  eyeLborderRadiusNext = 8;

  // Eye right geometry
  eyeRwidthDefault = 36;
  eyeRheightDefault = 36;
  eyeRwidthCurrent = 36;
  eyeRheightCurrent = 36;
  eyeRwidthNext = 36;
  eyeRheightNext = 36;
  eyeRheightOffset = 0;
  eyeRborderRadiusDefault = 8;
  eyeRborderRadiusCurrent = 8;
  eyeRborderRadiusNext = 8;

  // Coordinates
  spaceBetweenDefault = 10;
  spaceBetweenCurrent = 10;
  spaceBetweenNext = 10;

  eyeLxDefault = Math.floor((128 - (36 + 10 + 36)) / 2); // 23
  eyeLyDefault = Math.floor((64 - 36) / 2); // 14
  eyeLx = this.eyeLxDefault;
  eyeLy = this.eyeLyDefault;
  eyeLxNext = this.eyeLxDefault;
  eyeLyNext = this.eyeLyDefault;

  eyeRxDefault = this.eyeLxDefault + 36 + 10; // 69
  eyeRyDefault = this.eyeLyDefault;
  eyeRx = this.eyeRxDefault;
  eyeRy = this.eyeRyDefault;
  eyeRxNext = this.eyeRxDefault;
  eyeRyNext = this.eyeRyDefault;

  // Eyelids
  eyelidsTiredHeight = 0;
  eyelidsTiredHeightNext = 0;
  eyelidsAngryHeight = 0;
  eyelidsAngryHeightNext = 0;
  eyelidsHappyBottomOffset = 0;
  eyelidsHappyBottomOffsetNext = 0;

  // Blinking
  eyeL_open = true;
  eyeR_open = true;
  autoblinker = true;
  blinkInterval = 2500;
  blinkIntervalVariation = 3000;
  nextBlinkTime = 0;
  pendingDoubleBlink = false;

  // Idle movement (large occasional gaze shifts)
  idle = true;
  idleInterval = 2000;
  idleIntervalVariation = 3000;
  nextIdleTime = 0;

  // Micro-saccades: small frequent jitter layered on top of the current
  // gaze so the face never looks frozen, even between idle repositions.
  microJitterX = 0;
  microJitterY = 0;
  nextMicroJitterTime = 0;
  microJitterInterval = 500;
  microJitterIntervalVariation = 700;

  // Continuous subtle breathing pulse (always-on, independent of the
  // stronger "thinking" pulse), so the eyes never look perfectly static.
  breathingPhase = 0;

  // Tracks the active emotion so update() can layer a per-emotion idle
  // motion signature (angry tremor, sad droop-drift, happy bounce, etc.)
  // on top of the base geometry, making emotions read even when the eyes
  // are not actively mid-transition.
  currentEmotion: RobotEmotion = 'neutral';

  // Shiver / Flicker animations
  hFlicker = false;
  hFlickerAlternate = false;
  hFlickerAmplitude = 2;

  vFlicker = false;
  vFlickerAlternate = false;
  vFlickerAmplitude = 3;

  confused = false;
  confusedTimer = 0;
  confusedDuration = 600;

  laugh = false;
  laughTimer = 0;
  laughDuration = 600;

  // Speaking mouth/pulse simulation. speakingAmplitude (0-1) is fed in from
  // the audio player's live playback loudness once per frame — when
  // present, the eye pulse tracks actual speech rhythm instead of a fixed
  // sine wave that bounces at a constant rate regardless of what's being
  // said. Falls back to the sine wave only if no amplitude data is
  // available (e.g. autoplay was blocked before playback started).
  speaking = false;
  speakingPhase = 0;
  speakingAmplitude = 0;
  private speakingAmplitudeSmoothed = 0;

  // Thinking pulse
  thinking = false;
  thinkingPhase = 0;

  constructor() {
    this.resetTiming();
  }

  resetTiming() {
    const now = performance.now();
    this.nextBlinkTime = now + this.blinkInterval + Math.random() * this.blinkIntervalVariation;
    this.nextIdleTime = now + this.idleInterval + Math.random() * this.idleIntervalVariation;
  }

  getScreenConstraintX(): number {
    return this.screenWidth - this.eyeLwidthCurrent - this.spaceBetweenCurrent - this.eyeRwidthCurrent;
  }

  getScreenConstraintY(): number {
    return this.screenHeight - this.eyeLheightDefault;
  }

  setPosition(gaze: GazeDirection) {
    const maxX = this.getScreenConstraintX();
    const maxY = this.getScreenConstraintY();

    switch (gaze) {
      case 'up':
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = 0;
        break;
      case 'up-right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = 0;
        break;
      case 'right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = Math.floor(maxY / 2);
        break;
      case 'down-right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = maxY;
        break;
      case 'down':
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = maxY;
        break;
      case 'down-left':
        this.eyeLxNext = 0;
        this.eyeLyNext = maxY;
        break;
      case 'left':
        this.eyeLxNext = 0;
        this.eyeLyNext = Math.floor(maxY / 2);
        break;
      case 'up-left':
        this.eyeLxNext = 0;
        this.eyeLyNext = 0;
        break;
      case 'center':
      default:
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = Math.floor(maxY / 2);
        break;
    }
  }

  setEmotion(emotion: RobotEmotion, intensity: number = 0.6) {
    this.currentEmotion = emotion;
    this.tired = false;
    this.angry = false;
    this.happy = false;
    this.sad = false;
    this.curious = false;
    this.confused = false;
    this.thinking = false;
    this.speaking = false;
    this.hFlicker = false;
    this.vFlicker = false;

    // Reset base eye sizes
    this.eyeLheightDefault = 36;
    this.eyeRheightDefault = 36;
    this.eyeLwidthDefault = 36;
    this.eyeRwidthDefault = 36;
    this.eyeLborderRadiusDefault = 8;
    this.eyeRborderRadiusDefault = 8;

    switch (emotion) {
      case 'happy':
        this.happy = true;
        this.eyeLheightDefault = Math.round(32 + intensity * 4);
        this.eyeRheightDefault = Math.round(32 + intensity * 4);
        break;
      case 'angry':
        this.angry = true;
        this.eyeLheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.eyeRheightDefault = Math.round(24 + (1 - intensity) * 6);
        break;
      case 'sad':
        this.sad = true;
        this.tired = true;
        this.eyeLheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.eyeRheightDefault = Math.round(24 + (1 - intensity) * 6);
        break;
      case 'surprised':
        this.eyeLheightDefault = 46;
        this.eyeRheightDefault = 46;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        this.eyeLborderRadiusDefault = 18;
        this.eyeRborderRadiusDefault = 18;
        break;
      case 'curious':
        this.curious = true;
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 30;
        this.eyeLborderRadiusDefault = 10;
        this.eyeRborderRadiusDefault = 8;
        break;
      case 'confused':
        this.confused = true;
        this.eyeLheightDefault = 36;
        this.eyeRheightDefault = 24;
        this.animConfused();
        break;
      case 'sleepy':
        this.tired = true;
        this.eyeLheightDefault = 10;
        this.eyeRheightDefault = 10;
        this.eyeLborderRadiusDefault = 5;
        this.eyeRborderRadiusDefault = 5;
        break;
      case 'thinking':
        this.thinking = true;
        this.eyeLheightDefault = 30;
        this.eyeRheightDefault = 30;
        break;
      case 'listening':
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 38;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        break;
      case 'speaking':
        this.speaking = true;
        this.eyeLheightDefault = 36;
        this.eyeRheightDefault = 36;
        break;
      case 'error':
        this.angry = true;
        this.hFlicker = true;
        this.hFlickerAmplitude = 3;
        this.eyeLheightDefault = 24;
        this.eyeRheightDefault = 24;
        break;
      // Newer emotions reuse the same eyelid/shape mechanics as their
      // nearest existing neighbor, at different magnitudes — this keeps
      // them visually coherent with the rest of the face rather than each
      // needing wholly new geometry.
      case 'amused':
        // A smaller, asymmetric "smirk" version of happy.
        this.happy = true;
        this.eyeLheightDefault = Math.round(30 + intensity * 3);
        this.eyeRheightDefault = Math.round(26 + intensity * 2);
        break;
      case 'proud':
        // Bigger, steadier happy — no curious/sideways drift.
        this.happy = true;
        this.eyeLheightDefault = Math.round(34 + intensity * 5);
        this.eyeRheightDefault = Math.round(34 + intensity * 5);
        this.eyeLborderRadiusDefault = 10;
        this.eyeRborderRadiusDefault = 10;
        break;
      case 'bored':
        // Droopy like sleepy, but not fully closed.
        this.tired = true;
        this.eyeLheightDefault = Math.round(18 - intensity * 4);
        this.eyeRheightDefault = Math.round(18 - intensity * 4);
        break;
      case 'annoyed':
        // Milder angry — same mechanic, smaller size reduction.
        this.angry = true;
        this.eyeLheightDefault = Math.round(28 + (1 - intensity) * 4);
        this.eyeRheightDefault = Math.round(28 + (1 - intensity) * 4);
        break;
      case 'skeptical':
        // Sharper asymmetric version of curious — one eye narrows more.
        this.curious = true;
        this.eyeLheightDefault = 34;
        this.eyeRheightDefault = 22;
        this.eyeLborderRadiusDefault = 8;
        this.eyeRborderRadiusDefault = 6;
        break;
      case 'determined':
        // Bold and steady: centered, slightly squared-off corners.
        this.eyeLheightDefault = Math.round(32 + intensity * 4);
        this.eyeRheightDefault = Math.round(32 + intensity * 4);
        this.eyeLborderRadiusDefault = 6;
        this.eyeRborderRadiusDefault = 6;
        break;
      case 'worried':
        // Between confused and sad — mild droop, gaze up (scanning for
        // the problem) rather than down (sad's resignation).
        this.tired = true;
        this.eyeLheightDefault = Math.round(28 + (1 - intensity) * 4);
        this.eyeRheightDefault = Math.round(30 + (1 - intensity) * 4);
        break;
      case 'excited':
        // Bigger and rounder than surprised, with happy's smile curve.
        this.happy = true;
        this.eyeLheightDefault = Math.round(40 + intensity * 6);
        this.eyeRheightDefault = Math.round(40 + intensity * 6);
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        this.eyeLborderRadiusDefault = 16;
        this.eyeRborderRadiusDefault = 16;
        break;
      case 'neutral':
      default:
        break;
    }

    this.eyeLheightNext = this.eyeLheightDefault;
    this.eyeRheightNext = this.eyeRheightDefault;
    this.eyeLwidthNext = this.eyeLwidthDefault;
    this.eyeRwidthNext = this.eyeRwidthDefault;
    this.eyeLborderRadiusNext = this.eyeLborderRadiusDefault;
    this.eyeRborderRadiusNext = this.eyeRborderRadiusDefault;
  }

  blink() {
    this.close();
    this.open();
  }

  close() {
    this.eyeLheightNext = 1;
    this.eyeRheightNext = 1;
    this.eyeL_open = false;
    this.eyeR_open = false;
  }

  open() {
    this.eyeL_open = true;
    this.eyeR_open = true;
  }

  animConfused() {
    this.confused = true;
    this.confusedTimer = performance.now();
    this.hFlicker = true;
    this.hFlickerAmplitude = 4;
  }

  animLaugh() {
    this.laugh = true;
    this.laughTimer = performance.now();
    this.vFlicker = true;
    this.vFlickerAmplitude = 4;
  }

  update(now: number) {
    // 1. Auto-blinker timing. Occasionally chain a quick second blink
    // (real eyes rarely blink in perfectly isolated, evenly-spaced beats).
    if (this.autoblinker && now >= this.nextBlinkTime) {
      this.blink();
      if (this.pendingDoubleBlink) {
        this.pendingDoubleBlink = false;
        this.nextBlinkTime = now + 180;
      } else {
        this.pendingDoubleBlink = Math.random() < 0.18;
        this.nextBlinkTime = now + this.blinkInterval + Math.random() * this.blinkIntervalVariation;
      }
    }

    // 1b. Micro-saccades: small frequent jitter so the eyes never look
    // perfectly frozen between the larger idle repositions.
    if (now >= this.nextMicroJitterTime) {
      if (!this.speaking && !this.thinking) {
        this.microJitterX = (Math.random() - 0.5) * 3;
        this.microJitterY = (Math.random() - 0.5) * 2;
      } else {
        this.microJitterX = 0;
        this.microJitterY = 0;
      }
      this.nextMicroJitterTime =
        now + this.microJitterInterval + Math.random() * this.microJitterIntervalVariation;
    }

    // 1c. Continuous breathing pulse, always on, independent of emotion.
    this.breathingPhase += 0.02;
    const breathing = Math.sin(this.breathingPhase) * 1.2;

    // 2. Idle eye movement timing
    if (this.idle && !this.speaking && !this.thinking && now >= this.nextIdleTime) {
      const maxX = this.getScreenConstraintX();
      const maxY = this.getScreenConstraintY();
      this.eyeLxNext = Math.floor(Math.random() * maxX);
      this.eyeLyNext = Math.floor(Math.random() * maxY);
      this.nextIdleTime = now + this.idleInterval + Math.random() * this.idleIntervalVariation;
    }

    // 3. One-shot timer checks
    if (this.confused && now >= this.confusedTimer + this.confusedDuration) {
      this.confused = false;
      this.hFlicker = false;
    }

    if (this.laugh && now >= this.laughTimer + this.laughDuration) {
      this.laugh = false;
      this.vFlicker = false;
    }

    // 4. Speaking bounce / speech rhythm. Smooth the raw amplitude signal
    // (it's noisy per-frame) with a fast attack / slower release so the
    // pulse still feels tightly coupled to the voice without visibly
    // jittering every frame.
    if (this.speaking) {
      const target = this.speakingAmplitude;
      const rate = target > this.speakingAmplitudeSmoothed ? 0.6 : 0.25;
      this.speakingAmplitudeSmoothed += (target - this.speakingAmplitudeSmoothed) * rate;

      if (this.speakingAmplitudeSmoothed > 0.02) {
        // Real audio amplitude is driving the pulse: eyes widen with
        // loudness, matching actual speech rhythm.
        const pulse = this.speakingAmplitudeSmoothed * 10;
        this.eyeLheightNext = Math.max(12, this.eyeLheightDefault + pulse);
        this.eyeRheightNext = Math.max(12, this.eyeRheightDefault + pulse);
      } else {
        // No amplitude data yet (or a silent gap in speech) — fall back to
        // a gentle sine idle so the eyes don't go dead-still mid-utterance.
        this.speakingPhase += 0.15;
        const pulse = Math.sin(this.speakingPhase) * 2;
        this.eyeLheightNext = Math.max(12, this.eyeLheightDefault + pulse);
        this.eyeRheightNext = Math.max(12, this.eyeRheightDefault + pulse);
      }
    } else {
      this.speakingAmplitudeSmoothed = 0;
    }

    // 5. Thinking subtle pulse (overrides the idle breathing baseline while active)
    if (this.thinking) {
      this.thinkingPhase += 0.08;
      this.eyeLheightOffset = Math.sin(this.thinkingPhase) * 2;
      this.eyeRheightOffset = Math.sin(this.thinkingPhase) * 2;
    } else {
      // Idle baseline: continuous breathing, plus a per-emotion motion
      // signature so emotions read even when not mid-transition.
      //
      // NOTE: 'angry' previously had a continuous horizontal tremor here.
      // Removed — Jimmy can sit idle-but-angry for a while after a reply
      // (emotion persists through idle; nothing resets it), and a never-
      // ending shake over that whole stretch read as broken/nervous rather
      // than expressive. The angry eyelid shape alone already reads clearly
      // as angry; it doesn't need a constant motion on top to sell it.
      this.eyeLheightOffset = breathing;
      this.eyeRheightOffset = breathing;

      switch (this.currentEmotion) {
        case 'happy':
          // Gentle upward bounce
          this.eyeLheightOffset += Math.abs(Math.sin(this.breathingPhase * 1.5)) * 2;
          this.eyeRheightOffset += Math.abs(Math.sin(this.breathingPhase * 1.5)) * 2;
          break;
        case 'sad':
          // Slow downward droop-drift, settling lower over time then resetting
          this.eyeLheightOffset -= (Math.sin(this.breathingPhase * 0.5) + 1) * 1.5;
          this.eyeRheightOffset -= (Math.sin(this.breathingPhase * 0.5) + 1) * 1.5;
          break;
        case 'curious':
          // Asymmetric tilt: one eye drifts slightly larger than the other, alternating
          this.eyeLheightOffset += Math.sin(this.breathingPhase * 0.7) * 2.5;
          this.eyeRheightOffset -= Math.sin(this.breathingPhase * 0.7) * 2.5;
          break;
      }
    }

    // 6. Curious gaze expansion when looking sideways. Additive, not an
    // overwrite — overwriting eyeLheightOffset/eyeRheightOffset here
    // discarded whatever smooth per-frame signature step 5 had just
    // computed (breathing, the curious tilt oscillation, etc.) and
    // replaced it with a flat value, producing a visible pop/jump every
    // time idle wandering happened to reach a screen edge while curious.
    if (this.curious) {
      if (this.eyeLxNext <= 6) {
        this.eyeLheightOffset += 6;
      } else if (this.eyeRxNext >= this.screenWidth - this.eyeRwidthCurrent - 6) {
        this.eyeRheightOffset += 6;
      }
    }

    // 7. Smooth asymptotic lerping (RoboEyes mathematical core)
    // The breathing/emotion height offset must NOT apply while a blink is
    // closing the eye (eyeLheightNext/eyeRheightNext == 1) — this formula's
    // steady state is `next + offset`, so a positive offset (happy/curious
    // idle, or breathing mid-upswing) kept the closed target above the <=2
    // reopen threshold and the blink never fully closed, instead flickering
    // at a few px for a frame or two before the next state change forcibly
    // reset it. That read as an unpolished glitch rather than a clean blink.
    const heightOffsetL = this.eyeLheightNext <= 2 ? 0 : this.eyeLheightOffset;
    const heightOffsetR = this.eyeRheightNext <= 2 ? 0 : this.eyeRheightOffset;
    this.eyeLheightCurrent = (this.eyeLheightCurrent + this.eyeLheightNext + heightOffsetL) / 2;
    this.eyeRheightCurrent = (this.eyeRheightCurrent + this.eyeRheightNext + heightOffsetR) / 2;

    if (this.eyeL_open && this.eyeLheightCurrent <= 2) {
      this.eyeLheightNext = this.eyeLheightDefault;
    }
    if (this.eyeR_open && this.eyeRheightCurrent <= 2) {
      this.eyeRheightNext = this.eyeRheightDefault;
    }

    this.eyeLwidthCurrent = (this.eyeLwidthCurrent + this.eyeLwidthNext) / 2;
    this.eyeRwidthCurrent = (this.eyeRwidthCurrent + this.eyeRwidthNext) / 2;

    this.spaceBetweenCurrent = (this.spaceBetweenCurrent + this.spaceBetweenNext) / 2;

    this.eyeLx = (this.eyeLx + this.eyeLxNext) / 2;
    this.eyeLy = (this.eyeLy + this.eyeLyNext) / 2;

    this.eyeRxNext = this.eyeLxNext + this.eyeLwidthCurrent + this.spaceBetweenCurrent;
    this.eyeRyNext = this.eyeLyNext;

    this.eyeRx = (this.eyeRx + this.eyeRxNext) / 2;
    this.eyeRy = (this.eyeRy + this.eyeRyNext) / 2;

    this.eyeLborderRadiusCurrent = (this.eyeLborderRadiusCurrent + this.eyeLborderRadiusNext) / 2;
    this.eyeRborderRadiusCurrent = (this.eyeRborderRadiusCurrent + this.eyeRborderRadiusNext) / 2;

    // Eyelid targets
    const halfHeight = this.eyeLheightCurrent / 2;
    this.eyelidsTiredHeightNext = this.tired ? halfHeight : 0;
    this.eyelidsAngryHeightNext = this.angry ? halfHeight : 0;
    this.eyelidsHappyBottomOffsetNext = this.happy ? halfHeight : 0;

    this.eyelidsTiredHeight = (this.eyelidsTiredHeight + this.eyelidsTiredHeightNext) / 2;
    this.eyelidsAngryHeight = (this.eyelidsAngryHeight + this.eyelidsAngryHeightNext) / 2;
    this.eyelidsHappyBottomOffset = (this.eyelidsHappyBottomOffset + this.eyelidsHappyBottomOffsetNext) / 2;
  }

  draw(ctx: CanvasRenderingContext2D) {
    let lx = this.eyeLx;
    let ly = this.eyeLy;
    let rx = this.eyeRx;
    let ry = this.eyeRy;

    // Apply flicker offsets
    if (this.hFlicker) {
      const offset = this.hFlickerAlternate ? this.hFlickerAmplitude : -this.hFlickerAmplitude;
      lx += offset;
      rx += offset;
      this.hFlickerAlternate = !this.hFlickerAlternate;
    }

    if (this.vFlicker) {
      const offset = this.vFlickerAlternate ? this.vFlickerAmplitude : -this.vFlickerAmplitude;
      ly += offset;
      ry += offset;
      this.vFlickerAlternate = !this.vFlickerAlternate;
    }

    // Apply micro-saccade jitter (both eyes move together, like a real gaze shift)
    lx += this.microJitterX;
    rx += this.microJitterX;
    ly += this.microJitterY;
    ry += this.microJitterY;

    // Eye dimensions
    const lw = Math.max(1, Math.round(this.eyeLwidthCurrent));
    const lh = Math.max(1, Math.round(this.eyeLheightCurrent));
    const lr = Math.min(Math.round(this.eyeLborderRadiusCurrent), Math.floor(lh / 2), Math.floor(lw / 2));

    const rw = Math.max(1, Math.round(this.eyeRwidthCurrent));
    const rh = Math.max(1, Math.round(this.eyeRheightCurrent));
    const rr = Math.min(Math.round(this.eyeRborderRadiusCurrent), Math.floor(rh / 2), Math.floor(rw / 2));

    // 1. Clear background
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.screenWidth, this.screenHeight);

    // 2. Draw eye bodies with rounded rects and soft OLED glow
    ctx.save();
    ctx.shadowColor = this.glowColor;
    ctx.shadowBlur = 4;
    ctx.fillStyle = this.mainColor;

    // Left eye
    ctx.beginPath();
    ctx.roundRect(Math.round(lx), Math.round(ly), lw, lh, lr);
    ctx.fill();

    // Right eye
    if (!this.cyclops) {
      ctx.beginPath();
      ctx.roundRect(Math.round(rx), Math.round(ry), rw, rh, rr);
      ctx.fill();
    }
    ctx.restore();

    // 3. Eyelids clipping using background color
    ctx.fillStyle = this.bgColor;

    // Tired / Sad top eyelids (slants down towards outside corners)
    if (this.eyelidsTiredHeight > 0.5) {
      const th = this.eyelidsTiredHeight;
      // Left eye (droops down on outside left)
      ctx.beginPath();
      ctx.moveTo(lx - 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly + Math.max(0, th - 6));
      ctx.lineTo(lx - 1, ly + th);
      ctx.closePath();
      ctx.fill();

      // Right eye (droops down on outside right)
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx - 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry + th);
        ctx.lineTo(rx - 1, ry + Math.max(0, th - 6));
        ctx.closePath();
        ctx.fill();
      }
    }

    // Angry top eyelids (slants down towards center/bridge)
    if (this.eyelidsAngryHeight > 0.5) {
      const ah = this.eyelidsAngryHeight;
      // Left eye (slants down towards center right)
      ctx.beginPath();
      ctx.moveTo(lx - 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly + ah);
      ctx.lineTo(lx - 1, ly + Math.max(0, ah - 10));
      ctx.closePath();
      ctx.fill();

      // Right eye (slants down towards center left)
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx - 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry + Math.max(0, ah - 10));
        ctx.lineTo(rx - 1, ry + ah);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Happy bottom eyelids (smooth smiling crescent curve)
    if (this.eyelidsHappyBottomOffset > 0.5) {
      const ho = this.eyelidsHappyBottomOffset;
      // Left eye curved bottom cut
      ctx.beginPath();
      ctx.moveTo(lx - 2, ly + lh + 2);
      ctx.lineTo(lx - 2, ly + lh - 1);
      ctx.quadraticCurveTo(lx + lw / 2, ly + lh - ho - 6, lx + lw + 2, ly + lh - 1);
      ctx.lineTo(lx + lw + 2, ly + lh + 2);
      ctx.closePath();
      ctx.fill();

      // Right eye curved bottom cut
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx - 2, ry + rh + 2);
        ctx.lineTo(rx - 2, ry + rh - 1);
        ctx.quadraticCurveTo(rx + rw / 2, ry + rh - ho - 6, rx + rw + 2, ry + rh - 1);
        ctx.lineTo(rx + rw + 2, ry + rh + 2);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}
