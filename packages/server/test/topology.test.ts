import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { demoWall, TesseraSimulator, type Scenario } from '../src/sim/tessera.js';
import { levelOf, parseSyslog } from '../src/syslog.js';
import { startServer } from '../src/index.js';
import { eventsCsv } from '../src/events.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pair() {
  const main = new TesseraSimulator({ name: 'Main', serial: '1', role: 'primary', partnerName: 'Backup', partnerSerial: '2', seed: 1 });
  const backup = new TesseraSimulator({ name: 'Backup', serial: '2', role: 'backup', partnerName: 'Main', partnerSerial: '1', seed: 2 });
  const ports = [await main.listen(), await backup.listen()];
  cleanups.push(() => main.close(), () => backup.close());
  const config = parseConfig({
    requestTimeoutMs: 500,
    processors: [
      { id: 'main', kind: 'brompton', host: '127.0.0.1', port: ports[0] },
      { id: 'backup', kind: 'brompton', host: '127.0.0.1', port: ports[1] },
    ],
    walls: [demoWall('main', 'backup')],
  });
  const monitor = new Monitor(config);
  const pollBoth = async () => {
    await monitor.pollOnce('main');
    await monitor.pollOnce('backup');
    return monitor.wallViews()[0];
  };
  const set = (s: Scenario) => {
    main.scenario = s;
    backup.scenario = s;
  };
  return { main, backup, monitor, pollBoth, set };
}

describe('wall layout in config', () => {
  it('needs known processors and tile counts per port', () => {
    const procs = [{ id: 'm', kind: 'brompton', host: '10.0.0.1' }];
    const group = { left: { name: 'XD A', trunk: 'a' }, chains: [4, 0, 4] };
    const c = parseConfig({ processors: procs, walls: [{ name: 'Wall', primary: 'm', groups: [group] }] });
    expect(c.walls[0]).toMatchObject({ id: 'wall', groups: [{ left: { trunk: 'A', ports: 10 }, chains: [4, 0, 4] }] });
    expect(() => parseConfig({ processors: procs, walls: [{ primary: 'x', groups: [] }] })).toThrow(ConfigError);
    expect(() => parseConfig({ processors: procs, walls: [{ primary: 'm', groups: [{ left: {}, chains: [] }] }] })).toThrow(/name/);
    expect(() =>
      parseConfig({ processors: procs, walls: [{ primary: 'm', groups: [{ left: { name: 'X', ports: 2 }, chains: [1, 1, 1] }] }] }),
    ).toThrow(/3 ports/);
  });
});

describe('topology', () => {
  it('draws the wall with the primary driving and every loop intact', async () => {
    const { pollBoth } = await pair();
    const wall = await pollBoth();
    expect(wall).toMatchObject({ name: 'Main stage wall (simulated)', severity: 'ok', primary: { driving: true }, backup: { driving: false } });
    expect(wall.trunks.map((t) => [t.label, t.fromPrimary, t.fromBackup])).toEqual([
      ['Trunk A', 'ok', 'standby'],
      ['Trunk B', 'ok', 'standby'],
      ['Trunk C', 'ok', 'standby'],
      ['Trunk D', 'ok', 'standby'],
    ]);
    const chains = wall.groups.flatMap((g) => g.chains);
    expect(chains).toHaveLength(20);
    expect(chains.every((c) => c.loop === 'ok' && c.to?.state === 'standby')).toBe(true);
    expect(chains[3]).toMatchObject({ label: 'A4 to B4', tileCount: 8 });
    expect(wall.groups[0].left).toMatchObject({ name: 'XD A', online: true, firmware: '3.5.2' });
    expect(wall.notes).toEqual([]);
  });

  it('pins a broken loop to its chain even though Tessera no longer names the ports', async () => {
    const { pollBoth, set } = await pair();
    await pollBoth();
    set('loop-broken');
    const wall = await pollBoth();
    const a4 = wall.groups[0].chains[3];
    expect(a4).toMatchObject({ loop: 'broken', severity: 'warning', to: { label: 'B4', state: 'lost' } });
    expect(wall.severity).toBe('warning');
    expect(wall.groups[0].chains[2].loop).toBe('ok');
  });

  it('shows the backup driving after failover and when the primary goes away', async () => {
    const { pollBoth, set, main } = await pair();
    await pollBoth();
    set('failover');
    let wall = await pollBoth();
    expect(wall).toMatchObject({ primary: { driving: false }, backup: { driving: true } });
    expect(wall.trunks[0]).toMatchObject({ fromPrimary: 'standby', fromBackup: 'ok' });

    set('normal');
    await main.close();
    wall = await pollBoth();
    expect(wall.backup?.driving).toBe(true);
    expect(wall.trunks[0]).toMatchObject({ fromPrimary: 'lost', fromBackup: 'ok' });
  });

  it('says when tiles are offline but cannot place them', async () => {
    const { pollBoth, set } = await pair();
    set('tiles-offline');
    const wall = await pollBoth();
    expect(wall.notes[0]).toMatch(/13 tiles offline/);
    expect(wall.groups[0].chains[0].tiles[0].severity).toBe('unknown');
  });
});

describe('syslog', () => {
  it('reads both syslog formats', () => {
    expect(parseSyslog('<11>Nov 11 16:00:01 sx40-main tessera[211]: Genlock lost\n')).toEqual({
      severity: 3,
      facility: 1,
      host: 'sx40-main',
      app: 'tessera',
      text: 'Genlock lost',
    });
    expect(parseSyslog('<12>1 2026-11-11T16:00:00Z sx40 tessera - - - Tile 12 not responding')).toMatchObject({
      severity: 4,
      host: 'sx40',
      text: 'Tile 12 not responding',
    });
    expect(parseSyslog('plain text')).toMatchObject({ severity: 6, text: 'plain text' });
    expect([2, 3, 4, 6].map(levelOf)).toEqual(['critical', 'warning', 'warning', 'info']);
  });

  it('logs a syslog line under the processor that sent it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledmon-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ processors: [{ id: 'loc', name: 'Local SX40', kind: 'brompton', host: '127.0.0.1', port: 9 }] }));
    const running = await startServer({ dataDir: dir, port: 0, syslogPort: 0, log: () => {} });
    cleanups.push(() => running.close());
    // syslogPort 0 means off; start one on a free port by hand to send to.
    const { startSyslog } = await import('../src/syslog.js');
    const srv = await startSyslog(0, (addr, msg) => running.monitor.syslog(addr, levelOf(msg.severity), msg.text), () => {});
    cleanups.push(() => srv!.close());
    const client = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => client.send('<11>Nov 11 16:00:01 sx40 tessera: Genlock lost', srv!.port, '127.0.0.1', () => resolve()));
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    const found = running.monitor.events.search({ source: 'syslog' });
    expect(found[0]).toMatchObject({ processorId: 'loc', level: 'warning', message: 'Local SX40 (syslog): Genlock lost' });

    const base = `http://127.0.0.1:${running.port}`;
    const json = (await (await fetch(`${base}/api/events?source=syslog`)).json()) as unknown[];
    expect(json).toHaveLength(1);
    const csv = await (await fetch(`${base}/api/events.csv?q=genlock`)).text();
    expect(csv.split('\r\n')[1]).toMatch(/,warning,syslog,loc,Local SX40 \(syslog\): Genlock lost$/);
  });
});

describe('events', () => {
  it('quotes CSV cells that need it', () => {
    expect(eventsCsv([{ id: 1, time: 0, level: 'info', message: 'a, "b"' }])).toBe(
      'time,level,source,processor,message\r\n1970-01-01T00:00:00.000Z,info,monitor,,"a, ""b"""\r\n',
    );
  });
});
