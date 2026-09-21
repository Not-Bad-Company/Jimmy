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
  mainColor = '#00F0FF'; // Vibrant OLED Cyan
  glowColor = 'rgba(0, 240, 255, 0.4)';

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

  // Idle movement
  idle = true;
  idleInterval = 2000;
  idleIntervalVariation = 3000;
  nextIdleTime = 0;

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

  // Speaking mouth/pulse simulation
  speaking = false;
  speakingPhase = 0;

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
    this.tired = false;
    this.angry = false;
    this.happy = false;
    this.sad = false;
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
        this.eyeLheightDefault = Math.round(36 + intensity * 4);
        this.eyeRheightDefault = Math.round(36 + intensity * 4);
        break;
      case 'angry':
        this.angry = true;
        this.eyeLheightDefault = Math.round(30 + (1 - intensity) * 6);
        this.eyeRheightDefault = Math.round(30 + (1 - intensity) * 6);
        break;
      case 'sad':
        this.sad = true;
        this.tired = true; // slightly droopy
        this.eyeLheightDefault = 28;
        this.eyeRheightDefault = 28;
        break;
      case 'surprised':
        this.eyeLheightDefault = 44;
        this.eyeRheightDefault = 44;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        this.eyeLborderRadiusDefault = 16;
        this.eyeRborderRadiusDefault = 16;
        break;
      case 'curious':
        this.curious = true;
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 38;
        break;
      case 'confused':
        this.confused = true;
        this.animConfused();
        break;
      case 'sleepy':
        this.tired = true;
        this.eyeLheightDefault = 16;
        this.eyeRheightDefault = 16;
        break;
      case 'thinking':
        this.thinking = true;
        this.setPosition('up');
        break;
      case 'listening':
        this.eyeLheightDefault = 38;
        this.eyeRheightDefault = 38;
        this.eyeLwidthDefault = 38;
        this.eyeRwidthDefault = 38;
        break;
      case 'speaking':
        this.speaking = true;
        break;
      case 'error':
        this.angry = true;
        this.hFlicker = true;
        this.hFlickerAmplitude = 3;
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
    // 1. Auto-blinker timing
    if (this.autoblinker && now >= this.nextBlinkTime) {
      this.blink();
      this.nextBlinkTime = now + this.blinkInterval + Math.random() * this.blinkIntervalVariation;
    }

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

    // 4. Speaking bounce / speech rhythm
    if (this.speaking) {
      this.speakingPhase += 0.25;
      const pulse = Math.sin(this.speakingPhase) * 4;
      this.eyeLheightNext = Math.max(12, this.eyeLheightDefault + pulse);
      this.eyeRheightNext = Math.max(12, this.eyeRheightDefault + pulse);
    }

    // 5. Thinking subtle pulse
    if (this.thinking) {
      this.thinkingPhase += 0.08;
      this.eyeLheightOffset = Math.sin(this.thinkingPhase) * 2;
      this.eyeRheightOffset = Math.sin(this.thinkingPhase) * 2;
    } else {
      this.eyeLheightOffset = 0;
      this.eyeRheightOffset = 0;
    }

    // 6. Curious gaze expansion when looking sideways
    if (this.curious) {
      if (this.eyeLxNext <= 6) {
        this.eyeLheightOffset = 6;
      } else if (this.eyeRxNext >= this.screenWidth - this.eyeRwidthCurrent - 6) {
        this.eyeRheightOffset = 6;
      }
    }

    // 7. Smooth asymptotic lerping (RoboEyes mathematical core)
    this.eyeLheightCurrent = (this.eyeLheightCurrent + this.eyeLheightNext + this.eyeLheightOffset) / 2;
    this.eyeRheightCurrent = (this.eyeRheightCurrent + this.eyeRheightNext + this.eyeRheightOffset) / 2;

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

    // Tired top eyelids (diagonal triangles slanting down towards outside)
    if (this.eyelidsTiredHeight > 0.5) {
      const th = this.eyelidsTiredHeight;
      // Left eye
      ctx.beginPath();
      ctx.moveTo(lx, ly - 1);
      ctx.lineTo(lx + lw, ly - 1);
      ctx.lineTo(lx, ly + th);
      ctx.closePath();
      ctx.fill();

      // Right eye
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx, ry - 1);
        ctx.lineTo(rx + rw, ry - 1);
        ctx.lineTo(rx + rw, ry + th);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Angry top eyelids (diagonal triangles slanting down towards inside)
    if (this.eyelidsAngryHeight > 0.5) {
      const ah = this.eyelidsAngryHeight;
      // Left eye (slants down towards center/right)
      ctx.beginPath();
      ctx.moveTo(lx, ly - 1);
      ctx.lineTo(lx + lw, ly - 1);
      ctx.lineTo(lx + lw, ly + ah);
      ctx.closePath();
      ctx.fill();

      // Right eye (slants down towards center/left)
      if (!this.cyclops) {
        ctx.beginPath();
        ctx.moveTo(rx, ry - 1);
        ctx.lineTo(rx + rw, ry - 1);
        ctx.lineTo(rx, ry + ah);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Happy bottom eyelids (curved mask at bottom of eyes)
    if (this.eyelidsHappyBottomOffset > 0.5) {
      const ho = this.eyelidsHappyBottomOffset;
      // Left eye bottom cut
      ctx.beginPath();
      ctx.roundRect(
        lx - 1,
        ly + lh - ho + 1,
        lw + 2,
        this.eyeLheightDefault,
        lr,
      );
      ctx.fill();

      // Right eye bottom cut
      if (!this.cyclops) {
        const rw = Math.max(1, Math.round(this.eyeRwidthCurrent));
        const rr = Math.min(Math.round(this.eyeRborderRadiusCurrent), Math.floor(this.eyeRheightCurrent / 2));
        ctx.beginPath();
        ctx.roundRect(
          rx - 1,
          ry + this.eyeRheightCurrent - ho + 1,
          rw + 2,
          this.eyeRheightDefault,
          rr,
        );
        ctx.fill();
      }
    }
  }
}
