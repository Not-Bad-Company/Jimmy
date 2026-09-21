/**
 * RawTranscriptManager: Handles rendering the internal raw conversation
 * transcript stream in clean monospace log format.
 */

export interface LogLine {
  id: string;
  source: 'USER' | 'JIMMY' | 'SYS';
  text: string;
  meta?: string;
  timestamp: string;
  isStreaming?: boolean;
}

export class TranscriptManager {
  private container: HTMLElement;
  private entries: LogLine[] = [];
  private showSystemLogs = true;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setShowSystemLogs(show: boolean) {
    this.showSystemLogs = show;
    this.render();
  }

  addMessage(role: 'user' | 'assistant' | 'system', content: string, emotion?: string): LogLine {
    const source = role === 'user' ? 'USER' : role === 'assistant' ? 'JIMMY' : 'SYS';
    const entry: LogLine = {
      id: Math.random().toString(36).substring(2, 9),
      source,
      text: content,
      meta: emotion ? `[${emotion.toUpperCase()}]` : undefined,
      timestamp: new Date().toLocaleTimeString([], { hour12: false }),
      isStreaming: false,
    };
    this.entries.push(entry);
    this.render();
    return entry;
  }

  addSystemLog(text: string): LogLine {
    const entry: LogLine = {
      id: Math.random().toString(36).substring(2, 9),
      source: 'SYS',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour12: false }),
      isStreaming: false,
    };
    this.entries.push(entry);
    this.render();
    return entry;
  }

  startStreamingAssistant(initialContent: string = ''): LogLine {
    const entry: LogLine = {
      id: Math.random().toString(36).substring(2, 9),
      source: 'JIMMY',
      text: initialContent,
      timestamp: new Date().toLocaleTimeString([], { hour12: false }),
      isStreaming: true,
    };
    this.entries.push(entry);
    this.render();
    return entry;
  }

  appendStreamToken(token: string) {
    const last = this.entries[this.entries.length - 1];
    if (last && last.source === 'JIMMY' && last.isStreaming) {
      last.text += token;
      this.updateLastEntry(last);
    }
  }

  finalizeStreaming(finalText: string, emotion?: string) {
    const last = this.entries[this.entries.length - 1];
    if (last && last.source === 'JIMMY') {
      last.text = finalText;
      if (emotion) {
        last.meta = `[${emotion.toUpperCase()}]`;
      }
      last.isStreaming = false;
      this.render();
    }
  }

  clear() {
    this.entries = [];
    this.render();
  }

  private updateLastEntry(entry: LogLine) {
    const lastEl = this.container.lastElementChild as HTMLElement;
    if (lastEl) {
      const textEl = lastEl.querySelector('.log-text');
      if (textEl) {
        textEl.textContent = entry.text;
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        cursor.textContent = ' ▍';
        textEl.appendChild(cursor);
        this.scrollToBottom();
      }
    }
  }

  // Single compact line per entry: "TAG  text". Monochrome — weight and
  // opacity distinguish speaker/system rather than color, matching the
  // rest of the UI (no accent colors anywhere else in the app).
  private render() {
    this.container.innerHTML = '';
    const visible = this.showSystemLogs
      ? this.entries
      : this.entries.filter((e) => e.source !== 'SYS');

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = this.showSystemLogs ? 'No activity yet.' : 'No activity yet. (Debug log hidden)';
      this.container.appendChild(empty);
      return;
    }

    for (const entry of visible) {
      const el = document.createElement('div');
      el.className = `log-entry log-entry--${entry.source.toLowerCase()}`;

      const tag = document.createElement('span');
      tag.className = 'log-tag';
      tag.textContent = entry.source === 'JIMMY' && entry.meta ? `JIMMY ${entry.meta}` : entry.source;
      el.appendChild(tag);

      const text = document.createElement('span');
      text.className = 'log-text';
      text.textContent = entry.text;

      if (entry.isStreaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        cursor.textContent = ' ▍';
        text.appendChild(cursor);
      }

      el.appendChild(text);
      this.container.appendChild(el);
    }

    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
