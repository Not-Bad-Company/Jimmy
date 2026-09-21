/**
 * FaceRenderer: Manages the HTML5 Canvas display and renders RoboEyes
 * at the canonical 128x64 resolution, scaled cleanly to the screen.
 */

import { RoboEyes } from './robo_eyes';

export class FaceRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;
  private eyes: RoboEyes;

  readonly canonicalWidth = 128;
  readonly canonicalHeight = 64;

  constructor(canvas: HTMLCanvasElement, eyes: RoboEyes) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    // Canonical 128x64 offscreen buffer
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = this.canonicalWidth;
    this.offscreenCanvas.height = this.canonicalHeight;
    const offCtx = this.offscreenCanvas.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('Could not get offscreen context');
    this.offscreenCtx = offCtx;

    this.eyes = eyes;
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
  }

  handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
  }

  render(now: number) {
    // 1. Update eye geometry and animations
    this.eyes.update(now);

    // 2. Draw on canonical 128x64 buffer
    this.eyes.draw(this.offscreenCtx);

    // 3. Scale canonical 128x64 buffer to main canvas with OLED bezel styling
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.fillStyle = '#05070a';
    this.ctx.fillRect(0, 0, w, h);

    // Maintain 2:1 aspect ratio inside canvas
    const targetAspect = 128 / 64;
    const currentAspect = w / h;

    let drawW: number, drawH: number, drawX: number, drawY: number;

    if (currentAspect > targetAspect) {
      drawH = h * 0.9;
      drawW = drawH * targetAspect;
      drawX = (w - drawW) / 2;
      drawY = (h - drawH) / 2;
    } else {
      drawW = w * 0.9;
      drawH = drawW / targetAspect;
      drawX = (w - drawW) / 2;
      drawY = (h - drawH) / 2;
    }

    this.ctx.save();
    // High quality scaling with slight scanline / OLED pixel softness
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    // Outer screen bezel with soft border
    this.ctx.strokeStyle = '#1a2230';
    this.ctx.lineWidth = 4;
    this.ctx.strokeRect(drawX - 2, drawY - 2, drawW + 4, drawH + 4);

    this.ctx.drawImage(
      this.offscreenCanvas,
      0,
      0,
      this.canonicalWidth,
      this.canonicalHeight,
      Math.round(drawX),
      Math.round(drawY),
      Math.round(drawW),
      Math.round(drawH),
    );

    this.ctx.restore();
  }
}
