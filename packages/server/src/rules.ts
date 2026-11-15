// Health rules: turn a snapshot into alerts. Each alert has a stable key, so the monitor can tell a new problem from
// one that is still going, and keep the time it started.
import type { Alert, ProcessorSnapshot, Severity } from '@ledmon/shared';
import { worstSeverity } from '@ledmon/shared';
import type { Thresholds } from './config.js';

export type NewAlert = Omit<Alert, 'since'>;

export function evaluate(
  snap: ProcessorSnapshot,
  thresholds: Thresholds,
  previous: Alert[] = [],
  now = Date.now(),
  extra: NewAlert[] = [],
): { alerts: Alert[]; severity: Severity } {
  const found = [...check(snap, thresholds), ...extra];
  const before = new Map(previous.map((a) => [a.key, a]));
  const alerts = found.map((a) => ({ ...a, since: before.get(a.key)?.since ?? now }));
  if (!snap.reachable && snap.lastSeen === undefined && snap.missedPolls === 0) {
    // Never polled yet.
    return { alerts, severity: 'unknown' };
  }
  return { alerts, severity: worstSeverity(alerts.map((a) => a.severity)) };
}

function check(s: ProcessorSnapshot, t: Thresholds): NewAlert[] {
  const out: NewAlert[] = [];

  if (!s.reachable) {
    if (s.missedPolls >= t.unreachableAfterPolls) {
      out.push({ key: 'unreachable', rule: 'unreachable', severity: 'critical', message: `Not responding (${s.lastError ?? 'no answer'})` });
    } else if (s.missedPolls > 0) {
      out.push({ key: 'unreachable', rule: 'unreachable', severity: 'warning', message: `Missed ${s.missedPolls} poll${s.missedPolls === 1 ? '' : 's'}` });
    }
    // Everything else is stale while it is unreachable, so it is not judged.
    return out;
  }

  const active = s.inputs.find((i) => i.active);
  if (active && !active.signal) {
    out.push({ key: 'signal', rule: 'signal', severity: 'critical', message: `No signal on the active input (${active.label})` });
  }

  for (const r of s.temperatures) {
    if (r.value >= t.tempCritC) {
      out.push({ key: `temp:${r.key}`, rule: 'temperature', severity: 'critical', message: `${r.label} at ${r.value.toFixed(1)} °C (limit ${t.tempCritC} °C)` });
    } else if (r.value >= t.tempWarnC) {
      out.push({ key: `temp:${r.key}`, rule: 'temperature', severity: 'warning', message: `${r.label} at ${r.value.toFixed(1)} °C (warning at ${t.tempWarnC} °C)` });
    }
  }

  for (const f of s.fans) {
    if (!f.running) {
      out.push({ key: `fan:${f.key}`, rule: 'fan', severity: 'critical', message: `${f.label} has stopped` });
    } else if (t.fanMinRpm > 0 && f.rpm !== undefined && f.rpm < t.fanMinRpm) {
      out.push({ key: `fan:${f.key}`, rule: 'fan', severity: 'warning', message: `${f.label} slow at ${Math.round(f.rpm)} RPM` });
    }
  }

  if (s.tiles && s.tiles.associated > 0) {
    const offline = s.tiles.associated - s.tiles.online;
    if (offline > 0) {
      const pct = (offline / s.tiles.associated) * 100;
      out.push({
        key: 'tiles-offline',
        rule: 'tiles',
        severity: pct >= t.tilesOfflineCritPercent ? 'critical' : 'warning',
        message: `${offline} of ${s.tiles.associated} tiles offline`,
      });
    }
    if (s.tiles.errors > 0) {
      out.push({ key: 'tile-errors', rule: 'tiles', severity: 'warning', message: `${s.tiles.errors} tile${s.tiles.errors === 1 ? '' : 's'} reporting errors` });
    }
    const versions = Object.keys(s.tiles.firmware);
    if (versions.length > 1) {
      out.push({ key: 'tile-firmware', rule: 'firmware', severity: 'warning', message: `Tiles on ${versions.length} firmware versions: ${versions.join(', ')}` });
    }
  }

  // Processors that report their own topology (COEX): port loads, port faults and broken links between cabinets.
  for (const g of s.topology?.groups ?? []) {
    for (const c of g.chains) {
      const load = c.from.load;
      if (load && load.percent > 100) {
        out.push({ key: `port-load:${c.id}`, rule: 'port-load', severity: 'critical', message: `${c.label} over capacity at ${Math.round(load.percent)}% (${load.pixels.toLocaleString('en-US')} pixels)` });
      } else if (load && load.percent >= 90) {
        out.push({ key: `port-load:${c.id}`, rule: 'port-load', severity: 'warning', message: `${c.label} at ${Math.round(load.percent)}% of capacity` });
      }
      if (c.from.state === 'lost') out.push({ key: `port:${c.id}`, rule: 'port', severity: 'critical', message: `${c.label} reports an output fault` });
      if (c.notes.some((n) => n.startsWith('A cabinet reports the link'))) {
        out.push({ key: `link:${c.id}`, rule: 'cabinet-link', severity: 'warning', message: `${c.label}: link between cabinets down` });
      }
    }
  }

  const f = s.failover;
  if (f?.enabled) {
    if (f.partnerPresent === false) {
      out.push({ key: 'partner', rule: 'failover', severity: 'warning', message: `Redundant partner ${f.partnerName ?? ''} not seen`.replace(/\s+/g, ' ').trim() });
    }
    if (f.active && f.role === 'primary') {
      out.push({ key: 'failover-active', rule: 'failover', severity: 'critical', message: 'Failover active: the backup processor is driving the wall' });
    } else if (f.active && f.role === 'backup') {
      out.push({ key: 'failover-active', rule: 'failover', severity: 'warning', message: 'This backup processor is driving the wall' });
    }
  }

  return out;
}

/**
 * Cable loops need memory: Tessera lists every possible loop, and most say "no-loop-found" because nothing is cabled
 * that way. Only a loop that was found earlier and is now lost is a problem.
 */
export function loopAlerts(s: ProcessorSnapshot, everFound: Map<number, string>): NewAlert[] {
  if (!s.reachable) return [];
  const out: NewAlert[] = [];
  for (const loop of s.loops) {
    if (loop.found) {
      // "loop-found: A1->B1" names the ports; a lost loop no longer does, so remember them.
      const ports = /loop-found:\s*(\S+)/.exec(loop.state)?.[1];
      everFound.set(loop.index, ports ?? `${loop.index + 1}`);
    } else if (everFound.has(loop.index)) {
      const name = everFound.get(loop.index)!.replace('->', ' to ');
      out.push({ key: `loop:${loop.index}`, rule: 'cable-loop', severity: 'warning', message: `Cable loop ${name} broken (${loop.state})` });
    }
  }
  return out;
}
