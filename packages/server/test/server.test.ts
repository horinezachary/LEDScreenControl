import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { DashboardState, ServerMessage } from '@ledmon/shared';
import { parseConfig, ConfigError, loadConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { startServer, type RunningServer } from '../src/index.js';
import { TesseraSimulator } from '../src/sim/tessera.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledmon-'));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('config', () => {
  it('writes a starter file and reads it back', () => {
    const dir = tmp();
    const c = loadConfig(dir);
    expect(c.port).toBe(6060);
    expect(c.processors).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
  });

  it('fills in ids and checks kinds', () => {
    const c = parseConfig({ processors: [{ kind: 'brompton', host: '10.10.20.11' }] });
    expect(c.processors[0].id).toBe('10-10-20-11');
    expect(() => parseConfig({ processors: [{ kind: 'barco', host: 'x' }] })).toThrow(ConfigError);
    expect(() => parseConfig({ processors: [{ kind: 'brompton' }] })).toThrow(/host/);
    expect(() => parseConfig({ port: '80' })).toThrow(/number/);
  });
});

describe('monitor', () => {
  it('polls a simulated processor, then logs a fault and its recovery', async () => {
    const sim = new TesseraSimulator({ name: 'Stage Main', serial: '1', role: 'primary', partnerName: 'B', partnerSerial: '2', seed: 1 });
    const port = await sim.listen();
    cleanups.push(() => sim.close());
    const config = parseConfig({ processors: [{ id: 'main', kind: 'brompton', host: '127.0.0.1', port }] });
    const monitor = new Monitor(config);

    const ok = await monitor.pollOnce('main');
    expect(ok).toMatchObject({ reachable: true, name: 'Stage Main', severity: 'ok' });

    sim.scenario = 'signal-loss';
    const bad = await monitor.pollOnce('main');
    expect(bad.severity).toBe('critical');

    sim.scenario = 'normal';
    await monitor.pollOnce('main');
    const messages = monitor.events.recent().map((e) => e.message);
    expect(messages).toContain('Stage Main: cleared, no signal on the active input (SDI 1)');
    expect(messages).toContain('Stage Main: No signal on the active input (SDI 1)');
    expect(messages.at(-1)).toMatch(/connected \(Tessera SX40, 3\.5\.2\.15\)/);
  });

  it('marks a processor unreachable and keeps its last readings', async () => {
    const sim = new TesseraSimulator({ name: 'Gone', serial: '1', role: 'primary', partnerName: 'B', partnerSerial: '2' });
    const port = await sim.listen();
    const config = parseConfig({ requestTimeoutMs: 500, processors: [{ id: 'p', kind: 'brompton', host: '127.0.0.1', port }] });
    const monitor = new Monitor(config);
    await monitor.pollOnce('p');
    await sim.close();
    const v = await monitor.pollOnce('p');
    expect(v).toMatchObject({ reachable: false, missedPolls: 1, severity: 'warning', serial: '1' });
    expect(v.lastError).toMatch(/refused/);
  });

  it('gives VX Pro processors a driver', () => {
    const config = parseConfig({ processors: [{ id: 'v', kind: 'vxpro', host: '10.0.0.2' }] });
    const state = new Monitor(config).state();
    expect(state.processors[0]).toMatchObject({ severity: 'unknown', lastError: undefined });
  });
});

describe('server', () => {
  it('reports a port in use instead of crashing, and closes with a dashboard tab open', async () => {
    const first: RunningServer = await startServer({ dataDir: tmp(), port: 0, log: () => {} });
    cleanups.push(() => first.close());
    await expect(startServer({ dataDir: tmp(), port: first.port, log: () => {} })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // An open tab keeps a WebSocket and a keep-alive connection; closing must not wait for them.
    const ws = new WebSocket(`ws://127.0.0.1:${first.port}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('message', resolve);
      ws.on('error', reject);
    });
    await fetch(`http://127.0.0.1:${first.port}/api/state`);
    const closed = await Promise.race([first.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(closed).toBe('closed');
    cleanups.pop();
  });

  it('picks a free port when asked for port 0', async () => {
    const running: RunningServer = await startServer({ dataDir: tmp(), port: 0, log: () => {} });
    cleanups.push(() => running.close());
    expect(running.port).toBeGreaterThan(0);
    expect(running.urls.at(-1)).toBe(`http://localhost:${running.port}`);
  });

  it('serves health and the page, and pushes state over the WebSocket', async () => {
    const running = await startServer({ dataDir: tmp(), port: 0, simulate: true, log: () => {} });
    cleanups.push(() => running.close());
    const port = running.port;
    const base = `http://127.0.0.1:${port}`;

    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('id="root"');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(async () => ws.close());
    const state = await new Promise<DashboardState>((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as ServerMessage;
        if (msg.state.processors.every((p) => p.reachable)) resolve(msg.state);
      });
      ws.on('error', reject);
    });
    expect(state.processors.map((p) => p.name).sort()).toEqual(['IMAG Left (simulated)', 'Side Screens (simulated VX2000 Pro)', 'Stage Backup (simulated)', 'Stage Main (simulated)']);
    expect(state.walls.map((w) => w.name)).toEqual(['Main stage wall (simulated)', 'IMAG Left screen']);
    expect(state.severity).toBe('ok');
  }, 15000);
});
