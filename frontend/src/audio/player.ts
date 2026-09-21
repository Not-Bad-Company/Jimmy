/**
 * AudioPlayer: Manages synthesis audio playback, avoiding overlapping speech
 * and triggering speaking state synchronization.
 */

export class AudioPlayer {
  private currentAudio: HTMLAudioElement | null = null;
  public onPlaybackStart?: () => void;
  public onPlaybackEnd?: () => void;
  public onError?: (err: Error) => void;

  playBase64(base64Wav: string): Promise<void> {
    const audioSrc = `data:audio/wav;base64,${base64Wav}`;
    return this.playUrl(audioSrc);
  }

  playUrl(url: string): Promise<void> {
    return new Promise((resolve) => {
      this.stop();

      const audio = new Audio(url);
      this.currentAudio = audio;

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
}
