// Readings over time, for the charts on each processor's page. Every poll adds a sample per reading (temperatures,
// fan speeds, brightness, port loads). Three tiers keep it small: every sample for the last hour, one-minute averages
// for a day, and ten-minute averages for a week. The two longer tiers are saved to history.json every few minutes
// so a restart keeps the charts.
import fs from 'node:fs';
import path from 'node:path';
import type { HistorySeries, ProcessorView } from '@ledmon/shared';

interface Bucket {
  t: number;
  sum: number;
  n: number;
}

interface Series {
  label: string;
  unit: string;
  raw: [number, number][];
  minute: Bucket[];
  tenMinute: Bucket[];
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const RANGES = { '1h': HOUR, '24h': DAY, '7d': WEEK } as const;
export type Range = keyof typeof RANGES;

export class History {
  private data = new Map<string, Map<string, Series>>();
  private readonly file?: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.file = path.join(dataDir, 'history.json');
      this.load();
      this.saveTimer = setInterval(() => this.save(), 5 * 60_000);
      this.saveTimer.unref();
    }
  }

  record(p: ProcessorView, now = Date.now()): void {
    if (!p.reachable) return;
    const add = (key: string, label: string, unit: string, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value)) return;
      this.add(p.id, key, label, unit, value, now);
    };
    for (const t of p.temperatures) add(`temp:${t.key}`, t.label, '°C', t.value);
    for (const f of p.fans) add(`fan:${f.key}`, f.label, 'RPM', f.running ? f.rpm : 0);
    add('brightness', 'Brightness', p.brightnessUnit ?? 'nits', p.brightness);
    if (p.tiles) add('tiles-online', 'Tiles online', 'tiles', p.tiles.online);
    for (const g of p.topology?.groups ?? []) {
      for (const c of g.chains) add(`load:${c.id}`, `${c.label} load`, '%', c.from.load?.percent);
    }
  }

  private add(proc: string, key: string, label: string, unit: string, value: number, now: number): void {
    let byKey = this.data.get(proc);
    if (!byKey) this.data.set(proc, (byKey = new Map()));
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = { label, unit, raw: [], minute: [], tenMinute: [] }));
    s.label = label;
    s.raw.push([now, value]);
    while (s.raw.length && s.raw[0][0] < now - HOUR) s.raw.shift();
    bucket(s.minute, now, 60_000, value, DAY);
    bucket(s.tenMinute, now, 600_000, value, WEEK);
  }

  /** Every series for one processor over a range, oldest point first. */
  series(proc: string, range: Range, now = Date.now()): HistorySeries[] {
    const since = now - RANGES[range];
    const out: HistorySeries[] = [];
    for (const [key, s] of this.data.get(proc) ?? []) {
      const points: [number, number][] =
        range === '1h'
          ? s.raw.filter(([t]) => t >= since)
          : (range === '24h' ? s.minute : s.tenMinute).filter((b) => b.t >= since).map((b) => [b.t, round(b.sum / b.n)]);
      if (points.length) out.push({ key, label: s.label, unit: s.unit, points });
    }
    return out;
  }

  forget(proc: string): void {
    this.data.delete(proc);
  }

  close(): void {
    clearInterval(this.saveTimer);
    this.save();
  }

  save(): void {
    if (!this.file) return;
    const out: Record<string, Record<string, Omit<Series, 'raw'>>> = {};
    for (const [proc, byKey] of this.data) {
      out[proc] = {};
      for (const [key, s] of byKey) out[proc][key] = { label: s.label, unit: s.unit, minute: s.minute, tenMinute: s.tenMinute };
    }
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Charts are a convenience; a full disk must not stop monitoring.
    }
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Record<string, Omit<Series, 'raw'>>>;
      for (const [proc, byKey] of Object.entries(raw)) {
        const m = new Map<string, Series>();
        for (const [key, s] of Object.entries(byKey)) m.set(key, { ...s, raw: [] });
        this.data.set(proc, m);
      }
    } catch {
      // A damaged file starts the charts afresh.
    }
  }
}

function bucket(list: Bucket[], now: number, size: number, value: number, keep: number): void {
  const t = Math.floor(now / size) * size;
  const last = list[list.length - 1];
  if (last && last.t === t) {
    last.sum += value;
    last.n++;
  } else list.push({ t, sum: value, n: 1 });
  while (list.length && list[0].t < now - keep) list.shift();
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
