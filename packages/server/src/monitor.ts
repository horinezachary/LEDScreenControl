// Polls every processor on its own timer, keeps the latest snapshot and alerts for each, and logs every change of
// state as an event. Listeners are told after each poll so the web layer can push the new state.
import { EventEmitter } from 'node:events';
import type { Alert, DashboardState, ProcessorConfig, ProcessorSnapshot, ProcessorView } from '@ledmon/shared';
import { worstSeverity } from '@ledmon/shared';
import type { Config } from './config.js';
import type { Driver } from './drivers/types.js';
import { bromptonDriver } from './drivers/brompton.js';
import { EventLog } from './events.js';
import { evaluate, loopAlerts } from './rules.js';
import { APP_VERSION } from './version.js';

const PHASE_NOTE: Record<string, string> = {
  coex: 'NovaStar COEX support is not built yet (planned for phase 3).',
  vxpro: 'NovaStar VX Pro support is not built yet (planned for phase 5).',
};

export function driverFor(p: ProcessorConfig): Driver | undefined {
  if (p.kind === 'brompton') return bromptonDriver(p);
  return undefined;
}

interface Entry {
  config: ProcessorConfig;
  driver?: Driver;
  view: ProcessorView;
  loopsSeen: Set<number>;
  timer?: NodeJS.Timeout;
  inFlight?: AbortController;
}

export class Monitor extends EventEmitter {
  readonly events: EventLog;
  readonly startedAt = Date.now();
  private entries = new Map<string, Entry>();
  private stopped = false;

  constructor(private config: Config, dataDir?: string, driverFactory: (p: ProcessorConfig) => Driver | undefined = driverFor) {
    super();
    this.events = new EventLog(dataDir);
    for (const p of config.processors) this.add(p, driverFactory(p));
  }

  /** Adds a processor and starts polling it. */
  add(p: ProcessorConfig, driver: Driver | undefined = driverFor(p)): void {
    if (this.entries.has(p.id)) throw new Error(`A processor with id "${p.id}" is already monitored.`);
    const view: ProcessorView = {
      id: p.id,
      name: p.name ?? p.host,
      kind: p.kind,
      host: p.host,
      reachable: false,
      missedPolls: 0,
      temperatures: [],
      fans: [],
      inputs: [],
      loops: [],
      severity: 'unknown',
      alerts: [],
      lastError: driver ? undefined : PHASE_NOTE[p.kind],
    };
    this.entries.set(p.id, { config: p, driver, view, loopsSeen: new Set() });
  }

  start(): void {
    this.stopped = false;
    let i = 0;
    for (const entry of this.entries.values()) {
      if (!entry.driver) continue;
      // Spread the first polls out a little so a big show network is not hit all at once.
      const delay = Math.min(i++ * 150, this.config.pollIntervalMs);
      entry.timer = setTimeout(() => void this.pollLoop(entry), delay);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      clearTimeout(e.timer);
      e.inFlight?.abort();
    }
  }

  state(): DashboardState {
    const processors = [...this.entries.values()].map((e) => e.view);
    return {
      version: APP_VERSION,
      startedAt: this.startedAt,
      severity: worstSeverity(processors.filter((p) => p.severity !== 'unknown').map((p) => p.severity)),
      processors,
      events: this.events.recent(100),
    };
  }

  /** Polls one processor once. Exposed for tests; the loop calls it on a timer. */
  async pollOnce(id: string): Promise<ProcessorView> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No processor "${id}"`);
    await this.poll(entry);
    return entry.view;
  }

  private async pollLoop(entry: Entry): Promise<void> {
    if (this.stopped) return;
    await this.poll(entry);
    if (this.stopped) return;
    entry.timer = setTimeout(() => void this.pollLoop(entry), this.config.pollIntervalMs);
  }

  private async poll(entry: Entry): Promise<void> {
    if (!entry.driver) return;
    const ctrl = new AbortController();
    entry.inFlight = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
    const prev = entry.view;
    let snap: ProcessorSnapshot;
    try {
      const data = await entry.driver.poll(ctrl.signal);
      const { reportedName, ...rest } = data;
      snap = {
        ...rest,
        id: entry.config.id,
        kind: entry.config.kind,
        host: entry.config.host,
        name: entry.config.name ?? reportedName ?? entry.config.host,
        reachable: true,
        lastSeen: Date.now(),
        missedPolls: 0,
      };
    } catch (err) {
      const message = ctrl.signal.aborted ? `no answer within ${this.config.requestTimeoutMs / 1000} s` : errorText(err);
      // Keep the last known readings on screen, marked unreachable.
      snap = { ...stripView(prev), reachable: false, lastError: message, missedPolls: prev.missedPolls + 1 };
    } finally {
      clearTimeout(timeout);
      entry.inFlight = undefined;
    }

    const extra = loopAlerts(snap, entry.loopsSeen);
    const { alerts, severity } = evaluate(snap, this.config.thresholds, prev.alerts, Date.now(), extra);
    entry.view = { ...snap, alerts, severity };
    this.logChanges(entry.view, prev);
    this.emit('change', entry.view);
  }

  private logChanges(now: ProcessorView, before: ProcessorView): void {
    const name = now.name;
    if (now.reachable && before.lastSeen === undefined) {
      this.events.add({ processorId: now.id, level: 'info', message: `${name}: connected (${now.model ?? now.kind}, ${now.firmware ?? 'firmware unknown'})` });
    } else if (now.reachable && !before.reachable && before.missedPolls > 0) {
      this.events.add({ processorId: now.id, level: 'ok', message: `${name}: responding again` });
    }
    const was = new Map(before.alerts.map((a) => [a.key, a]));
    const is = new Map(now.alerts.map((a) => [a.key, a]));
    for (const a of now.alerts) {
      const old = was.get(a.key);
      if (!old || old.severity !== a.severity) {
        this.events.add({ processorId: now.id, level: a.severity, message: `${name}: ${a.message}` });
      }
    }
    for (const a of before.alerts) {
      if (!is.has(a.key)) this.events.add({ processorId: now.id, level: 'ok', message: `${name}: cleared, ${lowerFirst(a.message)}` });
    }
    if (now.reachable && before.reachable && now.preset && before.preset && now.preset.number !== before.preset.number) {
      this.events.add({ processorId: now.id, level: 'info', message: `${name}: preset ${now.preset.number} "${now.preset.name}" loaded` });
    }
  }
}

function stripView(v: ProcessorView): ProcessorSnapshot {
  const { alerts: _a, severity: _s, ...snap } = v;
  return snap;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') return 'connection refused (is IP control enabled?)';
    if (cause?.code === 'EHOSTUNREACH' || cause?.code === 'ENETUNREACH') return 'host unreachable';
    if (cause?.code) return `${cause.code}`;
    return err.message;
  }
  return String(err);
}

export type { Alert };
