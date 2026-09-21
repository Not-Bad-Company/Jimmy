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
  // Screen size (canonical OLED 128x64) — stays fixed at this exact
  // resolution because it's meant to map 1:1 onto a real SSD1306/SSD1327
  // OLED later; layout changes below reallocate space WITHIN 128x64
  // rather than growing the canvas.
  readonly screenWidth = 128;
  readonly screenHeight = 64;

  // Vertical layout budget: the eyes get the middle band, leaving a fixed
  // margin above for eyebrows and below for the mouth. Eye wander/gaze is
  // clamped to this band (see getScreenConstraintY/setPosition) so eyes
  // can never drift far enough to overlap the new elements.
  readonly eyeBandTop = 10;
  readonly eyeBandBottom = 56;

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
  // A bit wider than the original 10 — extra breathing room between the
  // two eyes' glow halos so they read as distinct even at larger eye sizes
  // (surprised/excited/determined), on top of the halo radius cap above.
  spaceBetweenDefault = 14;
  spaceBetweenCurrent = 14;
  spaceBetweenNext = 14;

  eyeLxDefault = Math.floor((128 - (36 + 14 + 36)) / 2); // 21
  eyeLyDefault = Math.floor((64 - 36) / 2); // 14
  eyeLx = this.eyeLxDefault;
  eyeLy = this.eyeLyDefault;
  eyeLxNext = this.eyeLxDefault;
  eyeLyNext = this.eyeLyDefault;

  eyeRxDefault = this.eyeLxDefault + 36 + 14; // 71
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

  // Eyebrows: a small rounded bar above each eye, secondary to the eyes
  // (thin, no glow). Two knobs per side, each with the usual
  // Default/Current/Next smoothing:
  //  - tiltL/tiltR: how much the inner end (the one nearer the nose)
  //    droops relative to the outer end. Positive = inner end LOWER,
  //    which reads as a classic angry "V" when both sides use the same
  //    positive value; negative = inner end raised, reading as
  //    worried/sad. Independent per side so asymmetric looks (skeptical,
  //    confused) are possible, matching how eye height is already
  //    independent per side for those emotions.
  //  - raiseL/raiseR: vertical shift of that whole brow (negative = up).
  browHeight = 3;
  browGap = 2; // gap between brow bottom edge and the eye band's top edge
  browTiltLDefault = 0;
  browTiltLCurrent = 0;
  browTiltLNext = 0;
  browTiltRDefault = 0;
  browTiltRCurrent = 0;
  browTiltRNext = 0;
  browRaiseLDefault = 0;
  browRaiseLCurrent = 0;
  browRaiseLNext = 0;
  browRaiseRDefault = 0;
  browRaiseRCurrent = 0;
  browRaiseRNext = 0;

  // Mouth: a single bar centered under the eyes, drawn with the same
  // quadratic-curve technique the happy eyelid crescent already uses —
  // positive curve bows the bar into a "cup" (smile), negative bows it
  // into a "cap" (frown). `open` swaps it for a small rounded square
  // (surprised/excited "O" mouth) instead of the curved bar.
  mouthWidthDefault = 32;
  mouthWidthCurrent = 32;
  mouthWidthNext = 32;
  mouthHeightDefault = 3;
  mouthHeightCurrent = 3;
  mouthHeightNext = 3;
  mouthCurveDefault = 0;
  mouthCurveCurrent = 0;
  mouthCurveNext = 0;
  mouthOpen = false;

  // How open the mouth currently is, 0 (fully closed flat bar) to 1 (fully
  // open, jaw dropped, dark cavity visible) — driven by live speaking
  // amplitude (see the speaking block in update()), NOT just a static
  // per-emotion flag. A mouth that only ever pulses its thickness while
  // talking never actually looks like it's forming an open/closed shape;
  // this makes it visibly open on louder syllables and close between
  // them, which is what "looks like it's actually talking" needs.
  // `mouthOpen` (surprised/excited) forces this to 1 permanently instead
  // of animating it.
  mouthOpenAmount = 0;

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
    return this.eyeBandBottom - this.eyeBandTop - this.eyeLheightDefault;
  }

  setPosition(gaze: GazeDirection) {
    const maxX = this.getScreenConstraintX();
    const maxY = this.getScreenConstraintY();
    const top = this.eyeBandTop;

    switch (gaze) {
      case 'up':
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = top;
        break;
      case 'up-right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = top;
        break;
      case 'right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = top + Math.floor(maxY / 2);
        break;
      case 'down-right':
        this.eyeLxNext = maxX;
        this.eyeLyNext = top + maxY;
        break;
      case 'down':
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = top + maxY;
        break;
      case 'down-left':
        this.eyeLxNext = 0;
        this.eyeLyNext = top + maxY;
        break;
      case 'left':
        this.eyeLxNext = 0;
        this.eyeLyNext = top + Math.floor(maxY / 2);
        break;
      case 'up-left':
        this.eyeLxNext = 0;
        this.eyeLyNext = top;
        break;
      case 'center':
      default:
        this.eyeLxNext = Math.floor(maxX / 2);
        this.eyeLyNext = top + Math.floor(maxY / 2);
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
    // A high default radius (clamped to half the shape's own height/width
    // in draw(), so this is a ceiling, not a fixed value) makes the default
    // "pill"-shaped rather than a rounded square — softer, closer to the
    // smooth glowing-capsule look real OLED robot-face eyes go for. Cases
    // below that want a visibly different silhouette (surprised's fuller
    // roundness, sleepy's slit, curious's asymmetry) still override it.
    this.eyeLborderRadiusDefault = 16;
    this.eyeRborderRadiusDefault = 16;

    // Reset brows/mouth to neutral before the switch below overrides them —
    // same pattern as the eye geometry reset above.
    this.browTiltLDefault = 0;
    this.browTiltRDefault = 0;
    this.browRaiseLDefault = 0;
    this.browRaiseRDefault = 0;
    this.mouthWidthDefault = 32;
    this.mouthHeightDefault = 3;
    this.mouthCurveDefault = 0;
    this.mouthOpen = false;

    switch (emotion) {
      case 'happy':
        this.happy = true;
        this.eyeLheightDefault = Math.round(32 + intensity * 4);
        this.eyeRheightDefault = Math.round(32 + intensity * 4);
        this.browRaiseLDefault = -1;
        this.browRaiseRDefault = -1;
        this.mouthWidthDefault = Math.round(38 + intensity * 8);
        this.mouthHeightDefault = 4;
        this.mouthCurveDefault = Math.round(2 + intensity * 2);
        break;
      case 'angry':
        this.angry = true;
        this.eyeLheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.eyeRheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.browTiltLDefault = Math.round(3 + intensity * 2);
        this.browTiltRDefault = Math.round(3 + intensity * 2);
        this.mouthWidthDefault = 30;
        this.mouthCurveDefault = -2;
        break;
      case 'sad':
        this.sad = true;
        this.tired = true;
        this.eyeLheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.eyeRheightDefault = Math.round(24 + (1 - intensity) * 6);
        this.browTiltLDefault = -3;
        this.browTiltRDefault = -3;
        this.browRaiseLDefault = 1;
        this.browRaiseRDefault = 1;
        this.mouthWidthDefault = 30;
        this.mouthCurveDefault = -4;
        break;
      case 'surprised':
        this.eyeLheightDefault = 46;
        this.eyeRheightDefault = 46;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        this.eyeLborderRadiusDefault = 18;
        this.eyeRborderRadiusDefault = 18;
        this.browRaiseLDefault = -4;
        this.browRaiseRDefault = -4;
        this.mouthOpen = true;
        break;
      case 'curious':
        this.curious = true;
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 30;
        this.eyeLborderRadiusDefault = 18;
        this.eyeRborderRadiusDefault = 15;
        this.browRaiseLDefault = -3;
        this.mouthWidthDefault = 26;
        this.mouthCurveDefault = 1;
        break;
      case 'confused':
        this.confused = true;
        this.eyeLheightDefault = 36;
        this.eyeRheightDefault = 24;
        this.browTiltLDefault = 2;
        this.browTiltRDefault = -2;
        this.browRaiseRDefault = -2;
        this.mouthWidthDefault = 24;
        this.animConfused();
        break;
      case 'sleepy':
        this.tired = true;
        this.eyeLheightDefault = 10;
        this.eyeRheightDefault = 10;
        this.eyeLborderRadiusDefault = 5;
        this.eyeRborderRadiusDefault = 5;
        this.browRaiseLDefault = 2;
        this.browRaiseRDefault = 2;
        this.mouthWidthDefault = 18;
        this.mouthHeightDefault = 2;
        break;
      case 'thinking':
        this.thinking = true;
        this.eyeLheightDefault = 30;
        this.eyeRheightDefault = 30;
        this.browTiltLDefault = 1;
        this.browTiltRDefault = -1;
        this.browRaiseLDefault = -1;
        this.mouthWidthDefault = 22;
        this.mouthHeightDefault = 2;
        break;
      case 'listening':
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 38;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        this.browRaiseLDefault = -1;
        this.browRaiseRDefault = -1;
        this.mouthWidthDefault = 30;
        this.mouthCurveDefault = 1;
        break;
      case 'speaking':
        this.speaking = true;
        this.eyeLheightDefault = 36;
        this.eyeRheightDefault = 36;
        this.mouthWidthDefault = 36;
        this.mouthCurveDefault = 1;
        break;
      case 'error':
        this.angry = true;
        this.hFlicker = true;
        this.hFlickerAmplitude = 3;
        this.eyeLheightDefault = 24;
        this.eyeRheightDefault = 24;
        this.browTiltLDefault = 5;
        this.browTiltRDefault = 5;
        this.mouthWidthDefault = 28;
        this.mouthCurveDefault = -2;
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
        this.browRaiseLDefault = -2;
        this.mouthWidthDefault = 32;
        this.mouthCurveDefault = 2;
        break;
      case 'proud':
        // Bigger, steadier happy — no curious/sideways drift.
        this.happy = true;
        this.eyeLheightDefault = Math.round(34 + intensity * 5);
        this.eyeRheightDefault = Math.round(34 + intensity * 5);
        this.eyeLborderRadiusDefault = 18;
        this.eyeRborderRadiusDefault = 18;
        this.browRaiseLDefault = -1;
        this.browRaiseRDefault = -1;
        this.mouthWidthDefault = 40;
        this.mouthHeightDefault = 4;
        this.mouthCurveDefault = 2;
        break;
      case 'bored':
        // Droopy like sleepy, but not fully closed.
        this.tired = true;
        this.eyeLheightDefault = Math.round(18 - intensity * 4);
        this.eyeRheightDefault = Math.round(18 - intensity * 4);
        this.browRaiseLDefault = 1;
        this.browRaiseRDefault = 1;
        this.mouthWidthDefault = 22;
        this.mouthCurveDefault = -1;
        break;
      case 'annoyed':
        // Milder angry — same mechanic, smaller size reduction.
        this.angry = true;
        this.eyeLheightDefault = Math.round(28 + (1 - intensity) * 4);
        this.eyeRheightDefault = Math.round(28 + (1 - intensity) * 4);
        this.browTiltLDefault = 2;
        this.browTiltRDefault = 2;
        this.mouthWidthDefault = 30;
        this.mouthCurveDefault = -1;
        break;
      case 'skeptical':
        // Sharper asymmetric version of curious — one eye narrows more.
        this.curious = true;
        this.eyeLheightDefault = 34;
        this.eyeRheightDefault = 22;
        this.eyeLborderRadiusDefault = 13;
        this.eyeRborderRadiusDefault = 9;
        this.browRaiseLDefault = -3;
        this.browTiltRDefault = 2;
        this.browRaiseRDefault = 1;
        this.mouthWidthDefault = 26;
        this.mouthCurveDefault = -1;
        break;
      case 'determined':
        // Bold and steady: centered, a bit less rounded than the default
        // pill (was 6 — that read as a plain blocky rectangle once every
        // other emotion moved to a soft near-pill radius; this keeps the
        // "steadier/firmer" distinction without clashing with the style).
        this.eyeLheightDefault = Math.round(32 + intensity * 4);
        this.eyeRheightDefault = Math.round(32 + intensity * 4);
        this.eyeLborderRadiusDefault = 12;
        this.eyeRborderRadiusDefault = 12;
        this.browTiltLDefault = 2;
        this.browTiltRDefault = 2;
        this.mouthWidthDefault = 38;
        break;
      case 'worried':
        // Between confused and sad — mild droop, gaze up (scanning for
        // the problem) rather than down (sad's resignation).
        this.tired = true;
        this.eyeLheightDefault = Math.round(28 + (1 - intensity) * 4);
        this.eyeRheightDefault = Math.round(30 + (1 - intensity) * 4);
        this.browTiltLDefault = -2;
        this.browTiltRDefault = -2;
        this.browRaiseLDefault = 1;
        this.browRaiseRDefault = 1;
        this.mouthWidthDefault = 28;
        this.mouthCurveDefault = -2;
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
        this.browRaiseLDefault = -3;
        this.browRaiseRDefault = -3;
        this.mouthOpen = true;
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

    this.browTiltLNext = this.browTiltLDefault;
    this.browTiltRNext = this.browTiltRDefault;
    this.browRaiseLNext = this.browRaiseLDefault;
    this.browRaiseRNext = this.browRaiseRDefault;
    this.mouthWidthNext = this.mouthWidthDefault;
    this.mouthHeightNext = this.mouthHeightDefault;
    this.mouthCurveNext = this.mouthCurveDefault;
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
      this.eyeLyNext = this.eyeBandTop + Math.floor(Math.random() * maxY);
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
        // loudness, matching actual speech rhythm. Width gets a smaller
        // matching pulse too (in sync, not an independent wobble) — a
        // height-only bounce reads as one repetitive motion; real talking
        // has a little horizontal give as well.
        const pulse = this.speakingAmplitudeSmoothed * 10;
        this.eyeLheightNext = Math.max(12, this.eyeLheightDefault + pulse);
        this.eyeRheightNext = Math.max(12, this.eyeRheightDefault + pulse);
        const widthPulse = this.speakingAmplitudeSmoothed * 3;
        this.eyeLwidthNext = Math.max(20, this.eyeLwidthDefault + widthPulse);
        this.eyeRwidthNext = Math.max(20, this.eyeRwidthDefault + widthPulse);
      } else {
        // No amplitude data yet (or a silent gap in speech) — fall back to
        // a gentle sine idle so the eyes don't go dead-still mid-utterance.
        this.speakingPhase += 0.15;
        const pulse = Math.sin(this.speakingPhase) * 2;
        this.eyeLheightNext = Math.max(12, this.eyeLheightDefault + pulse);
        this.eyeRheightNext = Math.max(12, this.eyeRheightDefault + pulse);
        this.eyeLwidthNext = this.eyeLwidthDefault;
        this.eyeRwidthNext = this.eyeRwidthDefault;
      }

      // Mouth openness (0-1: closed flat bar -> fully open with a visible
      // dark cavity) tracks amplitude directly, fast attack / slower
      // release so it snaps open on a loud syllable and eases shut between
      // words instead of looking twitchy. This — not a thickness pulse on
      // a flat bar — is what makes the mouth actually look like it's
      // forming words rather than just buzzing.
      const openTarget = Math.min(1, this.speakingAmplitudeSmoothed * 1.8);
      const openRate = openTarget > this.mouthOpenAmount ? 0.7 : 0.2;
      this.mouthOpenAmount += (openTarget - this.mouthOpenAmount) * openRate;
    } else {
      this.speakingAmplitudeSmoothed = 0;
      this.eyeLwidthNext = this.eyeLwidthDefault;
      this.eyeRwidthNext = this.eyeRwidthDefault;
      this.mouthOpenAmount *= 0.75; // ease shut rather than snapping closed
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
    // Same fix as the happy crescent below: a droop/slant cut eating 50%
    // of the eye's height read as a solid black bar (a hard sunglasses-like
    // edge, not even curved like happy's) once the glow halo made the
    // contrast much more visible than it was pre-glow. Capped smaller.
    // Below ~20px tall, the eye is already flattened enough (sleepy/bored)
    // that an additional droop cut has no room to look like a curved lid —
    // it just reads as a flat black block stacked on a short white sliver.
    // The reduced eye height alone already sells sleepy/bored; skip the cut
    // there and reserve it for taller eyes (sad/worried) where it has room
    // to actually look like a lid.
    this.eyelidsTiredHeightNext =
      this.tired && this.eyeLheightCurrent > 20 ? this.eyeLheightCurrent * 0.32 : 0;
    this.eyelidsAngryHeightNext = this.angry ? halfHeight : 0;
    // Happy's bottom cut is a filled dome (quadratic curve), not the
    // tired/angry diagonal slants above — a curved cut eating a full 50%
    // of the eye reads very differently from a linear slant at the same
    // height, and combined with the new glow halo (a hard black edge
    // biting into a soft gradient) produced a large stark dome that looked
    // like a rendering bug rather than a smile-squint. Capped much smaller.
    this.eyelidsHappyBottomOffsetNext = this.happy ? this.eyeLheightCurrent * 0.22 : 0;

    this.eyelidsTiredHeight = (this.eyelidsTiredHeight + this.eyelidsTiredHeightNext) / 2;
    this.eyelidsAngryHeight = (this.eyelidsAngryHeight + this.eyelidsAngryHeightNext) / 2;
    this.eyelidsHappyBottomOffset = (this.eyelidsHappyBottomOffset + this.eyelidsHappyBottomOffsetNext) / 2;

    // Eyebrows: same asymptotic lerp as everything else above.
    this.browTiltLCurrent = (this.browTiltLCurrent + this.browTiltLNext) / 2;
    this.browTiltRCurrent = (this.browTiltRCurrent + this.browTiltRNext) / 2;
    this.browRaiseLCurrent = (this.browRaiseLCurrent + this.browRaiseLNext) / 2;
    this.browRaiseRCurrent = (this.browRaiseRCurrent + this.browRaiseRNext) / 2;

    // Mouth: same lerp.
    this.mouthWidthCurrent = (this.mouthWidthCurrent + this.mouthWidthNext) / 2;
    this.mouthCurveCurrent = (this.mouthCurveCurrent + this.mouthCurveNext) / 2;
    this.mouthHeightCurrent = (this.mouthHeightCurrent + this.mouthHeightNext) / 2;
  }

  /** One eye's rounded-rect body: an explicit radial-gradient halo bloom
   * (NOT ctx.shadowBlur — verified via a real headless-Chromium screenshot
   * that shadowBlur silently renders as nothing in at least that engine
   * configuration, producing a flat hard-edged shape with zero glow despite
   * the shadow calls being present; a gradient fill has no such dependency
   * and is guaranteed visible), plus a crisp core and a small brightened
   * highlight on top. */
  private drawEyeShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    const cx = rx + w / 2;
    const cy = ry + h / 2;

    // Soft halo bloom: radial gradient from a bright core fading fully
    // transparent, filled over a square big enough that the fade-out is
    // never visibly clipped.
    //
    // The radius is the shape's own half-size PLUS A CONSTANT bleed
    // distance — not a flat multiple of the shape size. Two earlier
    // attempts both got this wrong in opposite directions, confirmed by
    // actual screenshots each time: a multiplier big enough to bleed
    // visibly past small eyes (0.7x) bled FAR past large eyes too and
    // bridged the inter-eye gap, fusing both glows into one blob with the
    // mouth sitting inside it. Shrinking the multiplier (0.42x) to stop
    // that fixed large eyes but made the radius smaller than large eyes'
    // own half-size, hiding the entire halo under the opaque core — no
    // glow at all on surprised/excited/determined. A constant bleed keeps
    // the visible glow amount consistent across every eye size, and stays
    // well under half the 14px eye gap regardless of eye size.
    const halfDiag = Math.max(w, h) / 2;
    const glowBleed = 6;
    const glowRadius = halfDiag + glowBleed;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
    gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.1)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2);
    ctx.restore();

    // Crisp core.
    ctx.save();
    ctx.fillStyle = this.mainColor;
    ctx.beginPath();
    ctx.roundRect(rx, ry, w, h, r);
    ctx.fill();
    ctx.restore();

    // Subtle top-left highlight — a small brighter patch to suggest a lit,
    // slightly convex surface instead of a flat matte fill. Kept small and
    // low-opacity so it reads as polish, not a distracting extra shape.
    const hw = Math.max(2, Math.round(w * 0.35));
    const hh = Math.max(2, Math.round(h * 0.3));
    if (hw < w - 2 && hh < h - 2) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.roundRect(rx + Math.round(w * 0.14), ry + Math.round(h * 0.12), hw, hh, Math.round(hh / 2));
      ctx.fill();
      ctx.restore();
    }
  }

  /** A rounded-capsule eyebrow, centered at (cx, cy), rotated by `angle`
   * radians about that center — gives a clean tilt with fully rounded ends
   * instead of a sharp-cornered trapezoid. */
  private drawBrow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    angle: number
  ) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = this.mainColor;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.restore();
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

    // 2. Draw eye bodies: a soft wide halo pass underneath, then a crisp
    // core on top with a subtle brightened highlight — a flat fill + tiny
    // 4px blur read as a plain lit rectangle; this reads as an actually
    // luminous surface, closer to how a real glowing round-panel robot
    // face (soft diffused light, not a hard-edged sticker) looks.
    this.drawEyeShape(ctx, lx, ly, lw, lh, lr);
    if (!this.cyclops) {
      this.drawEyeShape(ctx, rx, ry, rw, rh, rr);
    }

    // 3. Eyelids clipping using background color
    ctx.fillStyle = this.bgColor;

    // Tired / Sad top eyelids (slants down towards outside corners)
    if (this.eyelidsTiredHeight > 0.5) {
      const th = this.eyelidsTiredHeight;
      const thInner = th * 0.5; // proportional slant, not a fixed px offset
      // Left eye (droops down on outside left)
      ctx.beginPath();
      ctx.moveTo(lx - 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly - 1);
      ctx.lineTo(lx + lw + 1, ly + thInner);
      ctx.lineTo(lx - 1, ly + th);
      ctx.closePath();
      ctx.fill();

      // Right eye (droops down on outside right)
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx - 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry - 1);
        ctx.lineTo(rx + rw + 1, ry + th);
        ctx.lineTo(rx - 1, ry + thInner);
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
      ctx.quadraticCurveTo(lx + lw / 2, ly + lh - ho - 2, lx + lw + 2, ly + lh - 1);
      ctx.lineTo(lx + lw + 2, ly + lh + 2);
      ctx.closePath();
      ctx.fill();

      // Right eye curved bottom cut
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx - 2, ry + rh + 2);
        ctx.lineTo(rx - 2, ry + rh - 1);
        ctx.quadraticCurveTo(rx + rw / 2, ry + rh - ho - 2, rx + rw + 2, ry + rh - 1);
        ctx.lineTo(rx + rw + 2, ry + rh + 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 4. Eyebrows: small rounded CAPSULES (full end-cap rounding, not a
    // sharp-mitered polygon — a flat-ended trapezoid read as a blocky
    // corner cut next to the eyes' soft pill shapes). Position tracks each
    // eye's CURRENT top edge (ly/ry — not a fixed band anchor): anchoring
    // to a fixed Y independent of the eye's actual rest position left a
    // large, clearly disconnected gap whenever the eye's default Y (used
    // to sit well below the reserved brow band) didn't match that anchor —
    // confirmed by an actual screenshot, not just reasoning about it. A
    // small fixed gap above the live eye edge keeps them visually attached
    // regardless of the eye's current height/position, and still lets
    // `browRaise` lift them further for surprised/excited on top of that.
    this.drawBrow(
      ctx,
      lx + lw / 2,
      ly - this.browGap - this.browHeight / 2 + this.browRaiseLCurrent,
      lw * 0.85,
      this.browHeight,
      // Left brow: positive tilt lowers the inner (right) end, i.e. a
      // clockwise rotation of the capsule.
      Math.atan2(this.browTiltLCurrent, lw)
    );
    if (!this.cyclops) {
      this.drawBrow(
        ctx,
        rx + rw / 2,
        ry - this.browGap - this.browHeight / 2 + this.browRaiseRCurrent,
        rw * 0.85,
        this.browHeight,
        // Right brow mirrors left: positive tilt lowers the inner (left)
        // end, i.e. a counter-clockwise rotation.
        -Math.atan2(this.browTiltRCurrent, rw)
      );
    }

    // 5. Mouth: horizontally fixed/centered (doesn't track gaze — a mouth
    // darting sideways with the eyes would look wrong), but Y tracks the
    // eyes' actual current bottom edge with a small fixed gap, the same
    // fix applied to the brows above and for the same reason: anchoring to
    // the fixed reserved-band math instead left a large, visibly
    // disconnected gap whenever the eyes' actual size/position (which
    // varies a lot by emotion — 10px tall for sleepy, 46px for surprised)
    // didn't match that fixed number.
    //
    // `openAmt` (0-1) unifies two sources: `mouthOpen` (surprised/excited)
    // forces it permanently open, otherwise it's `mouthOpenAmount`, driven
    // live by speaking amplitude (see update()). A mouth that only pulsed
    // its thickness while talking never actually looked like it opened and
    // closed — this makes the jaw visibly drop on louder syllables, with a
    // dark interior cavity once open enough to read as a mouth rather than
    // just a taller bar, and eases back to the closed curved bar (smile/
    // frown) between words.
    const mw = Math.max(1, Math.round(this.mouthWidthCurrent));
    const baseMh = Math.max(1, Math.round(this.mouthHeightCurrent));
    const mx = Math.round((this.screenWidth - mw) / 2);
    const openAmt = this.mouthOpen ? 1 : this.mouthOpenAmount;
    const mouthGap = 4;
    const eyesBottomAvg = (ly + lh + ry + rh) / 2;
    // The open-mouth growth must be capped by how much room is actually
    // left below the eyes, not just a flat px/width-relative number — for
    // large eyes (surprised/excited, whose wander can push their bottom
    // edge close to the canvas edge already) a flat cap let the mouth grow
    // taller than the remaining space, and clamping ITS POSITION against
    // the canvas edge afterward (rather than clamping its GROWTH) pulled
    // the whole mouth upward into the eyes with no gap at all — confirmed
    // by an actual screenshot showing the open mouth's cavity touching the
    // eyes directly. Shrinking the growth instead keeps the gap intact.
    const availableBelow = this.screenHeight - Math.round(eyesBottomAvg) - mouthGap - 1;
    const maxOpenExtra = Math.max(1, availableBelow - baseMh);
    const openExtra = openAmt * Math.min(16, mw * 0.5, maxOpenExtra);
    const mh = Math.max(1, Math.round(baseMh + openExtra));
    const my = Math.round(eyesBottomAvg) + mouthGap;

    ctx.save();
    ctx.fillStyle = this.mainColor;

    if (openAmt > 0.06) {
      // Jaw dropped: upper lip line (my) stays put, the shape just grows
      // downward. Rounded rect, not the smile/frown curve — real mouths
      // flatten out shape-wise once actually open, the curve only reads
      // when closed.
      const capR = Math.min(mh / 2, mw / 2);
      ctx.beginPath();
      ctx.roundRect(mx, my, mw, mh, capR);
      ctx.fill();

      // Dark interior cavity, once open enough for one to be visible —
      // this is what sells "open mouth" instead of "taller white blob".
      if (openAmt > 0.22) {
        const inset = Math.max(2, Math.round(mw * 0.16));
        const cavityW = Math.max(1, mw - inset * 2);
        const cavityTop = my + Math.max(1, Math.round(baseMh * 0.8));
        const cavityBottom = my + mh - Math.max(1, Math.round(baseMh * 0.5));
        const cavityH = Math.max(0, cavityBottom - cavityTop);
        if (cavityH > 1) {
          ctx.fillStyle = this.bgColor;
          ctx.beginPath();
          ctx.roundRect(mx + inset, cavityTop, cavityW, cavityH, Math.min(cavityH / 2, cavityW / 2));
          ctx.fill();
        }
      }
    } else {
      // Closed: same quadratic-curve technique as the happy eyelid
      // crescent above, but filled as a bar rather than cut as a
      // background mask: positive curve bows the whole bar into a "cup"
      // (smile), negative into a "cap" (frown). End caps are rounded
      // (arcTo) rather than square — a hard vertical corner next to a
      // curved top/bottom edge read as a stray blocky notch rather than
      // one clean shape.
      const curve = this.mouthCurveCurrent;
      const capR = Math.min(mh / 2, mw / 2);
      ctx.beginPath();
      ctx.moveTo(mx + capR, my);
      ctx.quadraticCurveTo(mx + mw / 2, my + curve, mx + mw - capR, my);
      ctx.arcTo(mx + mw, my, mx + mw, my + capR, capR);
      ctx.lineTo(mx + mw, my + mh - capR);
      ctx.arcTo(mx + mw, my + mh, mx + mw - capR, my + mh, capR);
      ctx.quadraticCurveTo(mx + mw / 2, my + mh + curve, mx + capR, my + mh);
      ctx.arcTo(mx, my + mh, mx, my + mh - capR, capR);
      ctx.lineTo(mx, my + capR);
      ctx.arcTo(mx, my, mx + capR, my, capR);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}
