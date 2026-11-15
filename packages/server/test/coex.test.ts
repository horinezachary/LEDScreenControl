import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { CoexSimulator, type CoexScenario } from '../src/sim/coex.js';
import { parseCoex, unwrap } from '../src/drivers/coex.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const sim = new CoexSimulator({ name: 'IMAG Left', serial: '7', seed: 4 });
  const port = await sim.listen();
  cleanups.push(() => sim.close());
  const monitor = new Monitor(parseConfig({ requestTimeoutMs: 1000, processors: [{ id: 'imag', kind: 'coex', host: '127.0.0.1', port }] }));
  const poll = async (s?: CoexScenario) => {
    if (s) sim.scenario = s;
    return monitor.pollOnce('imag');
  };
  return { sim, monitor, poll };
}

describe('COEX driver', () => {
  it('unwraps answers and reports refusals', () => {
    expect(unwrap({ code: 0, data: { a: 1 }, message: 'ok' })).toEqual({ a: 1 });
    expect(unwrap({ list: 1 })).toEqual({ list: 1 });
    expect(() => unwrap({ code: 2, data: null, message: 'Device is occupied' }, '/x')).toThrow(/occupied.*VMP/);
  });

  it('reads a healthy MX40 Pro', async () => {
    const { poll } = await setup();
    const p = await poll();
    expect(p).toMatchObject({
      reachable: true,
      name: 'IMAG Left',
      model: 'NovaStar MX40 Pro',
      serial: '7',
      firmware: 'V1.5.2',
      brightness: 80,
      brightnessUnit: '%',
      blackout: false,
      freeze: false,
      preset: { number: 1, name: 'Show' },
      tiles: { associated: 64, online: 64, errors: 0 },
      severity: 'ok',
    });
    expect(p.inputs.find((i) => i.active)).toMatchObject({ label: 'HDMI 1', signal: true, width: 1920, rate: 59.94 });
    expect(p.fans).toHaveLength(2);
    expect(p.temperatures[0]).toMatchObject({ key: 'main-board', label: 'Main board' });
  });

  it('builds the wall from cabinets with a load per port', async () => {
    const { poll, monitor } = await setup();
    await poll();
    const wall = monitor.wallViews()[0];
    expect(wall).toMatchObject({ id: 'proc:imag', source: 'processor', name: 'IMAG Left screen', severity: 'ok' });
    const chains = wall.groups[0].chains;
    expect(chains).toHaveLength(8);
    expect(chains[0]).toMatchObject({ label: 'Port 1', tileCount: 8, loop: 'none', from: { label: '1', state: 'ok' } });
    expect(chains[0].from.load).toEqual({ pixels: 8 * 256 * 256, capacity: 650_000, percent: (8 * 65536 * 100) / 650_000 });
    expect(chains[0].tiles[0].label).toBe('Cabinet 1 (port 1, #1 in chain)');
  });

  it.each([
    ['signal-loss', 'critical:signal'],
    ['cabinet-offline', 'critical:tiles-offline'],
    ['cabinet-hot', 'warning:tile-errors'],
    ['link-broken', 'warning:link:screen-1:1'],
    ['fan-failure', 'critical:fan:fan-1'],
    ['port-overload', 'critical:port-load:screen-1:6'],
    ['port-down', 'critical:port:screen-1:5'],
  ] as const)('raises an alert for %s', async (scenario, expected) => {
    const { poll } = await setup();
    const p = await poll(scenario);
    expect(p.alerts.map((a) => `${a.severity}:${a.key}`)).toContain(expected);
  });

  it('marks the cabinets that stopped answering on the wall', async () => {
    const { poll, monitor } = await setup();
    await poll('cabinet-offline');
    const port3 = monitor.wallViews()[0].groups[0].chains[2];
    expect(port3.tiles.map((t) => t.severity)).toEqual(['ok', 'ok', 'ok', 'ok', 'critical', 'critical', 'critical', 'critical']);
    expect(port3.notes).toContain('4 cabinets not responding.');
  });

  it('says when VMP holds the processor', async () => {
    const { poll } = await setup();
    const p = await poll('vmp-busy');
    expect(p.lastError).toMatch(/VMP/);
  });

  it('copes with answers missing most fields', () => {
    const d = parseCoex({ hw: {}, monitor: {} });
    expect(d).toMatchObject({ temperatures: [], fans: [], inputs: [], loops: [], tiles: undefined, topology: undefined });
  });

  it('takes a port capacity from the settings', () => {
    const sim = new CoexSimulator({ name: 'x', serial: '1' });
    const d = parseCoex({ hw: {}, monitor: sim.monitor(), screen: sim.screen() }, 1_000_000);
    expect(d.topology?.groups[0].chains[0].from.load?.percent).toBeCloseTo(52.4, 1);
  });
});
