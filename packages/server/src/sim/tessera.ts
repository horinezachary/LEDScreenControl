// A stand-in for a Brompton Tessera processor, for building and demos without hardware. It answers GET /api/ with a
// property tree shaped like Tessera 3.5.2's, with readings that drift a little on every request.
//
// Faults can be switched on to see how the dashboard reacts:
//   GET /sim/scenario?set=<name>   names: normal, signal-loss, fan-failure, hot, tiles-offline, loop-broken,
//                                         partner-lost, failover
// /sim/ exists only on the simulator; a real processor has nothing there.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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

export class TesseraSimulator {
  scenario: Scenario = 'normal';
  private server?: http.Server;
  private rand: () => number;
  private readonly started = Date.now();

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
    if (url.pathname === '/api/' || url.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.tree()));
      return;
    }
    res.writeHead(404).end();
  }

  /** The /api/ tree for the current scenario. */
  tree(): unknown {
    const o = this.options;
    const s = this.scenario;
    const jitter = (base: number, spread: number) => Math.round((base + (this.rand() - 0.5) * spread) * 10) / 10;
    const hot = s === 'hot' ? 22 : 0;
    const tiles = o.tiles ?? 640;
    const offline = s === 'tiles-offline' ? Math.round(tiles * 0.08) : 0;
    const signal = s !== 'signal-loss';
    const failedOver = s === 'failover';
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
          active: { source: { 'port-type': 'sdi', 'port-number': 1 } },
          ports: {
            sdi: { '1': signal ? sdi(3840, 2160, 59.94) : none, '2': none },
            hdmi: { '1': none },
            dvi: { '1': none },
          },
        },
        output: {
          'global-colour': { brightness: 1500 },
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
            'cable-redundancy': {
              loops: {
                '0': { state: s === 'loop-broken' ? 'no-loop-found: No connection' : 'loop-found: A1->B1' },
                '1': { state: 'loop-found: C1->D1' },
                '2': { state: 'no-loop-found: No connection' },
                '3': { state: 'no-loop-found: No connection' },
              },
            },
          },
        },
        override: { blackout: { enabled: false }, freeze: { enabled: false } },
        presets: { active: { number: 1, name: 'Show Config' } },
        devices: {
          statistics: { 'associated-count': tiles, 'online-count': tiles - offline, 'error-count': 0 },
          items: { [`${o.serial}-XD-A`]: { firmware: '3.5.2', type: 'XD' }, [`${o.serial}-T1`]: { firmware: '3.5.2', type: 'RM1.5' } },
        },
      },
    };
  }
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

/** The pair the dashboard shows with --simulate: a primary and its backup, as in a normal SX40 redundant setup. */
export async function startDemoPair(): Promise<{ sims: TesseraSimulator[]; ports: number[] }> {
  const main = new TesseraSimulator({ name: 'Stage Main (simulated)', serial: '900001', role: 'primary', partnerName: 'Stage Backup (simulated)', partnerSerial: '900002' });
  const backup = new TesseraSimulator({ name: 'Stage Backup (simulated)', serial: '900002', role: 'backup', partnerName: 'Stage Main (simulated)', partnerSerial: '900001' });
  const ports = [await main.listen(), await backup.listen()];
  return { sims: [main, backup], ports };
}
