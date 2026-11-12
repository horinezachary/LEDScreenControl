// The event log: the last few hundred events in memory for the dashboard, and every event appended to
// events.jsonl in the data folder so nothing is lost when the app restarts.
import fs from 'node:fs';
import path from 'node:path';
import type { EventEntry } from '@ledmon/shared';

const MAX_BYTES = 20 * 1024 * 1024;

export interface EventFilter {
  processorId?: string;
  levels?: EventEntry['level'][];
  source?: NonNullable<EventEntry['source']>;
  /** Text to look for in the message, any case. */
  q?: string;
  since?: number;
  until?: number;
  limit?: number;
}

/** Events as CSV for a spreadsheet: time (ISO, local offset kept out so it sorts), level, source, processor, message. */
export function eventsCsv(events: EventEntry[]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = events.map((e) =>
    [new Date(e.time).toISOString(), e.level, e.source ?? 'monitor', e.processorId ?? '', e.message].map(cell).join(','),
  );
  return ['time,level,source,processor,message', ...rows].join('\r\n') + '\r\n';
}

export class EventLog {
  private entries: EventEntry[] = [];
  private nextId = 1;
  private writes = 0;
  private readonly file?: string;

  constructor(dataDir?: string, private readonly keep = 500) {
    if (dataDir) {
      this.file = path.join(dataDir, 'events.jsonl');
      this.loadTail();
    }
  }

  add(e: Omit<EventEntry, 'id' | 'time'> & { time?: number }): EventEntry {
    const entry: EventEntry = { id: this.nextId++, time: e.time ?? Date.now(), processorId: e.processorId, level: e.level, message: e.message, source: e.source };
    this.entries.push(entry);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
    if (this.file) {
      try {
        // Keep the log from growing without end: past 20 MB the file becomes events.jsonl.1 and a new one starts.
        if (++this.writes % 200 === 0 && fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
          fs.renameSync(this.file, `${this.file}.1`);
        }
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

  /**
   * Searches the whole log on disk (and the older file kept after a rollover), newest first. Without a data folder
   * it searches what is in memory.
   */
  search(f: EventFilter = {}): EventEntry[] {
    const limit = Math.min(f.limit ?? 500, 5000);
    const q = f.q?.trim().toLowerCase();
    const match = (e: EventEntry) =>
      (!f.processorId || e.processorId === f.processorId) &&
      (!f.levels?.length || f.levels.includes(e.level)) &&
      (!f.source || (e.source ?? 'monitor') === f.source) &&
      (f.since === undefined || e.time >= f.since) &&
      (f.until === undefined || e.time <= f.until) &&
      (!q || e.message.toLowerCase().includes(q));
    const all = this.file ? this.readAll() : this.entries;
    const out: EventEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) if (match(all[i])) out.push(all[i]);
    return out;
  }

  private readAll(): EventEntry[] {
    const out: EventEntry[] = [];
    for (const file of [`${this.file}.1`, this.file!]) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as EventEntry);
        } catch {
          // Skip a damaged line.
        }
      }
    }
    return out;
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
