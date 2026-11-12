// Looks for processors on the show network: for each address in a /24, asks the read-only identity endpoints of
// Tessera (GET /api/ on port 80) and COEX (GET /api/v1/device/hw on port 8001). Nothing is written to any device.
import os from 'node:os';
import type { ProcessorKind, ScanResult } from '@ledmon/shared';
import { parseTessera } from './drivers/brompton.js';
import { unwrap } from './drivers/coex.js';

/** The /24 networks this machine is on, e.g. "10.10.20". */
export function localSubnets(): string[] {
  const out = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...out];
}

export function isSubnet(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 3 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

async function probe(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

export async function identify(host: string, timeoutMs = 800, ports = { brompton: 80, coex: 8001 }): Promise<Omit<ScanResult, 'known'> | undefined> {
  const [tessera, coex] = await Promise.all([
    probe(`http://${host}:${ports.brompton}/api/`, timeoutMs),
    probe(`http://${host}:${ports.coex}/api/v1/device/hw`, timeoutMs),
  ]);
  if (tessera) {
    try {
      const d = parseTessera(tessera);
      return { host, kind: 'brompton', name: d.reportedName, model: d.model, serial: d.serial };
    } catch {
      // Something answers on port 80, but it is not Tessera.
    }
  }
  if (coex) {
    try {
      const hw = unwrap(coex) as Record<string, unknown>;
      const name = typeof hw.customName === 'string' && hw.customName ? hw.customName : (hw.name as string | undefined);
      return { host, kind: 'coex' as ProcessorKind, name, model: hw.type as string | undefined, serial: hw.sn as string | undefined };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Scans x.y.z.1 to x.y.z.254, 64 addresses at a time. Takes a few seconds on a quiet network. */
export async function scanSubnet(subnet: string, known: Set<string>, timeoutMs = 800): Promise<ScanResult[]> {
  if (!isSubnet(subnet)) throw new Error('Give the first three parts of an address, like 10.10.20.');
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const found: ScanResult[] = [];
  for (let i = 0; i < hosts.length; i += 64) {
    const batch = await Promise.all(hosts.slice(i, i + 64).map((h) => identify(h, timeoutMs)));
    for (const r of batch) if (r) found.push({ ...r, known: known.has(r.host) });
  }
  return found;
}
