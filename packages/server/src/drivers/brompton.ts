// Brompton Tessera (SX40, S8 and others) over its HTTP IP control API, checked against Tessera 3.5.2.
//
// GET http://<ip>/api/ returns the whole property tree as JSON under a top-level "api" key, and the driver reads
// everything it needs from that one request. Writes are GET /api/<path>?set=<value>; this phase is read-only, so the
// driver sends none. The tree's shape is documented by the processor itself at /api/?help=1.
import type {
  CableLoop,
  DeviceInfo,
  FailoverStatus,
  FanStatus,
  InputStatus,
  ProcessorConfig,
  Reading,
  TileSummary,
} from '@ledmon/shared';
import type { Driver, PolledData } from './types.js';

type Tree = Record<string, unknown>;

export function bromptonDriver(config: ProcessorConfig): Driver {
  const base = `http://${config.host}:${config.port ?? 80}`;
  return {
    async poll(signal) {
      const res = await fetch(`${base}/api/`, { signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/`);
      const body = (await res.json()) as unknown;
      return parseTessera(body);
    },
  };
}

/** Turns a Tessera /api/ response into the shared snapshot shape. Missing parts are left out rather than guessed. */
export function parseTessera(body: unknown): PolledData {
  const api = obj(obj(body).api);
  if (Object.keys(api).length === 0) throw new Error('The response has no "api" tree. Is IP control enabled on the processor?');
  const system = obj(api.system);
  const output = obj(api.output);
  const network = obj(output.network);
  const presets = obj(api.presets);
  const activePreset = obj(presets.active);
  const override = obj(api.override);
  const genlock = obj(network.genlock);

  return {
    reportedName: str(system['processor-name']),
    model: modelName(str(system['processor-type'])),
    serial: str(system['serial-number']),
    firmware: str(system['software-version']),
    uptimeSeconds: parseUptime(str(system.uptime)),
    project: str(obj(api.project).name),
    temperatures: parseTemperatures(obj(system.temperature)),
    fans: parseFans(obj(system.fan)),
    inputs: parseInputs(obj(api.input)),
    genlock: str(genlock.source) ? { source: str(genlock.source)!, rate: num(genlock['internal-rate']) } : undefined,
    brightness: num(obj(output['global-colour']).brightness),
    preset:
      num(activePreset.number) !== undefined
        ? { number: num(activePreset.number)!, name: str(activePreset.name) ?? '' }
        : undefined,
    blackout: bool(obj(override.blackout).enabled),
    freeze: bool(obj(override.freeze).enabled),
    failover: parseFailover(obj(network.failover)),
    loops: parseLoops(obj(obj(network['cable-redundancy']).loops)),
    tiles: parseTiles(obj(api.devices)),
    devices: parseBoxes(obj(api.devices)),
  };
}

function isBox(type: string | undefined): boolean {
  return !!type && /^(XD|DX|TD)/i.test(type);
}

/** Distribution boxes only (XD and the like); tiles are counted in parseTiles, not listed, to keep the state small. */
function parseBoxes(devices: Tree): DeviceInfo[] | undefined {
  const out: DeviceInfo[] = [];
  for (const [id, d] of entries(devices.items)) {
    const type = str(obj(d).type);
    if (!type || !isBox(type)) continue;
    const online = bool(obj(d).online);
    out.push({ id, type, firmware: str(obj(d).firmware), online });
  }
  return out.length ? out : undefined;
}

const MODEL_NAMES: Record<string, string> = { sx40: 'Tessera SX40', s8: 'Tessera S8', m2: 'Tessera M2', t1: 'Tessera T1' };

function modelName(type: string | undefined): string | undefined {
  if (!type) return undefined;
  return MODEL_NAMES[type.toLowerCase()] ?? `Tessera ${type.toUpperCase()}`;
}

/** Tessera reports uptime as e.g. "50d 1215h 71607m 4294997s": the same span in several units. The seconds are the most precise. */
export function parseUptime(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const secs = /(\d+)s\b/.exec(text);
  if (secs) return Number(secs[1]);
  const days = /(\d+)d\b/.exec(text);
  return days ? Number(days[1]) * 86400 : undefined;
}

/** Flattens the nested temperature object, e.g. ethernet.sfp.a -> "Ethernet SFP A". */
function parseTemperatures(tree: Tree, prefix: string[] = []): Reading[] {
  const out: Reading[] = [];
  for (const [k, v] of Object.entries(tree)) {
    const keyPath = [...prefix, k];
    if (typeof v === 'number') {
      out.push({ key: keyPath.join('.'), label: keyPath.map(labelWord).join(' '), value: v, unit: '°C' });
    } else if (v && typeof v === 'object') {
      out.push(...parseTemperatures(v as Tree, keyPath));
    }
  }
  return out;
}

const LABEL_WORDS: Record<string, string> = {
  cpu: 'CPU', gpu: 'GPU', dsp: 'DSP', fpga: 'FPGA', psu: 'PSU', sfp: 'SFP', one: '1', two: '2',
};

function labelWord(word: string): string {
  if (LABEL_WORDS[word]) return LABEL_WORDS[word];
  if (word.length === 1) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Fans are leaves with {speed, status}, nested under case.one, case.two, fpga. */
function parseFans(tree: Tree, prefix: string[] = []): FanStatus[] {
  const out: FanStatus[] = [];
  for (const [k, v] of Object.entries(tree)) {
    if (!v || typeof v !== 'object') continue;
    const node = v as Tree;
    const keyPath = [...prefix, k];
    if ('speed' in node || 'status' in node) {
      out.push({
        key: keyPath.join('-'),
        label: `${keyPath.map(labelWord).join(' ')} fan`,
        rpm: num(node.speed),
        running: bool(node.status) ?? true,
      });
    } else {
      out.push(...parseFans(node, keyPath));
    }
  }
  return out;
}

const INPUT_TYPES: Record<string, string> = { sdi: 'SDI', hdmi: 'HDMI', dvi: 'DVI', dp: 'DisplayPort', st2110: 'ST 2110' };

function parseInputs(input: Tree): InputStatus[] {
  const active = obj(obj(input.active).source);
  const activeType = str(active['port-type']);
  const activeNumber = num(active['port-number']);
  const out: InputStatus[] = [];
  for (const [type, ports] of Object.entries(obj(input.ports))) {
    for (const [n, port] of entries(ports)) {
      const meta = obj(obj(port)['meta-data']);
      const res = obj(meta.resolution);
      const width = num(res.width);
      const height = num(res.height);
      const rate = num(meta['refresh-rate']);
      // Tessera reports -1 for every field when nothing is plugged in or the signal is not locked.
      const signal = (width ?? -1) > 0 && (height ?? -1) > 0;
      const number = Number(n);
      out.push({
        label: `${INPUT_TYPES[type] ?? type.toUpperCase()} ${number}`,
        type,
        number,
        active: type === activeType && number === activeNumber,
        signal,
        width: signal ? width : undefined,
        height: signal ? height : undefined,
        rate: signal && rate !== undefined && rate > 0 ? rate : undefined,
      });
    }
  }
  return out;
}

function parseFailover(f: Tree): FailoverStatus | undefined {
  const settings = obj(f.settings);
  const state = obj(f.state);
  if (Object.keys(settings).length === 0 && Object.keys(state).length === 0) return undefined;
  return {
    enabled: bool(settings.enabled) ?? false,
    role: str(settings.role),
    active: bool(state['is-active']),
    partnerPresent: bool(state['is-partner-present']),
    partnerName: str(state['partner-name']) || undefined,
    partnerSerial: str(state['partner-serial']) || undefined,
    partnerAbsentSeconds: num(state['partner-absence-duration']),
  };
}

function parseLoops(loops: Tree): CableLoop[] {
  return entries(loops)
    .map(([i, loop]) => {
      const state = str(obj(loop).state) ?? '';
      return { index: Number(i), state, found: state.startsWith('loop-found') };
    })
    .sort((a, b) => a.index - b.index);
}

function parseTiles(devices: Tree): TileSummary | undefined {
  const stats = obj(devices.statistics);
  if (num(stats['associated-count']) === undefined) return undefined;
  const firmware: Record<string, number> = {};
  for (const [, d] of entries(devices.items)) {
    // Distribution boxes run their own firmware line, so they are left out of the tile firmware check.
    if (isBox(str(obj(d).type))) continue;
    const fw = str(obj(d).firmware);
    if (fw && fw !== 'unknown') firmware[fw] = (firmware[fw] ?? 0) + 1;
  }
  return {
    associated: num(stats['associated-count']) ?? 0,
    online: num(stats['online-count']) ?? 0,
    errors: num(stats['error-count']) ?? 0,
    firmware,
  };
}

// Small readers that never throw on a surprising shape.
function obj(v: unknown): Tree {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Tree) : {};
}
/** Entries of an object keyed by number ("0", "1"...) or of an array (1-based for arrays is not assumed). */
function entries(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  return Object.entries(obj(v));
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}
