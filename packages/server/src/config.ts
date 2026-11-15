// The app's settings, kept as one JSON file in the data folder, edited by hand (the launcher's "Open settings folder")
// or from the settings page.
import fs from 'node:fs';
import path from 'node:path';
import type { BoxLayout, EmailSettings, GroupLayout, ProcessorConfig, ProcessorKind, WallLayout } from '@ledmon/shared';

export interface Thresholds {
  /** Any processor temperature at or above this is a warning, in °C. */
  tempWarnC: number;
  /** ...and at or above this, critical. */
  tempCritC: number;
  /** A running fan below this speed is a warning, in RPM. 0 turns the check off. */
  fanMinRpm: number;
  /** Share of tiles offline that turns the tile warning critical, in percent. */
  tilesOfflineCritPercent: number;
  /** Missed polls before a processor counts as unreachable (critical). One missed poll is a warning. */
  unreachableAfterPolls: number;
  /** Port load that raises a warning, in percent (COEX). Over 100% is critical. */
  portLoadWarnPercent: number;
}

export interface Config {
  /** Port the dashboard listens on, on every interface. */
  port: number;
  pollIntervalMs: number;
  /** Per request, so a dead processor cannot hold up the poll loop. */
  requestTimeoutMs: number;
  processors: ProcessorConfig[];
  thresholds: Thresholds;
  /** Brompton walls: which processors feed them and how the distribution boxes and chains are cabled. */
  walls: WallLayout[];
  /** UDP port for processors' syslog messages (point Tessera's syslog here). 0 turns it off. */
  syslogPort: number;
  /** Lets the dashboard send control commands (brightness, preset, blackout...). On by default, as designed. */
  controls: boolean;
  email: EmailSettings;
}

export const DEFAULT_EMAIL: EmailSettings = {
  enabled: false,
  host: '',
  port: 587,
  secure: false,
  from: '',
  to: [],
  minSeverity: 'critical',
  repeatMinutes: 10,
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  tempWarnC: 70,
  tempCritC: 80,
  fanMinRpm: 500,
  tilesOfflineCritPercent: 5,
  unreachableAfterPolls: 3,
  portLoadWarnPercent: 90,
};

export const DEFAULT_CONFIG: Config = {
  port: 6060,
  pollIntervalMs: 5000,
  requestTimeoutMs: 3000,
  processors: [],
  thresholds: DEFAULT_THRESHOLDS,
  walls: [],
  syslogPort: 5514,
  controls: true,
  email: DEFAULT_EMAIL,
};

const KINDS: ProcessorKind[] = ['brompton', 'coex', 'vxpro', 'device'];

export class ConfigError extends Error {}

/** Checks and fills in a config read from disk. Throws ConfigError with a message a person can act on. */
export function parseConfig(raw: unknown): Config {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('The settings file must hold a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...pickNumbers(obj, ['port', 'pollIntervalMs', 'requestTimeoutMs', 'syslogPort']),
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(typeof obj.thresholds === 'object' && obj.thresholds !== null
        ? pickNumbers(obj.thresholds as Record<string, unknown>, Object.keys(DEFAULT_THRESHOLDS))
        : {}),
    },
    processors: [],
    walls: [],
    controls: obj.controls === undefined ? true : obj.controls === true,
    email: parseEmail(obj.email),
  };
  if (obj.controls !== undefined && typeof obj.controls !== 'boolean') throw new ConfigError('"controls" must be true or false.');
  if (config.pollIntervalMs < 1000) throw new ConfigError('pollIntervalMs must be at least 1000.');

  const list = obj.processors ?? [];
  if (!Array.isArray(list)) throw new ConfigError('"processors" must be a list.');
  const ids = new Set<string>();
  list.forEach((p, i) => {
    const where = `processors[${i}]`;
    if (typeof p !== 'object' || p === null) throw new ConfigError(`${where} must be an object.`);
    const { id, name, kind, host, port, portCapacity } = p as Record<string, unknown>;
    if (typeof host !== 'string' || !host.trim()) throw new ConfigError(`${where} needs a "host" (IP address).`);
    if (!KINDS.includes(kind as ProcessorKind)) {
      throw new ConfigError(`${where}.kind must be one of ${KINDS.join(', ')}.`);
    }
    const finalId = typeof id === 'string' && id.trim() ? id.trim() : slug(host);
    if (ids.has(finalId)) throw new ConfigError(`Two processors share the id "${finalId}".`);
    ids.add(finalId);
    config.processors.push({
      id: finalId,
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      kind: kind as ProcessorKind,
      host: host.trim(),
      port: typeof port === 'number' ? port : undefined,
      portCapacity: typeof portCapacity === 'number' && portCapacity > 0 ? portCapacity : undefined,
    });
  });
  config.walls = parseWalls(obj.walls, ids);
  return config;
}

/** Writes the settings file, keeping the previous one as config.json.bak. Writes to a temporary file first, so a crash cannot leave half a file. */
export function saveConfig(dataDir: string, config: Config): void {
  const file = configPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

function parseEmail(raw: unknown): EmailSettings {
  if (raw === undefined) return { ...DEFAULT_EMAIL };
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('"email" must be an object.');
  const o = raw as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : undefined);
  const to = Array.isArray(o.to) ? o.to : typeof o.to === 'string' ? o.to.split(/[,;\s]+/) : [];
  const email: EmailSettings = {
    enabled: o.enabled === true,
    host: text('host') ?? '',
    port: typeof o.port === 'number' ? o.port : o.secure === true ? 465 : 587,
    secure: o.secure === true,
    user: text('user') || undefined,
    pass: typeof o.pass === 'string' && o.pass ? o.pass : undefined,
    from: text('from') ?? '',
    to: to.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()),
    minSeverity: o.minSeverity === 'warning' ? 'warning' : 'critical',
    repeatMinutes: typeof o.repeatMinutes === 'number' && o.repeatMinutes >= 0 ? o.repeatMinutes : 10,
  };
  if (email.enabled) {
    if (!email.host) throw new ConfigError('Email alerts need an SMTP server ("email.host").');
    if (!email.to.length) throw new ConfigError('Email alerts need at least one recipient ("email.to").');
    if (!email.to.every((t) => /^[^@\s]+@[^@\s]+$/.test(t))) throw new ConfigError('Each email recipient must be an address like name@example.com.');
    if (!email.from) email.from = email.user && email.user.includes('@') ? email.user : `led-monitor@${email.host}`;
  }
  return email;
}

function parseWalls(raw: unknown, processorIds: Set<string>): WallLayout[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError('"walls" must be a list.');
  const ids = new Set<string>();
  return raw.map((w, i) => {
    const where = `walls[${i}]`;
    if (typeof w !== 'object' || w === null) throw new ConfigError(`${where} must be an object.`);
    const o = w as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `Wall ${i + 1}`;
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : slug(name);
    if (ids.has(id)) throw new ConfigError(`Two walls share the id "${id}".`);
    ids.add(id);
    if (typeof o.primary !== 'string' || !processorIds.has(o.primary)) {
      throw new ConfigError(`${where}.primary must be the id of a processor in "processors".`);
    }
    if (o.backup !== undefined && (typeof o.backup !== 'string' || !processorIds.has(o.backup))) {
      throw new ConfigError(`${where}.backup must be the id of a processor in "processors".`);
    }
    if (!Array.isArray(o.groups)) throw new ConfigError(`${where}.groups must be a list.`);
    const groups = o.groups.map((g, j) => parseGroup(g, `${where}.groups[${j}]`));
    return { id, name, primary: o.primary, backup: o.backup as string | undefined, groups };
  });
}

function parseGroup(raw: unknown, where: string): GroupLayout {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${where} must be an object.`);
  const o = raw as Record<string, unknown>;
  const left = parseBox(o.left, `${where}.left`);
  const right = o.right === undefined ? undefined : parseBox(o.right, `${where}.right`);
  if (!Array.isArray(o.chains) || !o.chains.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
    throw new ConfigError(`${where}.chains must be a list of tile counts, one per port (0 for an empty port).`);
  }
  const ports = Math.min(left.ports ?? 10, right?.ports ?? Infinity);
  if (o.chains.length > ports) throw new ConfigError(`${where}.chains lists ${o.chains.length} ports but the box has ${ports}.`);
  return { left, right, chains: o.chains as number[] };
}

function parseBox(raw: unknown, where: string): BoxLayout {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`${where} must be an object with a "name".`);
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) throw new ConfigError(`${where} needs a "name".`);
  if (o.ports !== undefined && (!Number.isInteger(o.ports) || (o.ports as number) < 1)) throw new ConfigError(`${where}.ports must be a whole number.`);
  return {
    name: o.name.trim(),
    trunk: typeof o.trunk === 'string' && o.trunk.trim() ? o.trunk.trim().toUpperCase() : undefined,
    ports: (o.ports as number | undefined) ?? 10,
    serial: typeof o.serial === 'string' && o.serial.trim() ? o.serial.trim() : undefined,
  };
}

function pickNumbers(obj: Record<string, unknown>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`"${k}" must be a number.`);
    out[k] = v;
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'config.json');
}

/** Reads the settings file, writing the defaults first if there is none. */
export function loadConfig(dataDir: string): Config {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = configPath(dataDir);
  if (!fs.existsSync(file)) {
    const starter = {
      ...DEFAULT_CONFIG,
      processors: [] as ProcessorConfig[],
      _help:
        'Add one entry per processor to "processors", e.g. {"name": "Stage Main", "kind": "brompton", "host": "10.10.20.11"}. kind is brompton, coex or vxpro. Describe Brompton walls under "walls" (see the README). Restart the server after editing.',
    };
    fs.writeFileSync(file, JSON.stringify(starter, null, 2) + '\n');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
