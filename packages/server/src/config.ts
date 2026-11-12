// The app's settings, kept as one JSON file in the data folder. Phase 1 edits it by hand (the launcher's
// "Open settings folder"); the settings page comes in a later phase.
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessorConfig, ProcessorKind } from '@ledmon/shared';

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
    ...pickNumbers(obj, ['port', 'pollIntervalMs', 'requestTimeoutMs']),
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(typeof obj.thresholds === 'object' && obj.thresholds !== null
        ? pickNumbers(obj.thresholds as Record<string, unknown>, Object.keys(DEFAULT_THRESHOLDS))
        : {}),
    },
    processors: [],
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
  return config;
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
        'Add one entry per processor to "processors", e.g. {"name": "Stage Main", "kind": "brompton", "host": "10.10.20.11"}. kind is brompton, coex or vxpro. Restart the server after editing.',
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
