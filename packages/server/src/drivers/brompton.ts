// Brompton Tessera (SX40, S8 and others) over its HTTP IP control API, checked against Tessera 3.5.2.
//
// GET http://<ip>/api/ returns the whole property tree as JSON under a top-level "api" key, and the driver reads
// everything it needs from that one request. Writes are GET /api/<path>?set=<value>, as the Bitfocus Companion module
// for Tessera sends them; the paths below come from that module. The tree's shape is documented by the processor
// itself at /api/?help=1.
import type {
  CableLoop,
  ControlRequest,
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
  const set = async (path: string, value: string, signal: AbortSignal) => {
    const res = await fetch(`${base}/api/${path}?set=${encodeURIComponent(value)}`, { signal });
    if (!res.ok) throw new Error(`The processor refused ${path} (HTTP ${res.status}).`);
  };
  return {
    async poll(signal) {
      const res = await fetch(`${base}/api/`, { signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/`);
      const body = (await res.json()) as unknown;
      return parseTessera(body);
    },
    capabilities: {
      brightness: { min: 0, max: 10000, step: 50, unit: 'nits' },
      blackout: true,
      freeze: true,
      preset: true,
      input: true,
      failover: true,
      reboot: true,
    },
    async control(req, signal) {
      for (const [path, value] of bromptonCommands(req)) await set(path, value, signal);
    },
  };
}

/** The ?set= requests for one control, in the order they are sent. */
export function bromptonCommands(req: ControlRequest): [string, string][] {
  switch (req.action) {
    case 'brightness':
      return [['output/global-colour/brightness', String(Math.round(req.value))]];
    case 'blackout':
      return [['override/blackout/enabled', String(req.value)]];
    case 'freeze':
      return [['override/freeze/enabled', String(req.value)]];
    case 'preset':
      return [['presets/active/number', String(Math.round(req.value))]];
    case 'input': {
      const [type, number] = req.value.split(':');
      if (!type || !number || !/^\d+$/.test(number)) throw new Error(`Unknown input "${req.value}".`);
      return [
        ['input/active/source/port-type', type],
        ['input/active/source/port-number', number],
      ];
    }
    case 'failover':
      return [['output/network/failover/actions/request-failover', '']];
    case 'reboot':
      return [['system/actions/reboot', '']];    default:
      throw new Error(`Tessera processors do not take "${req.action}" from this dashboard.`);
  }
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
    // Tessera says preset "0" with no name when no preset has been loaded since the project opened.
    preset:
      (num(activePreset.number) ?? 0) > 0 ? { number: num(activePreset.number)!, name: str(activePreset.name) ?? '' } : undefined,
    blackout: bool(obj(override.blackout).enabled),
    freeze: bool(obj(override.freeze).enabled),
    failover: parseFailover(obj(network.failover)),
    loops: parseLoops(obj(obj(network['cable-redundancy']).loops)),
    tiles: parseTiles(obj(api.devices)),
    devices: parseBoxes(obj(api.devices)),
    presets: entries(presets.items)
      .map(([n, p]) => ({ number: num(obj(p).number) ?? Number(n), name: str(obj(p).name) ?? `Preset ${n}` }))
      .filter((p) => Number.isFinite(p.number))
      .sort((a, b) => a.number - b.number),
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

/**
 * Tessera 3.5.2 reports uptime as "2h 43m 1s" (parts that add up). Older releases were seen giving the same span in
 * every unit, "50d 1215h 71607m 4294997s", where the seconds alone are the whole span. Both are read here.
 */
export function parseUptime(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const part = (u: string) => {
    const m = new RegExp(`(\\d+)\\s*${u}\\b`).exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const [d, h, m, s] = [part('d'), part('h'), part('m'), part('s')];
  if ([d, h, m, s].every((x) => x === undefined)) return undefined;
  // Each unit repeating the whole span shows as an hours or minutes or seconds figure past its normal range.
  if ((s ?? 0) >= 60 || (m ?? 0) >= 60 || (h ?? 0) >= 24) return s ?? (m !== undefined ? m * 60 : h !== undefined ? h * 3600 : (d ?? 0) * 86400);
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
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
      // Ports are listed from "0", while the active source and the front panel count from 1 (seen on 3.5.2).
      const number = Number(n) + 1;
      out.push({
        label: `${INPUT_TYPES[type] ?? type.toUpperCase()} ${number}`,
        key: `${type}:${number}`,
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

/**
 * Tessera 3.5.2 has one loop entry per pair of distribution boxes, and its state lists every chain on it, e.g.
 * "no-loop-found: C1->No connection, loop-found: C4->D4". Each chain becomes its own CableLoop, keyed by its port.
 */
export function parseLoops(loops: Tree): CableLoop[] {
  const out: CableLoop[] = [];
  for (const [i, loop] of entries(loops)) {
    const index = Number(i);
    const text = str(obj(loop).state) ?? '';
    // Tessera's help lists the states loop-found, no-loop-found, incorrect-loop-found and one-to-many-error.
    const parts = text.split(/,\s*(?=(?:(?:no-|incorrect-)?loop-found|one-to-many-error))/i).map((x) => x.trim()).filter(Boolean);
    parts.forEach((state, n) => {
      const m = /^((?:no-|incorrect-)?loop-found|one-to-many-error):\s*([A-Za-z]+\d+)?\s*(?:->\s*([A-Za-z]+\d+))?/i.exec(state);
      const found = !!m && m[1].toLowerCase() === 'loop-found';
      const port = m?.[2]?.toUpperCase();
      // An incorrect loop names the port it wrongly reaches; keep it so the wall builder sees that port too.
      out.push({ index, key: `${index}:${port ?? `#${n}`}`, port, to: m?.[3]?.toUpperCase(), state, found });
    });
  }
  return out.sort((a, b) => a.index - b.index || (a.port ?? '').localeCompare(b.port ?? '', undefined, { numeric: true }));
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
