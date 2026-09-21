# Rocky Face & Animated Eye Renderer

Rocky's face is modeled after physical monochrome robotic OLED displays (such as 0.96" or 1.3" SSD1306 / SSD1327 displays).

---

## 1. Logical Coordinate System (128 × 64)

The renderer operates strictly in a canonical **128 × 64** logical pixel resolution:
- **Display Width**: 128 px
- **Display Height**: 64 px
- **Left Eye Default**: Width = 36 px, Height = 36 px, Radius = 8 px, X = 23, Y = 14
- **Right Eye Default**: Width = 36 px, Height = 36 px, Radius = 8 px, X = 69, Y = 14
- **Eye Spacing**: 10 px

The browser canvas renders this 128x64 coordinate space onto an offscreen canvas and scales it up to fit the viewport, centered on a pure `#000000` background with no bezel or chrome. Eyes render solid white (`#FFFFFF`) with a soft white glow — strictly monochrome, matching a physical monochrome OLED and the brief's "the browser is a robot display, not a website" requirement.

This ensures that when physical OLED hardware is connected in future iterations, the animation math and coordinates map 1:1 onto the microcontroller framebuffer without rewriting.

**Rendering fix (this session)**: the renderer originally drew the eyes onto
a real 128×64 bitmap canvas, then bitmap-stretched that image up to fill the
screen with `drawImage()` + smoothing — which visibly blurs/pixelates when
stretched 10-15x on a real monitor (confirmed via screenshot: soft fuzzy
edges instead of crisp shapes). Fixed in `frontend/src/face/renderer.ts`: the
128×64 logical coordinate system is unchanged (RoboEyes still only ever
knows about 128×64 units, so the hardware-portability goal above still
holds), but the browser display path now uses a canvas transform
(`ctx.translate` + `ctx.scale`) so every shape is rasterized directly at
native output resolution. No offscreen bitmap, no stretch, crisp edges at
any screen size.

---

## 2. RoboEyes Library Reuse & Attribution

The core animation logic is adapted from the open-source **FluxGarage RoboEyes** library:
- **Author**: Dennis Hoelscher (FluxGarage, www.fluxgarage.com)
- **License**: GNU General Public License v3.0 (GPL-3.0)
- **Adapted Features**:
  - Asymptotic lerping: `current = (current + target) / 2`
  - Predefined cardinal & diagonal positions: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`, and `CENTER`
  - Eyelid clipping:
    - **Tired / Sleepy**: Diagonal top triangles slanting downward towards the outside.
    - **Angry**: Reverse-slanted diagonal triangles slanting downward towards the center.
    - **Happy**: Curved bottom mask cut out of the lower half of each eye.
  - Saccadic idle motion: Automated random repositioning at configurable intervals.
  - Auto-blinking: Periodic blinks where eye height smoothly closes to 1px and expands back.
  - Horizontal & Vertical flickers (used for confused and laughing animations).

---

## 3. Rocky Extensions

On top of the base RoboEyes engine, Rocky implements:
1. **Speaking Pulse**: Rhythmic vertical bounce and subtle dilation synchronized with speech playback duration.
2. **Thinking Gaze**: Upward wander with subtle cyclical breathing pulse during LLM token generation.
3. **Curious Gaze Expansion**: Outer eye dilates by 6px when Rocky glances sideways towards an object or inquiry.
4. **Error Glitch**: High-intensity angry squint with horizontal tremor.
5. **Decoupled Architecture**:
   - `FaceRenderer`: Pure canvas rendering of 128x64 pixels.
   - `AnimationController`: Manages the 60fps requestAnimationFrame loop.
   - `EmotionController`: Translates semantic state (`EmotionState`: state, emotion, intensity, gaze) into RoboEyes parameters.

## 4. Idle liveliness & per-emotion motion signatures (this session)

Added after feedback that the face looked static/lifeless when idle and
that emotions didn't read clearly on their own:

- **Continuous breathing pulse**: a small always-on sine-wave height
  oscillation (~±1.2px), independent of the stronger "thinking" pulse, so
  the eyes are never perfectly frozen even in neutral/idle.
- **Micro-saccades**: small (±1.5px) jitter applied every ~0.5-1.2s, layered
  on top of (not replacing) the larger occasional idle repositioning — real
  eyes never hold perfectly still between deliberate gaze shifts either.
- **Occasional double-blink**: ~18% chance of a quick second blink 180ms
  after the first, instead of every blink being identically spaced.
- **Per-emotion idle motion signatures**, active even when not mid-transition:
  - `happy`: gentle upward bounce
  - `angry`: low-amplitude constant tremor (distinct from the sharper,
    larger `error` flicker)
  - `sad`: slow downward droop-drift
  - `curious`: alternating asymmetric eye-size tilt

All of this lives in `RoboEyes.update()` in `frontend/src/face/robo_eyes.ts`.
Not independently visually verified (no browser automation available in the
environment that made this change) — verify by eye before trusting the
description matches what's on screen.
