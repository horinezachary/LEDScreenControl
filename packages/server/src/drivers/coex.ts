// NovaStar COEX processors (MX40 Pro, CX40 Pro and others) over the COEX Open API: HTTP on port 8001, JSON under
// /api/v1/, each answer wrapped as {code, data, message} with code 0 for success. Field names follow NovaStar's API
// documentation (api-coex150-novastar.apifox.cn). This driver only reads.
//
// The documentation shows field names but not units or what each status number means. The driver assumes
// temperatures in °C, voltages in V, brightness as 0 to 1, and status 0 as normal (anything else as a fault). These
// need checking against a real processor; see the README.
//
// COEX knows where every cabinet is and which output port and position in the chain feeds it, so the topology is
// drawn from the processor itself, with a port load worked out from the cabinets on each port.
import type {
  ChainView,
  ControlRequest,
  FailoverStatus,
  FanStatus,
  GroupView,
  InputStatus,
  PortView,
  ProcessorConfig,
  ProcessorTopology,
  Reading,
  Severity,
  TileSummary,
  TileView,
} from '@ledmon/shared';
import type { Driver, PolledData } from './types.js';

type Tree = Record<string, unknown>;

/** A 1G output port at 8 bit and 60 Hz drives about 650,000 pixels (NovaStar's figure for its 1G ports). */
export const DEFAULT_PORT_CAPACITY = 650_000;

/**
 * Output port speed in Gbit/s from the device answer's netPortBandWidth. A CX40 Pro with 5G ports reports 1; 0 for 1G
 * and 2 for 10G are assumed from that and not yet seen on a real processor.
 */
const PORT_GBPS: Record<number, number> = { 0: 1, 1: 5, 2: 10 };

export interface PortCapacity {
  pixels: number;
  /** In words, for the wall's notes: where the number comes from. */
  basis: string;
}

/**
 * Pixels one output port can drive: NovaStar's 650,000 per Gbit/s at 60 Hz, times the port speed the processor
 * reports, scaled by its output frame rate (120 Hz halves it). A capacity set in the settings wins.
 */
export function portCapacity(hw: unknown, output: unknown, configured?: number): PortCapacity {
  if (configured) return { pixels: configured, basis: `Port capacity ${configured.toLocaleString('en-US')} pixels, as set in Settings.` };
  const gbps = PORT_GBPS[num(obj(hw).netPortBandWidth) ?? -1];
  const out = obj(Array.isArray(output) ? output[0] : output);
  const reported = num(out.currentFrameRate);
  const rate = reported && reported > 0 ? reported : 60;
  if (!gbps) {
    return { pixels: Math.round((DEFAULT_PORT_CAPACITY * 60) / rate), basis: `Port capacity assumes 1G ports at ${rate} Hz; set it in Settings if the ports are faster.` };
  }
  const pixels = Math.round((DEFAULT_PORT_CAPACITY * gbps * 60) / rate);
  return { pixels, basis: `Port capacity ${pixels.toLocaleString('en-US')} pixels: ${gbps}G ports at ${rate} Hz, 8 bit.` };
}

export interface CoexResponses {
  hw: unknown;
  monitor: unknown;
  screen?: unknown;
  sources?: unknown;
  displayParams?: unknown;
  displayState?: unknown;
  presets?: unknown;
  backup?: unknown;
  /** GET /api/v1/screen/output: the output frame rate. */
  output?: unknown;
}

export function coexDriver(config: ProcessorConfig): Driver {
  const base = `http://${config.host}:${config.port ?? 8001}`;
  const get = async (path: string, signal: AbortSignal) => {
    const res = await fetch(`${base}${path}`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return unwrap((await res.json()) as unknown, path);
  };
  const send = async (method: 'PUT' | 'POST', path: string, body: unknown, signal: AbortSignal) => {
    const res = await fetch(`${base}${path}`, { method, signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`The processor refused ${path} (HTTP ${res.status}).`);
    unwrap((await res.json().catch(() => ({}))) as unknown, path);
  };
  // Controls address screens by id; the ids come from the last poll.
  let screens: { id: string; layer?: number }[] = [];
  return {
    capabilities: { brightness: { min: 0, max: 100, step: 1, unit: '%' }, blackout: true, freeze: true, preset: true, input: true },
    async control(req, signal) {
      if (!screens.length) throw new Error('The processor has not reported its screens yet. Try again after the next poll.');
      for (const c of coexCommands(req, screens)) await send(c.method, c.path, c.body, signal);
    },
    async poll(signal) {
      // The device and monitor answers are needed; the rest fill in what they can.
      const [hw, monitor] = await Promise.all([get('/api/v1/device/hw', signal), get('/api/v1/device/monitor/info', signal)]);
      const optional = await Promise.allSettled([
        get('/api/v1/screen', signal),
        get('/api/v1/device/input/sources', signal),
        get('/api/v1/screen/displayparams', signal),
        get('/api/v1/screen/output/display/state', signal),
        get('/api/v1/preset', signal),
        get('/api/v1/device/backup', signal),
        get('/api/v1/screen/output', signal),
      ]);
      const [screen, sources, displayParams, displayState, presets, backup, output] = optional.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
      screens = screenTargets(screen);
      return parseCoex({ hw, monitor, screen, sources, displayParams, displayState, presets, backup, output }, config.portCapacity);
    },
  };
}

function screenTargets(screen: unknown): { id: string; layer?: number }[] {
  return list(obj(screen).screens)
    .map(obj)
    .filter((s) => str(s.screenID))
    .map((s) => ({ id: str(s.screenID)!, layer: num(liveLayers(s)[0]?.id) }));
}

/**
 * The requests for one control, from NovaStar's API docs and the @novastar-dev/coex client: brightness 0 to 100,
 * display mode 0 normal, 1 blackout, 2 freeze. Turning blackout or freeze off sets the display back to normal.
 */
export function coexCommands(req: ControlRequest, screens: { id: string; layer?: number }[]): { method: 'PUT' | 'POST'; path: string; body: unknown }[] {
  const ids = screens.map((s) => s.id);
  switch (req.action) {
    case 'brightness':
      return [{ method: 'PUT', path: '/api/v1/screen/brightness', body: { screenIdList: ids, brightness: Math.max(0, Math.min(100, Math.round(req.value))) } }];
    case 'blackout':
      return [{ method: 'PUT', path: '/api/v1/screen/output/displaymode', body: { value: req.value ? 1 : 0, screenIdList: ids } }];
    case 'freeze':
      return [{ method: 'PUT', path: '/api/v1/screen/output/displaymode', body: { value: req.value ? 2 : 0, screenIdList: ids } }];
    case 'preset':
      return ids.map((id) => ({ method: 'POST' as const, path: '/api/v1/preset/current/update', body: { sequenceNumber: Math.round(req.value), screenID: id } }));
    case 'input': {
      if (!/^\d+$/.test(req.value)) throw new Error(`Unknown input "${req.value}".`);
      return screens
        .filter((s) => s.layer !== undefined)
        .map((s) => ({ method: 'PUT' as const, path: '/api/v1/screen/layer/input', body: { layers: [{ id: String(s.layer), source: req.value }], screenID: s.id } }));
    }
    default:
      throw new Error(`COEX processors do not take "${req.action}" from this dashboard.`);
  }
}

/** Takes the data out of COEX's {code, data, message} envelope, or the body itself where a page has none. */
export function unwrap(body: unknown, path = ''): unknown {
  const o = obj(body);
  if ('code' in o && 'data' in o) {
    if (num(o.code) !== 0) throw new Error(`COEX refused ${path}: ${str(o.message) ?? `code ${String(o.code)}`}${num(o.code) === 2 ? ' (is VMP connected?)' : ''}`);
    return o.data;
  }
  return body;
}

/** configuredCapacity is the processor's portCapacity setting; without it the capacity comes from the processor. */
export function parseCoex(r: CoexResponses, configuredCapacity?: number): PolledData {
  const hw = obj(r.hw);
  const mon = obj(r.monitor);
  const cabinetsLive = list(mon.cabinets).map(obj);
  const liveById = new Map<number, Tree>();
  for (const c of cabinetsLive) {
    const id = num(c.CabinetID ?? c.cabinetID);
    if (id !== undefined) liveById.set(id, c);
  }
  const screens = list(obj(r.screen).screens).map(obj);
  const placed = screens.flatMap((s) => list(s.canvases).flatMap((cv) => list(obj(cv).cabinets).map(obj)));

  const errors = cabinetsLive.filter((c) => cabinetFaults(c).length > 0).length;
  const tiles: TileSummary | undefined =
    placed.length || cabinetsLive.length
      ? {
          associated: Math.max(placed.length, cabinetsLive.length),
          online: placed.length ? placed.filter((c) => liveById.has(num(c.cabinetID) ?? -1)).length : cabinetsLive.length,
          errors,
          firmware: {},
        }
      : undefined;

  const displayModes = list(obj(r.displayState).displayState).map((d) => num(obj(d).displayMode));
  const brightness = num(obj(obj(r.displayParams).list).brightness) ?? num(obj(list(obj(r.displayParams).list)[0]).brightness);

  return {
    reportedName: str(hw.customName) || str(hw.name) || str(mon.name),
    model: modelName(hw),
    serial: str(hw.sn) || str(hw.productSn),
    firmware: str(hw.swVersion),
    uptimeSeconds: num(hw.uptime) ?? num(mon.runtime),
    temperatures: parseTemperatures(mon),
    fans: parseFans(mon),
    inputs: parseInputs(r.sources, screens),
    brightness: brightness === undefined ? undefined : brightness <= 1 ? Math.round(brightness * 1000) / 10 : brightness,
    brightnessUnit: '%',
    // The COEX client library reads displayMode as 0 normal, 1 blackout, 2 freeze.
    blackout: displayModes.length ? displayModes.some((m) => m === 1) : undefined,
    freeze: displayModes.length ? displayModes.some((m) => m === 2) : undefined,
    preset: parsePreset(r.presets),
    presets: parsePresets(r.presets),
    failover: parseBackup(obj(r.backup), mon),
    loops: [],
    tiles,
    topology: screens.length ? parseTopology(screens, mon, liveById, portCapacity(hw, r.output, configuredCapacity)) : undefined,
  };
}

function modelName(hw: Tree): string | undefined {
  const t = str(hw.type) || str(hw.Series) || str(hw.name);
  if (!t) return undefined;
  return /novastar/i.test(t) ? t : `NovaStar ${t}`;
}

function bad(status: unknown): boolean {
  const n = num(status);
  return n !== undefined && n !== 0;
}

function parseTemperatures(mon: Tree): Reading[] {
  const out: Reading[] = [];
  const main = obj(mon.mainBoardTemperature);
  if (num(main.value) !== undefined) out.push({ key: 'main-board', label: 'Main board', value: num(main.value)!, unit: '°C' });
  list(mon.temperatureInfos).forEach((t, i) => {
    const v = num(obj(t).temperature);
    if (v !== undefined) out.push({ key: `sensor-${num(obj(t).temperatureType) ?? i}`, label: `Sensor ${(num(obj(t).temperatureType) ?? i) + 1}`, value: v, unit: '°C' });
  });
  for (const card of list(mon.cardMonitorInfo).map(obj)) {
    list(card.cardTemperatureInfos).forEach((t, i) => {
      const v = num(obj(t).temperature);
      if (v !== undefined) out.push({ key: `card-${num(card.cardID)}-${i}`, label: `Card ${(num(card.cardID) ?? 0) + 1}${i ? ` sensor ${i + 1}` : ''}`, value: v, unit: '°C' });
    });
  }
  return out;
}

function parseFans(mon: Tree): FanStatus[] {
  return list(mon.fanInfos).map((f, i) => {
    const o = obj(f);
    const rpm = num(o.fanSpeed);
    return { key: `fan-${i}`, label: `Fan ${i + 1}`, rpm, running: (rpm ?? 1) > 0 && !bad(o.status) };
  });
}

/**
 * The layers each screen shows now: those of its current working mode, and of those the ones placed on a canvas
 * (a real CX40 Pro keeps a layer with layerInCanvasId 0 that is not shown).
 */
function liveLayers(s: Tree): Tree[] {
  const modes = list(s.layersInWorkingMode);
  const current = num(s.workingMode);
  const mode = modes.find((m) => current !== undefined && num(obj(m).workingMode) === current) ?? modes[0];
  const layers = (Array.isArray(mode) ? mode : list(obj(mode).layers).length ? list(obj(mode).layers) : mode ? [mode] : []).map(obj);
  const placed = layers.filter((l) => (num(l.layerInCanvasId) ?? 0) !== 0);
  return placed.length ? placed : layers;
}

/** A layer's source is the input's groupId on a real CX40 Pro (HDMI2.0 2 is id 0, groupId 1); id where there is none. */
function sourceKey(s: Tree, i: number): number {
  return num(s.groupId) ?? num(s.id) ?? i;
}

function parseInputs(raw: unknown, screens: Tree[]): InputStatus[] {
  // The documentation shows one object; real answers are a list. Both are read.
  const sources = Array.isArray(raw) ? raw.map(obj) : Object.keys(obj(raw)).length ? [obj(raw)] : [];
  const used = new Set<number>();
  for (const s of screens) {
    for (const l of liveLayers(s)) {
      const src = num(l.source);
      if (src !== undefined) used.add(src);
    }
  }
  return sources.map((s, i) => {
    const res = obj(s.actualResolution);
    const width = num(res.width);
    const height = num(res.height);
    // A real CX40 Pro reports sourceStatus 1 for an input with signal and 0 without, and keeps the EDID resolution
    // on every input, so the resolution only decides where sourceStatus is missing.
    const status = num(s.sourceStatus);
    const signal = status !== undefined ? status === 1 : (width ?? 0) > 0 && (height ?? 0) > 0;
    const key = sourceKey(s, i);
    const rate = num(s.actualRefreshRate);
    return {
      label: str(s.name) || `Input ${(num(s.id) ?? i) + 1}`,
      key: String(key),
      type: 'input',
      number: key,
      active: used.has(key),
      signal,
      width: signal ? width : undefined,
      height: signal ? height : undefined,
      rate: signal && rate && rate > 0 ? (rate > 1000 ? rate / 1000 : rate) : undefined,
    };
  });
}

function parsePresets(raw: unknown): PolledData['presets'] {
  const seen = new Map<number, string>();
  for (const screen of list(obj(raw).screenPresetList)) {
    for (const p of list(obj(screen).presetList).map(obj)) {
      const n = num(p.sequenceNumber);
      if (n !== undefined && !seen.has(n)) seen.set(n, str(p.name) ?? `Preset ${n}`);
    }
  }
  return seen.size ? [...seen].map(([number, name]) => ({ number, name })).sort((a, b) => a.number - b.number) : undefined;
}

function parsePreset(raw: unknown): PolledData['preset'] {
  for (const screen of list(obj(raw).screenPresetList)) {
    for (const p of list(obj(screen).presetList).map(obj)) {
      if (p.state === true && num(p.sequenceNumber) !== undefined) return { number: num(p.sequenceNumber)!, name: str(p.name) ?? '' };
    }
  }
  return undefined;
}

function parseBackup(b: Tree, mon: Tree): FailoverStatus | undefined {
  const master = str(b.master);
  const backup = str(b.backup);
  if (!master && !backup) return undefined;
  return {
    enabled: true,
    partnerName: str(b.backupName) || str(b.masterName) || backup || master,
    // monitor/info's backupStatus is assumed non-zero while the backup path is in use.
    active: bad(mon.backupStatus),
  };
}

/** What is wrong with one cabinet according to the monitor answer, in words. Empty when it is healthy. */
function cabinetFaults(c: Tree): string[] {
  const out: string[] = [];
  const box = obj(c.cabinet);
  if (bad(obj(box.temperature).status)) out.push(`cabinet temperature ${num(obj(box.temperature).value) ?? '?'} °C`);
  if (bad(obj(box.voltage).status)) out.push(`cabinet voltage ${num(obj(box.voltage).value) ?? '?'} V`);
  if (bad(obj(c.temperature).status)) out.push(`temperature ${num(obj(c.temperature).value) ?? '?'} °C`);
  if (bad(obj(c.voltage).status)) out.push(`voltage ${num(obj(c.voltage).value) ?? '?'} V`);
  if (list(c.powerInfo).some((p) => bad(obj(p).status))) out.push('power supply fault');
  for (const card of list(c.rvCards).map(obj)) {
    if (bad(obj(card.temperature).status)) out.push(`receiving card temperature ${num(obj(card.temperature).value) ?? '?'} °C`);
    if (bad(obj(card.voltage).status)) out.push(`receiving card voltage ${num(obj(card.voltage).value) ?? '?'} V`);
    if (list(card.errorBit).some((e) => bad(obj(e).status) || (num(obj(e).value) ?? 0) !== 0)) out.push('receiving card errors');
    for (const m of list(card.moduleInfos).map(obj)) {
      if (bad(obj(m.temperature).status) || bad(obj(m.voltage).status)) out.push(`module ${str(m.moduleIndex) ?? '?'} fault`);
    }
  }
  return [...new Set(out)];
}

function linkBroken(c: Tree): boolean {
  return list(c.rvCards).some((card) => obj(obj(card).nextCabinetLinkStatus).linkStatus === false);
}

/** Output ids count from 256 on output card 1 (256, 257...), or from 0 on processors that number them plainly. */
function portNumber(outputID: number): number {
  return outputID >= 256 ? (outputID & 0xff) + 1 : outputID + 1;
}

function parseTopology(screens: Tree[], mon: Tree, liveById: Map<number, Tree>, cap: PortCapacity): ProcessorTopology {
  const capacity = cap.pixels;
  const outputBad = new Set(list(mon.outputStatus).filter((o) => bad(obj(o).status)).map((o) => num(obj(o).outputID)));
  const portBad = new Set(list(mon.controllerPortMonitorInfos).filter((o) => bad(obj(o).status)).map((o) => num(obj(o).controllerPortID)));
  const notes: string[] = [];
  const groups: GroupView[] = screens.map((s) => {
    const cabs = list(s.canvases).flatMap((cv) => list(obj(cv).cabinets).map(obj));
    const byPort = new Map<number, Tree[]>();
    for (const c of cabs) {
      const port = num(c.outputID) ?? 0;
      byPort.set(port, [...(byPort.get(port) ?? []), c]);
    }
    const chains: ChainView[] = [...byPort.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([port, onPort]) => {
        // Chain order is the connection order the processor reports.
        const ordered = [...onPort].sort((a, b) => (num(a.connectID) ?? 0) - (num(b.connectID) ?? 0));
        const pixels = ordered.reduce((n, c) => n + (num(obj(c.size).width) ?? 0) * (num(obj(c.size).height) ?? 0), 0);
        const percent = capacity > 0 ? (pixels / capacity) * 100 : 0;
        const label = `${portNumber(port)}`;
        const tiles: TileView[] = ordered.map((c, i) => {
          const id = num(c.cabinetID) ?? i;
          const live = liveById.get(id);
          const faults = live ? cabinetFaults(live) : [];
          const sev: Severity = !live ? 'critical' : faults.length ? 'warning' : 'ok';
          // Real CX40 Pro answers keep readings on the receiving card and report 0 at the cabinet.
          const card = obj(list(live?.rvCards)[0]);
          const reading = (key: string) => [obj(live?.[key]).value, obj(card[key]).value, obj(obj(live?.cabinet)[key]).value].map(num).find((n) => n !== undefined && n > 0);
          const t = reading('temperature');
          const v = reading('voltage');
          return {
            id: `${str(s.screenID) ?? ''}:${id}`,
            severity: sev,
            label: `Port ${label}, cabinet ${i + 1}`,
            detail: !live ? 'not responding' : faults.length ? faults.join(', ') : [t !== undefined ? `${t} °C` : '', v !== undefined ? `${v} V` : ''].filter(Boolean).join(' · ') || undefined,
          };
        });
        const missing = tiles.filter((t) => t.severity === 'critical').length;
        const broken = ordered.some((c) => {
          const live = liveById.get(num(c.cabinetID) ?? -1);
          return live ? linkBroken(live) : false;
        });
        const portDown = outputBad.has(port) || portBad.has(port);
        const from: PortView = { label, state: portDown ? 'lost' : 'ok', load: { pixels, capacity, percent } };
        const chainNotes: string[] = [];
        if (missing) chainNotes.push(`${missing} cabinet${missing === 1 ? '' : 's'} not responding.`);
        if (broken) chainNotes.push('A cabinet reports the link to the next cabinet is down.');
        if (portDown) chainNotes.push(`Output ${label} reports a fault.`);
        if (percent > 100) chainNotes.push(`Port ${label} carries more pixels than its capacity (${capacity.toLocaleString('en-US')}).`);
        const sev: Severity =
          portDown || missing || percent > 100 ? 'critical' : broken || percent >= 90 || tiles.some((t) => t.severity === 'warning') ? 'warning' : 'ok';
        return {
          id: `${str(s.screenID) ?? ''}:${port}`,
          label: `Port ${label}`,
          tiles,
          tileCount: tiles.length,
          from,
          loop: 'none',
          severity: sev,
          notes: chainNotes,
        };
      });
    return { left: { name: str(s.screenName) || 'Outputs' }, chains };
  });
  if (!groups.some((g) => g.chains.length)) notes.push('The processor reports no cabinets on its screens yet.');
  else notes.push(cap.basis);
  // One screen gives the wall its name; several are shown as groups under the processor's name.
  return { name: screens.length === 1 ? str(screens[0].screenName) || undefined : undefined, groups, notes };
}

// Small readers that never throw on a surprising shape.
function obj(v: unknown): Tree {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Tree) : {};
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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
