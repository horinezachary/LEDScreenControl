// A stand-in for a Brompton Tessera processor, for building and demos without hardware. It answers GET /api/ with a
// property tree shaped like Tessera 3.5.2's, with readings that drift a little on every request.
//
// Faults can be switched on to see how the dashboard reacts:
//   GET /sim/scenario?set=<name>   names: normal, signal-loss, fan-failure, hot, tiles-offline, loop-broken,
//                                         partner-lost, failover
// /sim/ exists only on the simulator; a real processor has nothing there.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WallLayout } from '@ledmon/shared';

export const SCENARIOS = ['normal', 'signal-loss', 'fan-failure', 'hot', 'tiles-offline', 'loop-broken', 'partner-lost', 'failover'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface SimOptions {
  name: string;
  serial: string;
  role: 'primary' | 'backup';
  partnerName: string;
  partnerSerial: string;
  tiles?: number;
  /** For tests: a fixed seed makes the drift repeatable. */
  seed?: number;
}

const PRESETS = ['Show Config', 'Rehearsal', 'Walk-in', 'Test'];

export class TesseraSimulator {
  scenario: Scenario = 'normal';
  /** Every ?set= request received, as [path, value], for tests. The simulator applies the ones it knows. */
  readonly writes: [string, string][] = [];
  brightness = 1500;
  blackout = false;
  freeze = false;
  preset = 1;
  input = { type: 'sdi', number: 1 };
  /** Set by a request-failover command; the scenario 'failover' also forces it on. */
  failedOver = false;
  private server?: http.Server;
  private rand: () => number;
  private started = Date.now();

  constructor(readonly options: SimOptions) {
    this.rand = mulberry32(options.seed ?? (Number(options.serial) || 1));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://sim');
    if (url.pathname === '/sim/scenario') {
      const name = url.searchParams.get('set') as Scenario | null;
      if (name && (SCENARIOS as readonly string[]).includes(name)) {
        this.scenario = name;
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`scenario: ${name}\n`);
      } else {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Use ?set= with one of: ${SCENARIOS.join(', ')}\n`);
      }
      return;
    }
    if (url.searchParams.has('set') && url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice('/api/'.length);
      const value = url.searchParams.get('set') ?? '';
      this.writes.push([path, value]);
      if (!this.apply(path, value)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown property\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (url.pathname === '/api/' || url.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.tree()));
      return;
    }
    res.writeHead(404).end();
  }

  private apply(path: string, value: string): boolean {
    switch (path) {
      case 'output/global-colour/brightness':
        this.brightness = Number(value);
        return true;
      case 'override/blackout/enabled':
        this.blackout = value === 'true';
        return true;
      case 'override/freeze/enabled':
        this.freeze = value === 'true';
        return true;
      case 'presets/active/number':
        this.preset = Number(value);
        return true;
      case 'input/active/source/port-type':
        this.input = { ...this.input, type: value };
        return true;
      case 'input/active/source/port-number':
        this.input = { ...this.input, number: Number(value) };
        return true;
      case 'output/network/failover/actions/request-failover':
        this.failedOver = !this.failedOver;
        return true;
      case 'system/actions/reboot':
        this.started = Date.now();
        return true;
      default:
        return false;
    }
  }

  private loops(): Record<string, { state: string }> {
    return demoLoopStates(this.scenario === 'loop-broken');
  }

  /** The /api/ tree for the current scenario. */
  tree(): unknown {
    const o = this.options;
    const s = this.scenario;
    const jitter = (base: number, spread: number) => Math.round((base + (this.rand() - 0.5) * spread) * 10) / 10;
    const hot = s === 'hot' ? 22 : 0;
    const tiles = o.tiles ?? DEMO_TILES;
    const offline = s === 'tiles-offline' ? Math.round(tiles * 0.08) : 0;
    const signal = s !== 'signal-loss';
    const failedOver = s === 'failover' || this.failedOver;
    const partnerLost = s === 'partner-lost';
    const uptime = Math.round((Date.now() - this.started) / 1000) + 86400 * 3;
    const sdi = (w: number, h: number, r: number) => ({ 'meta-data': { resolution: { width: w, height: h }, 'refresh-rate': r } });
    const none = { 'meta-data': { resolution: { width: -1, height: -1 }, 'refresh-rate': -1 } };

    return {
      api: {
        system: {
          'processor-name': o.name,
          'processor-type': 'sx40',
          'serial-number': o.serial,
          'software-version': '3.5.2.15',
          uptime: `${Math.floor(uptime / 86400)}d ${Math.floor(uptime / 3600)}h ${Math.floor(uptime / 60)}m ${uptime}s`,
          temperature: {
            ambient: jitter(31 + hot / 2, 1),
            cpu: jitter(51 + hot, 2),
            dsp: jitter(58 + hot, 2),
            fpga: jitter(54 + hot, 2),
            gpu: jitter(61 + hot, 2),
            main: jitter(46 + hot, 1.5),
            psu: jitter(42 + hot / 2, 1),
            front: jitter(35, 1),
            rear: jitter(39 + hot / 2, 1),
            ethernet: {
              copper: { a: jitter(39, 1), b: jitter(39, 1) },
              sfp: { a: jitter(40, 1), b: jitter(40, 1), c: jitter(41, 1), d: jitter(41, 1) },
            },
          },
          fan: {
            case: {
              one: { speed: jitter(2100, 60), status: true },
              two: s === 'fan-failure' ? { speed: 0, status: false } : { speed: jitter(2080, 60), status: true },
            },
            fpga: { speed: jitter(2800, 80), status: true },
          },
        },
        project: { name: 'Show Config' },
        input: {
          active: { source: { 'port-type': this.input.type, 'port-number': this.input.number } },
          ports: {
            sdi: { '1': signal ? sdi(3840, 2160, 59.94) : none, '2': sdi(1920, 1080, 59.94) },
            hdmi: { '1': none },
            dvi: { '1': none },
          },
        },
        output: {
          'global-colour': { brightness: this.brightness },
          network: {
            genlock: { source: 'input', 'internal-rate': 59.94 },
            failover: {
              settings: { enabled: true, role: o.role },
              state: {
                'is-active': failedOver,
                'is-partner-present': !partnerLost,
                'partner-name': o.partnerName,
                'partner-serial': o.partnerSerial,
                'partner-absence-duration': partnerLost ? Math.round((Date.now() - this.started) / 1000) : 0,
              },
            },
            'cable-redundancy': { loops: this.loops() },
          },
        },
        override: { blackout: { enabled: this.blackout }, freeze: { enabled: this.freeze } },
        presets: {
          active: { number: this.preset, name: PRESETS[this.preset - 1] ?? `Preset ${this.preset}` },
          items: Object.fromEntries(PRESETS.map((name, i) => [String(i + 1), { number: i + 1, name }])),
        },
        devices: {
          statistics: { 'associated-count': tiles, 'online-count': tiles - offline, 'error-count': 0 },
          items: {
            ...Object.fromEntries(['A', 'B', 'C', 'D'].map((x) => [`XD-${x}-DEMO`, { firmware: '3.5.2', type: 'XD', online: true }])),
            [`${o.serial}-T1`]: { firmware: '3.5.2', type: 'RM1.5' },
          },
        },
      },
    };
  }
}

/** Loop states: chains between XD A and B, and between C and D, one per port, as on the demo wall. */
function demoLoopStates(broken: boolean): Record<string, { state: string }> {
  const out: Record<string, { state: string }> = {};
  let i = 0;
  for (const [a, b] of [['A', 'B'], ['C', 'D']]) {
    for (let port = 1; port <= 10; port++) {
      // The loop-broken scenario breaks the chain on A4 to B4.
      const lost = broken && a === 'A' && port === 4;
      out[String(i++)] = { state: lost ? 'no-loop-found: No connection' : `loop-found: ${a}${port}->${b}${port}` };
    }
  }
  return out;
}

/** A small seeded random number generator, so tests can repeat the drift. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The demo wall: 2 pairs of XD boxes, 10 chains of 8 tiles between each pair. */
export const DEMO_CHAINS = Array.from({ length: 10 }, () => 8);
export const DEMO_TILES = DEMO_CHAINS.reduce((a, b) => a + b, 0) * 2;

export function demoWall(primaryId: string, backupId: string): WallLayout {
  // The same XD boxes are seen by both processors, as on a real redundant wall.
  const box = (x: string) => ({ name: `XD ${x}`, trunk: x, ports: 10, serial: `XD-${x}-DEMO` });
  return {
    id: 'demo-wall',
    name: 'Main stage wall (simulated)',
    primary: primaryId,
    backup: backupId,
    groups: [
      { left: box('A'), right: box('B'), chains: DEMO_CHAINS },
      { left: box('C'), right: box('D'), chains: DEMO_CHAINS },
    ],
  };
}

/** The pair the dashboard shows with --simulate: a primary and its backup, as in a normal SX40 redundant setup. */
export async function startDemoPair(): Promise<{ sims: TesseraSimulator[]; ports: number[] }> {
  const main = new TesseraSimulator({ name: 'Stage Main (simulated)', serial: '900001', role: 'primary', partnerName: 'Stage Backup (simulated)', partnerSerial: '900002' });
  const backup = new TesseraSimulator({ name: 'Stage Backup (simulated)', serial: '900002', role: 'backup', partnerName: 'Stage Main (simulated)', partnerSerial: '900001' });
  const ports = [await main.listen(), await backup.listen()];
  return { sims: [main, backup], ports };
}
