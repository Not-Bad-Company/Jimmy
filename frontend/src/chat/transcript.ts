/**
 * TranscriptManager: Handles rendering the conversation stream and message history.
 */

import { RobotEmotion } from '../face/types';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  emotion?: RobotEmotion;
  timestamp: string;
  isStreaming?: boolean;
}

export class TranscriptManager {
  private container: HTMLElement;
  private messages: DisplayMessage[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  addMessage(role: 'user' | 'assistant' | 'system', content: string, emotion?: RobotEmotion): DisplayMessage {
    const msg: DisplayMessage = {
      id: Math.random().toString(36).substring(2, 9),
      role,
      content,
      emotion,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      isStreaming: false,
    };
    this.messages.push(msg);
    this.render();
    return msg;
  }

  startStreamingAssistant(initialContent: string = ''): DisplayMessage {
    const msg: DisplayMessage = {
      id: Math.random().toString(36).substring(2, 9),
      role: 'assistant',
      content: initialContent,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      isStreaming: true,
    };
    this.messages.push(msg);
    this.render();
    return msg;
  }

  appendStreamToken(token: string) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && last.isStreaming) {
      last.content += token;
      this.updateLastMessage(last);
    }
  }

  finalizeStreaming(finalText: string, emotion?: RobotEmotion) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.content = finalText;
      last.emotion = emotion;
      last.isStreaming = false;
      this.render();
    }
  }

  clear() {
    this.messages = [];
    this.render();
  }

  private updateLastMessage(msg: DisplayMessage) {
    const lastEl = this.container.lastElementChild as HTMLElement;
    if (lastEl) {
      const contentEl = lastEl.querySelector('.msg-content');
      if (contentEl) {
        contentEl.textContent = msg.content;
        this.scrollToBottom();
      }
    }
  }

  private render() {
    this.container.innerHTML = '';
    if (this.messages.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'transcript-empty';
      placeholder.textContent = 'Awaiting vocal transmission or text inquiry...';
      this.container.appendChild(placeholder);
      return;
    }

    for (const msg of this.messages) {
      const item = document.createElement('div');
      item.className = `transcript-item msg-${msg.role}`;

      const header = document.createElement('div');
      header.className = 'msg-header';

      const roleLabel = document.createElement('span');
      roleLabel.className = 'msg-role';
      roleLabel.textContent = msg.role === 'user' ? 'YOU' : 'ROCKY';

      const timeLabel = document.createElement('span');
      timeLabel.className = 'msg-time';
      timeLabel.textContent = msg.timestamp;

      header.appendChild(roleLabel);
      if (msg.emotion) {
        const emoTag = document.createElement('span');
        emoTag.className = `msg-emotion-tag emo-${msg.emotion}`;
        emoTag.textContent = msg.emotion.toUpperCase();
        header.appendChild(emoTag);
      }
      header.appendChild(timeLabel);

      const content = document.createElement('div');
      content.className = 'msg-content';
      content.textContent = msg.content;

      if (msg.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        cursor.textContent = ' ▍';
        content.appendChild(cursor);
      }

      item.appendChild(header);
      item.appendChild(content);
      this.container.appendChild(item);
    }

    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
