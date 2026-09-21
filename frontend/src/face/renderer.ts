/**
 * FaceRenderer: Manages the HTML5 Canvas display and renders RoboEyes
 * at the canonical 128x64 logical resolution, scaled cleanly to the screen.
 *
 * RoboEyes.draw() always works in 128x64 logical units (so the same eye
 * code can later target a real OLED framebuffer 1:1). For the browser we
 * do NOT rasterize at 128x64 and then bitmap-stretch it up — that produces
 * visibly blurry/pixelated edges once stretched 10-15x on a real monitor.
 * Instead we apply a canvas transform (translate + scale) so every shape
 * RoboEyes draws is rasterized directly at full output resolution: crisp
 * vector edges at any screen size.
 */

import { RoboEyes } from './robo_eyes';

export class FaceRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private eyes: RoboEyes;

  readonly canonicalWidth = 128;
  readonly canonicalHeight = 64;

  constructor(canvas: HTMLCanvasElement, eyes: RoboEyes) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    this.eyes = eyes;
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());

    // The sidebar collapse/expand animates layout (margin-right transition,
    // see style.css) over ~250ms, but the canvas's pixel buffer was only
    // ever resized once, via a fixed setTimeout guess AFTER that animation
    // supposedly finished. For the whole transition the buffer's aspect
    // ratio didn't match the animating CSS box, so the browser stretched
    // the rendered content non-uniformly to fill it — the eyes visibly
    // squished during the toggle. A ResizeObserver tracks the actual
    // layout box every frame the animation changes it, so the buffer stays
    // in sync continuously instead of snapping into place at the end.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.handleResize());
      observer.observe(canvas);
    }
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

    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, w, h);

    // Maintain 2:1 aspect ratio inside canvas, prominent center scale (occupies up to ~80% of view)
    const targetAspect = this.canonicalWidth / this.canonicalHeight;
    const currentAspect = w / h;

    let drawW: number, drawH: number;
    if (currentAspect > targetAspect) {
      drawH = h * 0.75;
      drawW = drawH * targetAspect;
    } else {
      drawW = w * 0.85;
      drawH = drawW / targetAspect;
    }
    const drawX = (w - drawW) / 2;
    const drawY = (h - drawH) / 2;
    const scale = drawW / this.canonicalWidth;

    // 2. Draw the eyes with a real transform, not a bitmap stretch, so
    // edges stay crisp at any zoom level instead of blurring.
    this.ctx.save();
    this.ctx.translate(drawX, drawY);
    this.ctx.scale(scale, scale);
    this.eyes.draw(this.ctx);
    this.ctx.restore();
  }
}
