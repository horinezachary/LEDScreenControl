import { describe, expect, it } from 'vitest';
import type { ProcessorSnapshot } from '@ledmon/shared';
import { DEFAULT_THRESHOLDS } from '../src/config.js';
import { evaluate, loopAlerts } from '../src/rules.js';
import { parseTessera } from '../src/drivers/brompton.js';
import { TesseraSimulator, type Scenario } from '../src/sim/tessera.js';

function snapshot(scenario: Scenario = 'normal', role: 'primary' | 'backup' = 'primary'): ProcessorSnapshot {
  const s = new TesseraSimulator({ name: 'P', serial: '1', role, partnerName: 'B', partnerSerial: '2', seed: 3 });
  s.scenario = scenario;
  const { reportedName, ...data } = parseTessera(s.tree());
  return { ...data, id: 'p', name: reportedName ?? 'p', kind: 'brompton', host: '127.0.0.1', reachable: true, lastSeen: 1, missedPolls: 0 };
}

const keys = (s: ProcessorSnapshot) => evaluate(s, DEFAULT_THRESHOLDS).alerts.map((a) => `${a.severity}:${a.key}`);

describe('evaluate', () => {
  it('is OK for a healthy processor', () => {
    expect(evaluate(snapshot(), DEFAULT_THRESHOLDS)).toEqual({ alerts: [], severity: 'ok' });
  });

  it.each([
    ['signal-loss', 'critical:signal'],
    ['fan-failure', 'critical:fan:case-two'],
    ['hot', 'critical:temp:gpu'],
    ['tiles-offline', 'critical:tiles-offline'],
    ['partner-lost', 'warning:partner'],
    ['failover', 'critical:failover-active'],
  ] as const)('raises an alert for %s', (scenario, expected) => {
    expect(keys(snapshot(scenario))).toContain(expected);
  });

  it('treats a backup that has taken over as a warning on the backup itself', () => {
    expect(keys(snapshot('failover', 'backup'))).toContain('warning:failover-active');
  });

  it('warns on one missed poll and goes critical after the threshold', () => {
    const base = { ...snapshot(), reachable: false, lastError: 'timeout' };
    expect(evaluate({ ...base, missedPolls: 1 }, DEFAULT_THRESHOLDS).severity).toBe('warning');
    const down = evaluate({ ...base, missedPolls: 3 }, DEFAULT_THRESHOLDS);
    expect(down.severity).toBe('critical');
    expect(down.alerts).toHaveLength(1); // stale readings are not judged
  });

  it('is unknown before the first poll', () => {
    const fresh: ProcessorSnapshot = { id: 'x', name: 'x', kind: 'brompton', host: 'h', reachable: false, missedPolls: 0, temperatures: [], fans: [], inputs: [], loops: [] };
    expect(evaluate(fresh, DEFAULT_THRESHOLDS).severity).toBe('unknown');
  });

  it('keeps the start time of an alert that is still going', () => {
    const first = evaluate(snapshot('signal-loss'), DEFAULT_THRESHOLDS, [], 1000);
    const second = evaluate(snapshot('signal-loss'), DEFAULT_THRESHOLDS, first.alerts, 9000);
    expect(second.alerts[0].since).toBe(1000);
  });

  it('flags tiles on mixed firmware', () => {
    const s = snapshot();
    s.tiles = { associated: 4, online: 4, errors: 0, firmware: { '3.5.2': 3, '3.4.9': 1 } };
    expect(keys(s)).toContain('warning:tile-firmware');
  });
});

describe('loopAlerts', () => {
  it('only reports a loop that was found before and is now lost', () => {
    const seen = new Set<number>();
    expect(loopAlerts(snapshot(), seen)).toEqual([]);
    expect([...seen]).toEqual([0, 1]);
    const broken = loopAlerts(snapshot('loop-broken'), seen);
    expect(broken.map((a) => a.key)).toEqual(['loop:0']);
  });

  it('does not report loops that were never cabled', () => {
    expect(loopAlerts(snapshot('loop-broken'), new Set())).toEqual([]);
  });
});
