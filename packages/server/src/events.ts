// The event log: the last few hundred events in memory for the dashboard, and every event appended to
// events.jsonl in the data folder so nothing is lost when the app restarts.
import fs from 'node:fs';
import path from 'node:path';
import type { EventEntry } from '@ledmon/shared';

export class EventLog {
  private entries: EventEntry[] = [];
  private nextId = 1;
  private readonly file?: string;

  constructor(dataDir?: string, private readonly keep = 500) {
    if (dataDir) {
      this.file = path.join(dataDir, 'events.jsonl');
      this.loadTail();
    }
  }

  add(e: Omit<EventEntry, 'id' | 'time'> & { time?: number }): EventEntry {
    const entry: EventEntry = { id: this.nextId++, time: e.time ?? Date.now(), processorId: e.processorId, level: e.level, message: e.message };
    this.entries.push(entry);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
      } catch {
        // A full or read-only disk must not stop monitoring; the event is still on screen.
      }
    }
    return entry;
  }

  /** Newest first. */
  recent(limit = 100): EventEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  private loadTail(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-this.keep);
      for (const line of lines) {
        const e = JSON.parse(line) as EventEntry;
        this.entries.push(e);
        this.nextId = Math.max(this.nextId, e.id + 1);
      }
    } catch {
      // A damaged log is ignored and new events are appended after it.
    }
  }
}
