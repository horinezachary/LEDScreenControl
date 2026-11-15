import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { CoexSimulator, type CoexScenario } from '../src/sim/coex.js';
import { cardErrorCounts, parseCoex, unwrap } from '../src/drivers/coex.js';

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
    expect(chains[0].tiles[0].label).toBe('Port 1, cabinet 1');
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

describe('a real CX40 Pro with 5G ports', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/coex-cx40pro-5g.json', import.meta.url), 'utf8'));
  const chainsOf = (d: ReturnType<typeof parseCoex>) => d.topology!.groups[0].chains;

  it('measures each port against 5G at the output frame rate', () => {
    const d = parseCoex(fx);
    const chains = chainsOf(d);
    expect(chains.map((c) => c.label)).toEqual(['Port 1', 'Port 3', 'Port 5']);
    expect(chains.map((c) => c.tileCount)).toEqual([4, 8, 8]);
    expect(chains[1].from.load).toEqual({ pixels: 8 * 320 * 320, capacity: 3_250_000, percent: (8 * 102_400 * 100) / 3_250_000 });
    expect(chains.every((c) => c.from.state === 'ok')).toBe(true);
    expect(d.topology!.notes).toContain('Port capacity 3,250,000 pixels: 5G ports at 60 Hz, 8 bit.');
  });

  it('halves the capacity at 120 Hz, and takes the capacity from Settings when set', () => {
    expect(chainsOf(parseCoex({ ...fx, output: [{ currentFrameRate: 120 }] }))[0].from.load?.capacity).toBe(1_625_000);
    expect(chainsOf(parseCoex(fx, 2_000_000))[0].from.load?.capacity).toBe(2_000_000);
    expect(chainsOf(parseCoex({ ...fx, hw: { ...fx.hw, netPortBandWidth: undefined } }))[0].from.load?.capacity).toBe(650_000);
  });

  it('finds the HDMI input the show is on, and signal from sourceStatus', () => {
    const inputs = parseCoex(fx).inputs;
    expect(inputs.filter((i) => i.active).map((i) => i.label)).toEqual(['HDMI2.0 2']);
    expect(inputs.find((i) => i.active)).toMatchObject({ key: '1', signal: true, width: 3840, height: 2160, rate: 60 });
    expect(inputs.filter((i) => i.signal).map((i) => i.label)).toEqual(['HDMI2.0 2', 'internal-source']);
    expect(inputs.find((i) => i.label === '12G-SDI 2')).toMatchObject({ signal: false, width: undefined });
  });

  it('labels cabinets by port and chain position, with the receiving card temperature', () => {
    const tile = chainsOf(parseCoex(fx))[0].tiles[0];
    expect(tile.label).toBe('Port 1, cabinet 1');
    expect(tile.detail).toBe('1 receiving card error');
  });
});

describe('resetting receiving card error counts', () => {
  it('flags only errors counted since the reset, and remembers the reset after a restart', async () => {
    const sim = new CoexSimulator({ name: 'IMAG Left', serial: '7', seed: 4 });
    const port = await sim.listen();
    cleanups.push(() => sim.close());
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ledmon-coex-'));
    const config = parseConfig({ requestTimeoutMs: 1000, processors: [{ id: 'imag', kind: 'coex', host: '127.0.0.1', port }] });
    const monitor = new Monitor(config, dataDir);
    sim.cardErrors = 5;
    let p = await monitor.pollOnce('imag');
    expect(p.alerts.map((a) => a.key)).toContain('tile-errors');
    expect(p.controls?.resetErrors).toBe(true);

    p = await monitor.control('imag', { action: 'resetErrors' }, 'test');
    expect(p.alerts.map((a) => a.key)).not.toContain('tile-errors');
    expect(sim.writes).toHaveLength(0);
    expect(monitor.events.recent().some((e) => /error counts reset/.test(e.message))).toBe(true);

    // A new monitor (the app restarted) still knows about the reset.
    sim.cardErrors = 7;
    const again = new Monitor(config, dataDir);
    p = await again.pollOnce('imag');
    expect(p.alerts.map((a) => a.key)).toContain('tile-errors');
    const tile = again.wallViews()[0].groups[0].chains[0].tiles[0];
    expect(tile.detail).toBe('2 receiving card errors since the reset');
  });

  it('counts everything again when the processor clears its own counters', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/coex-cx40pro-5g.json', import.meta.url), 'utf8'));
    const counts = cardErrorCounts(fx.monitor);
    expect([...counts.values()].filter((n) => n > 0)).toHaveLength(17);
    expect(parseCoex(fx, undefined, { counts, since: Date.now() }).tiles?.errors).toBe(0);
    const raised = new Map(counts).set('7402938792148992', 100);
    expect(parseCoex(fx, undefined, { counts: raised, since: Date.now() }).tiles?.errors).toBe(1);
  });
});
