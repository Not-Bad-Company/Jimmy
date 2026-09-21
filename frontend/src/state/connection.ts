/**
 * RobotConnection: Manages real-time WebSocket connection to the Rust backend
 */

import { EmotionState, GazeDirection, RobotEmotion, RobotEvent, RobotState } from '../face/types';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export class RobotConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: any = null;
  private url: string;
  private status: ConnectionStatus = 'disconnected';

  public onStatusChange?: (status: ConnectionStatus) => void;
  public onEvent?: (event: RobotEvent) => void;
  public onToken?: (token: string) => void;
  public onStateChange?: (state: EmotionState) => void;

  constructor() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.url = `${protocol}//${host}/ws`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.setStatus('connected');
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data: RobotEvent = JSON.parse(event.data);
          if (data.event_type === 'token' && data.text && this.onToken) {
            this.onToken(data.text);
          }
          if (data.emotion_state && this.onStateChange) {
            this.onStateChange(data.emotion_state);
          }
          if (this.onEvent) {
            this.onEvent(data);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.setStatus('disconnected');
        this.ws?.close();
      };
    } catch (e) {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    if (this.onStatusChange) {
      this.onStatusChange(s);
    }
  }

  send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  forceEmotion(emotion: RobotEmotion, intensity: number = 0.7, gaze: GazeDirection = 'center') {
    this.send({
      type: 'force_emotion',
      payload: { emotion, intensity, gaze },
    });
  }

  forceState(state: RobotState) {
    this.send({
      type: 'force_state',
      payload: { state },
    });
  }

  forceGaze(gaze: GazeDirection) {
    this.send({
      type: 'force_gaze',
      payload: { gaze },
    });
  }

  notifySpeechFinished() {
    this.send({
      type: 'speech_finished',
    });
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }
}
