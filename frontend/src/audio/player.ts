/**
 * AudioPlayer: Manages synthesis audio playback, avoiding overlapping speech
 * and triggering speaking state synchronization.
 *
 * Also taps the live audio stream with a Web Audio AnalyserNode so the face
 * can pulse in sync with actual speech loudness/rhythm, instead of a fixed
 * sine wave that has no relationship to what's actually being said (that
 * mismatch was reported as the eyes and voice feeling like "two separate
 * entities").
 */

export class AudioPlayer {
  private currentAudio: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private currentSourceAudio: HTMLAudioElement | null = null;
  public onPlaybackStart?: () => void;
  public onPlaybackEnd?: () => void;
  public onError?: (err: Error) => void;

  /**
   * Current playback loudness, 0-1 (RMS of the time-domain waveform).
   * Returns 0 when nothing is playing or the analyser isn't ready yet.
   * Poll this once per animation frame while speaking.
   */
  getAmplitude(): number {
    if (!this.analyser || !this.analyserData) return 0;
    this.analyser.getByteTimeDomainData(this.analyserData as Uint8Array<ArrayBuffer>);
    let sumSquares = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const normalized = (this.analyserData[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / this.analyserData.length);
    // RMS of typical speech rarely approaches 1.0; scale up so it maps to a
    // usable 0-1 range for the eye pulse instead of staying near-silent.
    return Math.min(1, rms * 3.5);
  }

  private ensureAnalyser(audio: HTMLAudioElement) {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.connect(this.audioCtx.destination);
    }
    // A MediaElementAudioSourceNode can only ever be created once per
    // <audio> element, and reusing the same element across plays would
    // throw. We always construct a fresh Audio() per playUrl() call, so a
    // fresh source node per call is correct and required here.
    if (this.currentSourceAudio !== audio) {
      this.sourceNode?.disconnect();
      this.sourceNode = this.audioCtx.createMediaElementSource(audio);
      this.sourceNode.connect(this.analyser!);
      this.currentSourceAudio = audio;
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  playBase64(base64Wav: string): Promise<void> {
    const audioSrc = `data:audio/wav;base64,${base64Wav}`;
    return this.playUrl(audioSrc);
  }

  playUrl(url: string): Promise<void> {
    return new Promise((resolve) => {
      this.stop();

      const audio = new Audio(url);
      this.currentAudio = audio;

      try {
        this.ensureAnalyser(audio);
      } catch (_) {
        // Analyser is a nice-to-have for eye sync; playback must still work
        // without it (e.g. if AudioContext creation is blocked).
      }

      audio.onplay = () => {
        if (this.onPlaybackStart) {
          this.onPlaybackStart();
        }
      };

      audio.onended = () => {
        this.currentAudio = null;
        if (this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
        resolve();
      };

      audio.onerror = () => {
        this.currentAudio = null;
        const err = new Error(`Audio playback failed: ${audio.error?.message || 'unknown'}`);
        if (this.onError) {
          this.onError(err);
        }
        if (this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
        resolve();
      };

      audio.play().catch((err) => {
        this.currentAudio = null;
        // User may not have interacted with page yet (autoplay policy)
        if (this.onError) {
          this.onError(new Error(`Autoplay policy prevented audio: ${err.message}`));
        }
        if (this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
        resolve();
      });
    });
  }

  stop() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch (_) {}
      this.currentAudio = null;
      if (this.onPlaybackEnd) {
        this.onPlaybackEnd();
      }
    }
  }

  get isPlaying(): boolean {
    return this.currentAudio !== null && !this.currentAudio.paused;
  }

  /** Current playback position in ms, or 0 if nothing is playing — used to
   * figure out which reply segment is currently audible so the eyes can
   * switch emotion in sync with it. */
  getCurrentTimeMs(): number {
    if (!this.currentAudio) return 0;
    return this.currentAudio.currentTime * 1000;
  }
}
