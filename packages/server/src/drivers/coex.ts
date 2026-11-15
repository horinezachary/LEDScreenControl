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

export interface CoexResponses {
  hw: unknown;
  monitor: unknown;
  screen?: unknown;
  sources?: unknown;
  displayParams?: unknown;
  displayState?: unknown;
  presets?: unknown;
  backup?: unknown;
}

export function coexDriver(config: ProcessorConfig): Driver {
  const base = `http://${config.host}:${config.port ?? 8001}`;
  const get = async (path: string, signal: AbortSignal) => {
    const res = await fetch(`${base}${path}`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return unwrap((await res.json()) as unknown, path);
  };
  return {
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
      ]);
      const [screen, sources, displayParams, displayState, presets, backup] = optional.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
      return parseCoex({ hw, monitor, screen, sources, displayParams, displayState, presets, backup }, config.portCapacity ?? DEFAULT_PORT_CAPACITY);
    },
  };
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

export function parseCoex(r: CoexResponses, portCapacity = DEFAULT_PORT_CAPACITY): PolledData {
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
    failover: parseBackup(obj(r.backup), mon),
    loops: [],
    tiles,
    topology: screens.length ? parseTopology(screens, mon, liveById, portCapacity) : undefined,
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

function parseInputs(raw: unknown, screens: Tree[]): InputStatus[] {
  // The documentation shows one object; real answers may be a list. Both are read.
  const sources = Array.isArray(raw) ? raw.map(obj) : Object.keys(obj(raw)).length ? [obj(raw)] : [];
  const used = new Set<number>();
  for (const s of screens) {
    for (const mode of list(s.layersInWorkingMode)) {
      const layers = Array.isArray(mode) ? mode : list(obj(mode).layers).length ? list(obj(mode).layers) : [mode];
      for (const l of layers) {
        const src = num(obj(l).source);
        if (src !== undefined) used.add(src);
      }
    }
  }
  return sources.map((s, i) => {
    const res = obj(s.actualResolution);
    const width = num(res.width);
    const height = num(res.height);
    // sourceStatus is not documented, so a source counts as having signal when it reports a resolution.
    const signal = (width ?? 0) > 0 && (height ?? 0) > 0;
    const id = num(s.id) ?? i;
    const rate = num(s.actualRefreshRate);
    return {
      label: str(s.name) || `Input ${id + 1}`,
      type: 'input',
      number: id,
      active: used.has(id),
      signal,
      width: signal ? width : undefined,
      height: signal ? height : undefined,
      rate: signal && rate && rate > 0 ? (rate > 1000 ? rate / 1000 : rate) : undefined,
    };
  });
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

function parseTopology(screens: Tree[], mon: Tree, liveById: Map<number, Tree>, capacity: number): ProcessorTopology {
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
      .map(([port, list]) => {
        // Chain order is the connection order the processor reports.
        const ordered = [...list].sort((a, b) => (num(a.connectID) ?? 0) - (num(b.connectID) ?? 0));
        const pixels = ordered.reduce((n, c) => n + (num(obj(c.size).width) ?? 0) * (num(obj(c.size).height) ?? 0), 0);
        const percent = capacity > 0 ? (pixels / capacity) * 100 : 0;
        const label = `${port + 1}`;
        const tiles: TileView[] = ordered.map((c, i) => {
          const id = num(c.cabinetID) ?? i;
          const live = liveById.get(id);
          const faults = live ? cabinetFaults(live) : [];
          const sev: Severity = !live ? 'critical' : faults.length ? 'warning' : 'ok';
          const t = num(obj(live?.temperature).value);
          const v = num(obj(live?.voltage).value);
          return {
            id: `${str(s.screenID) ?? ''}:${id}`,
            severity: sev,
            label: `Cabinet ${id + 1} (port ${label}, #${i + 1} in chain)`,
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
