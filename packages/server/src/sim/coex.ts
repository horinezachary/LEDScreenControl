// A stand-in for a NovaStar COEX processor (MX40 Pro), for building and demos without hardware. It answers the GET
// endpoints the driver reads, shaped as NovaStar's API documentation shows them, for one screen of 256×256 cabinets
// on 8 output ports.
//
//   GET /sim/scenario?set=<name>   names: normal, signal-loss, cabinet-offline, cabinet-hot, link-broken,
//                                         fan-failure, port-overload, port-down, vmp-busy
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const COEX_SCENARIOS = [
  'normal',
  'signal-loss',
  'cabinet-offline',
  'cabinet-hot',
  'link-broken',
  'fan-failure',
  'port-overload',
  'port-down',
  'vmp-busy',
] as const;
export type CoexScenario = (typeof COEX_SCENARIOS)[number];

export interface CoexSimOptions {
  name: string;
  serial: string;
  model?: string;
  /** Cabinets on each output port, port 1 first. */
  ports?: number[];
  seed?: number;
}

const CAB = 256;

export class CoexSimulator {
  scenario: CoexScenario = 'normal';
  /** Errors counted by the first cabinet's receiving card, a counter that only grows like a real one's. */
  cardErrors = 0;
  /** Every control request received, for tests. The simulator applies brightness, display mode and presets. */
  readonly writes: { method: string; path: string; body: unknown }[] = [];
  brightness = 0.8;
  displayMode = 0;
  preset = 1;
  source = 0;
  private server?: http.Server;
  private rand: () => number;
  private readonly started = Date.now();

  constructor(readonly options: CoexSimOptions) {
    let a = (options.seed ?? Number(options.serial)) >>> 0 || 1;
    this.rand = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private ports(): number[] {
    const p = [...(this.options.ports ?? [8, 8, 8, 8, 8, 8, 8, 8])];
    if (this.scenario === 'port-overload') p[6] = 10;
    return p;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const send = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const ok = (data: unknown): void => send({ code: 0, data, message: 'success' });

    if (url.pathname === '/sim/scenario') {
      const name = url.searchParams.get('set') as CoexScenario | null;
      if (name && (COEX_SCENARIOS as readonly string[]).includes(name)) {
        this.scenario = name;
        if (name === 'normal') this.source = 0;
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`scenario: ${name}\n`);
      } else {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Use ?set= with one of: ${COEX_SCENARIOS.join(', ')}\n`);
      }
      return;
    }
    if (this.scenario === 'vmp-busy' && url.pathname.startsWith('/api/')) {
      send({ code: 2, data: null, message: 'Device is occupied' });
      return;
    }
    if (req.method !== 'GET') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        send({ code: 1, data: null, message: 'bad json' }, 400);
        return;
      }
      this.writes.push({ method: req.method ?? '', path: url.pathname, body });
      const b = body as Record<string, unknown>;
      if (url.pathname === '/api/v1/screen/brightness' && typeof b.brightness === 'number') this.brightness = b.brightness;
      else if (url.pathname === '/api/v1/screen/output/displaymode' && typeof b.value === 'number') this.displayMode = b.value;
      else if (url.pathname === '/api/v1/preset/current/update' && typeof b.sequenceNumber === 'number') this.preset = b.sequenceNumber;
      else if (url.pathname === '/api/v1/screen/layer/input' && Array.isArray(b.layers)) this.source = Number((b.layers[0] as { source?: string }).source ?? 0);
      ok({});
      return;
    }
    switch (url.pathname) {
      case '/api/v1/device/hw':
        return ok({
          name: this.options.model ?? 'MX40 Pro',
          customName: this.options.name,
          modelID: 1,
          sn: this.options.serial,
          type: this.options.model ?? 'MX40 Pro',
          hwVersion: '1.0',
          swVersion: 'V1.5.2',
          uptime: Math.round((Date.now() - this.started) / 1000) + 86400 * 2,
        });
      case '/api/v1/device/monitor/info':
        return ok(this.monitor());
      case '/api/v1/screen':
        return ok(this.screen());
      case '/api/v1/device/input/sources':
        return ok(this.sources());
      case '/api/v1/screen/displayparams':
        return send({ list: { screenId: 0, brightness: this.brightness, colorTemperature: 6500, gamma: 2.2 } });
      case '/api/v1/screen/output/display/state':
        return send({ mappingState: [{ canvasID: 0, enable: true }], displayState: [{ canvasID: 0, displayMode: this.displayMode }] });
      case '/api/v1/preset':
        return send({
          screenPresetList: [
            {
              screenID: 'screen-1',
              presetList: [1, 2, 3].map((n) => ({ sequenceNumber: n, name: ['Show', 'Rehearsal', 'Walk-in'][n - 1], state: n === this.preset })),
            },
          ],
        });
      case '/api/v1/device/backup':
        return ok({ master: '', backup: '', masterName: '', backupName: '' });
      default:
        send({ code: 404, data: null, message: 'not found' }, 404);
    }
  }

  private cabinets(): { id: number; port: number; index: number; x: number; y: number }[] {
    const out: { id: number; port: number; index: number; x: number; y: number }[] = [];
    let id = 0;
    this.ports().forEach((count, port) => {
      for (let i = 0; i < count; i++) {
        // Serpentine columns: each port feeds one column, up then down.
        const row = port % 2 === 0 ? i : count - 1 - i;
        out.push({ id: id++, port, index: i, x: port * CAB, y: row * CAB });
      }
    });
    return out;
  }

  screen(): unknown {
    return {
      screens: [
        {
          screenID: 'screen-1',
          screenName: `${this.options.name.replace(/ \(simulated\)$/, '')} screen`,
          workingMode: 0,
          layersInWorkingMode: [{ layers: [{ id: 0, layerIndex: 0, source: this.source }] }],
          canvases: [
            {
              canvasID: 0,
              size: { width: this.ports().length * CAB, height: Math.max(...this.ports()) * CAB },
              cabinets: this.cabinets().map((c) => ({
                cabinetID: c.id,
                connectID: c.index,
                outputID: c.port,
                position: { x: c.x, y: c.y },
                size: { width: CAB, height: CAB },
                angle: 0,
              })),
            },
          ],
        },
      ],
    };
  }

  sources(): unknown {
    const signal = this.scenario !== 'signal-loss';
    return [
      { id: 0, name: 'HDMI 1', type: 1, actualResolution: signal ? { width: 1920, height: 1080 } : { width: 0, height: 0 }, actualRefreshRate: signal ? 59.94 : 0 },
      { id: 1, name: 'DP 1', type: 2, actualResolution: { width: 3840, height: 2160 }, actualRefreshRate: 50 },
    ];
  }

  monitor(): unknown {
    const j = (base: number, spread: number) => Math.round((base + (this.rand() - 0.5) * spread) * 10) / 10;
    const s = this.scenario;
    const cabs = this.cabinets().filter((c) => !(s === 'cabinet-offline' && c.port === 2 && c.index >= 4));
    return {
      name: this.options.name,
      runtime: Math.round((Date.now() - this.started) / 1000),
      backupStatus: 0,
      mainBoardTemperature: { value: j(44, 2), status: 0 },
      mainBoardVoltage: { value: j(12, 0.1), status: 0 },
      fanInfos: [
        { fanSpeed: j(2400, 80), fanType: 0, status: 0 },
        s === 'fan-failure' ? { fanSpeed: 0, fanType: 0, status: 1 } : { fanSpeed: j(2380, 80), fanType: 0, status: 0 },
      ],
      temperatureInfos: [{ temperature: j(39, 2), temperatureType: 0, status: 0 }],
      controllerPortMonitorInfos: this.ports().map((_, i) => ({ controllerPortID: i, status: 0 })),
      outputStatus: this.ports().map((_, i) => ({ outputID: i, type: 0, status: s === 'port-down' && i === 5 ? 1 : 0, outputCardID: 0 })),
      cabinets: cabs.map((c) => {
        const hot = s === 'cabinet-hot' && c.port === 4 && c.index === 3;
        const linkDown = s === 'link-broken' && c.port === 1 && c.index === 4;
        const temp = hot ? j(71, 1) : j(36, 3);
        return {
          CabinetID: c.id,
          rvCardID: 0,
          outPutID: c.port,
          index: c.index,
          temperature: { value: temp, status: hot ? 1 : 0 },
          voltage: { value: j(5, 0.1), status: 0 },
          powerInfo: [{ number: 1, status: 0 }],
          rvCards: [
            {
              cabinetID: c.id,
              rvCardID: 0,
              netPortIndex: c.port,
              cabinetIndex: c.index,
              temperature: { value: temp, status: hot ? 1 : 0 },
              voltage: { value: j(5, 0.1), status: 0 },
              errorBit: [{ value: c.port === 0 && c.index === 0 ? this.cardErrors : 0, type: 0, status: c.port === 0 && c.index === 0 && this.cardErrors > 0 ? 1 : 0 }],
              backupStatus: { mode: 0, status: 0 },
              nextCabinetLinkStatus: { linkStatus: !linkDown, status: linkDown ? 1 : 0 },
            },
          ],
        };
      }),
    };
  }
}

export async function startDemoCoex(): Promise<{ sim: CoexSimulator; port: number }> {
  const sim = new CoexSimulator({ name: 'IMAG Left (simulated)', serial: '700001' });
  return { sim, port: await sim.listen() };
}
