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

The browser canvas renders this 128x64 coordinate space onto an offscreen canvas and scales it up to fit the viewport with an OLED bezel, deep #000000 background, and vibrant cyan OLED glow.

This ensures that when physical OLED hardware is connected in future iterations, the animation math and coordinates map 1:1 onto the microcontroller framebuffer without rewriting.

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
