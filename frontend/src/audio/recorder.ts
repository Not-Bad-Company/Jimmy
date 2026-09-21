/**
 * AudioRecorder: Captures microphone audio using MediaRecorder
 * Supports Push-To-Talk and continuous mode.
 */

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private isRecording = false;

  public onRecordingStart?: () => void;
  public onRecordingStop?: (blob: Blob) => void;
  public onError?: (err: Error) => void;

  async start(): Promise<boolean> {
    if (this.isRecording) return true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Prefer audio/webm or audio/ogg
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';
        }
      }

      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);

      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const mime = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: mime });
        this.audioChunks = [];
        this.cleanup();
        if (this.onRecordingStop) {
          this.onRecordingStop(blob);
        }
      };

      this.mediaRecorder.start(100);
      this.isRecording = true;
      if (this.onRecordingStart) {
        this.onRecordingStart();
      }
      return true;
    } catch (err: any) {
      this.cleanup();
      const error = new Error(`Microphone access error: ${err.message || err}`);
      if (this.onError) {
        this.onError(error);
      }
      return false;
    }
  }

  stop() {
    if (!this.isRecording || !this.mediaRecorder) return;
    this.isRecording = false;
    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  get active(): boolean {
    return this.isRecording;
  }

  private cleanup() {
    this.isRecording = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
