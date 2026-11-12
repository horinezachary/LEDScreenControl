// The app's settings, kept as one JSON file in the data folder, edited by hand (the launcher's "Open settings folder")
// or from the settings page.
import fs from 'node:fs';
import path from 'node:path';
import type { BoxLayout, GroupLayout, ProcessorConfig, ProcessorKind, WallLayout } from '@ledmon/shared';

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
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  tempWarnC: 70,
  tempCritC: 80,
  fanMinRpm: 500,
  tilesOfflineCritPercent: 5,
  unreachableAfterPolls: 3,
};

export const DEFAULT_CONFIG: Config = {
  port: 8080,
  pollIntervalMs: 5000,
  requestTimeoutMs: 3000,
  processors: [],
  thresholds: DEFAULT_THRESHOLDS,
  walls: [],
  syslogPort: 5514,
};

const KINDS: ProcessorKind[] = ['brompton', 'coex', 'vxpro'];

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
  };
  if (config.pollIntervalMs < 1000) throw new ConfigError('pollIntervalMs must be at least 1000.');

  const list = obj.processors ?? [];
  if (!Array.isArray(list)) throw new ConfigError('"processors" must be a list.');
  const ids = new Set<string>();
  list.forEach((p, i) => {
    const where = `processors[${i}]`;
    if (typeof p !== 'object' || p === null) throw new ConfigError(`${where} must be an object.`);
    const { id, name, kind, host, port } = p as Record<string, unknown>;
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
    });
  });
  config.walls = parseWalls(obj.walls, ids);
  return config;
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
