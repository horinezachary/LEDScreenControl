// Polls every processor on its own timer, keeps the latest snapshot and alerts for each, and logs every change of
// state as an event. Listeners are told after each poll so the web layer can push the new state.
import { EventEmitter } from 'node:events';
import type { Alert, ControlRequest, DashboardState, ProcessorConfig, ProcessorSnapshot, ProcessorView, WallLayout, WallView } from '@ledmon/shared';
import { worstSeverity } from '@ledmon/shared';
import type { Config } from './config.js';
import type { Driver } from './drivers/types.js';
import { bromptonDriver } from './drivers/brompton.js';
import { vxproDriver } from './drivers/vxpro.js';
import { coexDriver } from './drivers/coex.js';
import { EventLog } from './events.js';
import { History } from './history.js';
import type { AlertChange } from './alerter.js';
import { evaluate, loopAlerts } from './rules.js';
import { Topology } from './topology.js';
import { APP_VERSION } from './version.js';

const PHASE_NOTE: Record<string, string> = {};


export function driverFor(p: ProcessorConfig): Driver | undefined {
  if (p.kind === 'brompton') return bromptonDriver(p);
  if (p.kind === 'coex') return coexDriver(p);
  if (p.kind === 'vxpro') return vxproDriver(p);
  return undefined;
}

interface Entry {
  config: ProcessorConfig;
  driver?: Driver;
  view: ProcessorView;
  loopsSeen: Map<string, string>;
  timer?: NodeJS.Timeout;
  inFlight?: AbortController;
  /** Added in code (the demo simulators) rather than from the settings, so a settings change leaves it alone. */
  extra: boolean;
  removed?: boolean;
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class Monitor extends EventEmitter {
  readonly events: EventLog;
  readonly history: History;
  readonly startedAt = Date.now();
  private entries = new Map<string, Entry>();
  private extraWalls: WallLayout[] = [];
  private topology = new Topology();
  private stopped = true;

  constructor(
    private config: Config,
    dataDir?: string,
    private driverFactory: (p: ProcessorConfig) => Driver | undefined = driverFor,
  ) {
    super();
    this.events = new EventLog(dataDir);
    this.history = new History(dataDir);
    for (const p of config.processors) this.add(p, driverFactory(p), false);
  }

  get settings(): Config {
    return this.config;
  }

  private get walls(): WallLayout[] {
    return [...this.config.walls, ...this.extraWalls];
  }

  /**
   * Applies new settings without a restart: processors that are gone stop being polled, new and changed ones start,
   * and thresholds, walls and the controls switch apply from the next poll. Demo processors stay.
   */
  reconfigure(config: Config): void {
    this.config = config;
    const wanted = new Map(config.processors.map((p) => [p.id, p]));
    for (const [id, e] of this.entries) {
      if (e.extra) continue;
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(e.config)) {
        this.drop(e);
        if (!next) this.history.forget(id);
      }
    }
    for (const p of config.processors) {
      if (this.entries.has(p.id)) continue;
      this.add(p, this.driverFactory(p), false);
      const e = this.entries.get(p.id)!;
      if (!this.stopped && e.driver) e.timer = setTimeout(() => void this.pollLoop(e), 0);
    }
    for (const e of this.entries.values()) e.view = { ...e.view, controls: this.config.controls ? e.driver?.capabilities : undefined };
    this.emit('change');
  }

  private drop(e: Entry): void {
    e.removed = true;
    clearTimeout(e.timer);
    e.inFlight?.abort();
    this.entries.delete(e.config.id);
  }

  /** Adds a processor (polled from the next start, or at once when already running). */
  add(p: ProcessorConfig, driver: Driver | undefined = driverFor(p), extra = true): void {
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
      lastError: driver ? undefined : (PHASE_NOTE[p.kind] ?? `No driver for ${p.kind} processors.`),
      controls: this.config.controls ? driver?.capabilities : undefined,
    };
    const entry: Entry = { config: p, driver, view, loopsSeen: new Map(), extra };
    this.entries.set(p.id, entry);
    if (extra && !this.stopped && driver) entry.timer = setTimeout(() => void this.pollLoop(entry), 0);
  }

  /** Adds a wall layout that is not in the settings, e.g. the demo wall for the simulated pair. */
  addWall(layout: WallLayout): void {
    this.extraWalls.push(layout);
  }

  /**
   * Sends one control command to a processor, logs it with who asked, then polls the processor so every screen
   * shows the result. Throws ControlError with a message for the person who pressed the button.
   */
  async control(id: string, req: ControlRequest, who: string): Promise<ProcessorView> {
    const entry = this.entries.get(id);
    if (!entry) throw new ControlError('No such processor.', 404);
    if (!this.config.controls) throw new ControlError('Controls are turned off in the settings.', 403);
    const caps = entry.driver?.capabilities;
    if (!entry.driver?.control || !caps || !caps[req.action]) throw new ControlError(`${entry.view.name} does not take "${req.action}" from this dashboard.`, 400);
    if (req.action === 'brightness' && caps.brightness) {
      const { min, max } = caps.brightness;
      if (!Number.isFinite(req.value) || req.value < min || req.value > max) throw new ControlError(`Brightness must be from ${min} to ${max}.`, 400);
    }
    if (req.action === 'input' && !entry.view.inputs.some((i) => i.key === req.value)) throw new ControlError('That input is not on this processor.', 400);
    if (req.action === 'preset' && entry.view.presets && !entry.view.presets.some((p) => p.number === req.value)) {
      throw new ControlError('That preset is not on this processor.', 400);
    }
    const what = describe(req, entry.view);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
    try {
      await entry.driver.control(req, ctrl.signal);
    } catch (err) {
      const msg = ctrl.signal.aborted ? `no answer within ${this.config.requestTimeoutMs / 1000} s` : (err as Error).message;
      this.events.add({ processorId: id, level: 'warning', source: 'control', message: `${entry.view.name}: ${what} failed (${msg}), asked from ${who}` });
      this.emit('change', entry.view);
      throw new ControlError(`${entry.view.name} did not accept it: ${msg}`, 502);
    } finally {
      clearTimeout(timeout);
    }
    this.events.add({ processorId: id, level: 'info', source: 'control', message: `${entry.view.name}: ${what}, from ${who}` });
    await this.poll(entry);
    return entry.view;
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
    this.history.close();
  }

  state(): DashboardState {
    const processors = [...this.entries.values()].map((e) => e.view);
    return {
      version: APP_VERSION,
      startedAt: this.startedAt,
      severity: worstSeverity(processors.filter((p) => p.severity !== 'unknown').map((p) => p.severity)),
      processors,
      walls: this.wallViews(),
      events: this.events.recent(100),
      limits: {
        tempWarnC: this.config.thresholds.tempWarnC,
        tempCritC: this.config.thresholds.tempCritC,
        portLoadWarnPercent: this.config.thresholds.portLoadWarnPercent,
      },
      controls: this.config.controls,
    };
  }

  wallViews(): WallView[] {
    return this.topology.build(this.walls, new Map([...this.entries].map(([id, e]) => [id, e.view])));
  }

  /** The processor whose address a syslog message came from, if any. */
  processorAt(address: string): ProcessorView | undefined {
    const ip = address.replace(/^::ffff:/, '');
    for (const e of this.entries.values()) if (e.config.host === ip) return e.view;
    return undefined;
  }

  /** Records a syslog line from a processor in the event log. */
  syslog(address: string, level: 'info' | 'warning' | 'critical', text: string): void {
    const p = this.processorAt(address);
    const who = p ? p.name : address.replace(/^::ffff:/, '');
    this.events.add({ processorId: p?.id, level, message: `${who} (syslog): ${text}`, source: 'syslog' });
    this.emit('change', p);
  }

  /** Polls one processor once. Exposed for tests; the loop calls it on a timer. */
  async pollOnce(id: string): Promise<ProcessorView> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No processor "${id}"`);
    await this.poll(entry);
    return entry.view;
  }

  private async pollLoop(entry: Entry): Promise<void> {
    if (this.stopped || entry.removed) return;
    await this.poll(entry);
    if (this.stopped || entry.removed) return;
    clearTimeout(entry.timer);
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

    if (entry.removed) return;
    const extra = loopAlerts(snap, entry.loopsSeen);
    const { alerts, severity } = evaluate(snap, this.config.thresholds, prev.alerts, Date.now(), extra);
    entry.view = { ...snap, alerts, severity, controls: this.config.controls ? entry.driver.capabilities : undefined };
    this.history.record(entry.view);
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
        this.emit('alert', { processorId: now.id, processorName: name, alert: a, change: 'raised' } satisfies AlertChange);
      }
    }
    for (const a of before.alerts) {
      if (!is.has(a.key)) {
        this.events.add({ processorId: now.id, level: 'ok', message: `${name}: cleared, ${lowerFirst(a.message)}` });
        this.emit('alert', { processorId: now.id, processorName: name, alert: a, change: 'cleared' } satisfies AlertChange);
      }
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

function describe(req: ControlRequest, p: ProcessorView): string {
  switch (req.action) {
    case 'brightness':
      return `brightness set to ${req.value}${(p.controls?.brightness?.unit ?? p.brightnessUnit) === '%' ? '%' : ' nits'}`;
    case 'blackout':
      return req.value ? 'blackout on' : 'blackout off';
    case 'freeze':
      return req.value ? 'freeze on' : 'freeze off';
    case 'preset': {
      const name = p.presets?.find((x) => x.number === req.value)?.name;
      return `preset ${req.value}${name ? ` "${name}"` : ''} loaded`;
    }
    case 'input':
      return `input switched to ${p.inputs.find((i) => i.key === req.value)?.label ?? req.value}`;
    case 'failover':
      return 'failover requested';
    case 'reboot':
      return 'reboot requested';
  }
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
