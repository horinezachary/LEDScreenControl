import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTessera, parseUptime } from '../src/drivers/brompton.js';
import { TesseraSimulator } from '../src/sim/tessera.js';

function sim(scenario: TesseraSimulator['scenario'] = 'normal') {
  const s = new TesseraSimulator({ name: 'Stage Main', serial: '900001', role: 'primary', partnerName: 'Stage Backup', partnerSerial: '900002', seed: 7 });
  s.scenario = scenario;
  return s;
}

describe('parseTessera', () => {
  it('reads identity, temperatures, fans, inputs and redundancy from a 3.5.2-shaped tree', () => {
    const d = parseTessera(sim().tree());
    expect(d.reportedName).toBe('Stage Main');
    expect(d.model).toBe('Tessera SX40');
    expect(d.serial).toBe('900001');
    expect(d.firmware).toBe('3.5.2.15');
    expect(d.temperatures.map((t) => t.label)).toContain('Ethernet SFP A');
    expect(d.temperatures.find((t) => t.key === 'gpu')?.unit).toBe('°C');
    expect(d.fans.map((f) => f.label)).toEqual(['Case 1 fan', 'Case 2 fan', 'FPGA fan']);
    const active = d.inputs.find((i) => i.active);
    expect(active).toMatchObject({ label: 'SDI 1', signal: true, width: 3840, height: 2160, rate: 59.94 });
    expect(d.inputs.find((i) => i.label === 'HDMI 1')).toMatchObject({ key: 'hdmi:1', signal: false, width: undefined });
    expect(d.presets?.map((p) => p.name)).toEqual(['Show Config', 'Rehearsal', 'Walk-in', 'Test']);
    expect(d.failover).toMatchObject({ enabled: true, role: 'primary', active: false, partnerPresent: true, partnerName: 'Stage Backup' });
    expect(d.loops[0]).toEqual({ index: 1, key: '1:A1', port: 'A1', to: 'B1', state: 'loop-found: A1->B1', found: true });
    expect(d.loops).toHaveLength(20);
    expect(d.devices?.map((x) => x.id)).toEqual(['XD-A-DEMO', 'XD-B-DEMO', 'XD-C-DEMO', 'XD-D-DEMO']);
    expect(d.tiles).toEqual({ associated: 160, online: 160, errors: 0, firmware: { '3.5.2': 1 } });
    expect(d.preset).toEqual({ number: 1, name: 'Show Config' });
    expect(d.genlock).toEqual({ source: 'input', rate: 59.94 });
    expect(d.blackout).toBe(false);
  });

  it('marks the active input as having no signal when Tessera reports -1', () => {
    const active = parseTessera(sim('signal-loss').tree()).inputs.find((i) => i.active);
    expect(active).toMatchObject({ signal: false, width: undefined, rate: undefined });
  });

  it('reads a stopped fan', () => {
    const fan = parseTessera(sim('fan-failure').tree()).fans.find((f) => f.key === 'case-two');
    expect(fan).toMatchObject({ running: false, rpm: 0 });
  });

  it('tolerates numbers sent as strings and missing branches', () => {
    const d = parseTessera({ api: { system: { 'serial-number': 22582, 'processor-type': 'sx40' }, devices: { statistics: { 'associated-count': '10', 'online-count': '9', 'error-count': '0' } } } });
    expect(d.serial).toBe('22582');
    expect(d.tiles).toMatchObject({ associated: 10, online: 9 });
    expect(d.inputs).toEqual([]);
    expect(d.failover).toBeUndefined();
  });

  it('explains a response without an api tree', () => {
    expect(() => parseTessera({ error: 'nope' })).toThrow(/IP control/);
  });
});

describe('parseUptime', () => {
  it('prefers the seconds figure', () => {
    expect(parseUptime('50d 1215h 71607m 4294997s')).toBe(4294997);
    expect(parseUptime('3d')).toBe(259200);
    expect(parseUptime(undefined)).toBeUndefined();
  });
});

describe('a real Tessera SX40 on 3.5.2', () => {
  // Captured read-only from Zac's SX40 on 2026-11-12 (test/fixtures/README.md).
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tessera-sx40-3.5.2.json'), 'utf8')) as unknown;
  const d = parseTessera(real);

  it('reads identity, uptime and project', () => {
    expect(d).toMatchObject({ reportedName: 'Running_Primary (108)', model: 'Tessera SX40', serial: '022209', firmware: '3.5.2', project: 'Investors_Running.ffb' });
    expect(d.uptimeSeconds).toBe(2 * 3600 + 43 * 60 + 1);
  });

  it('marks the active input, whose ports are listed from 0 but numbered from 1', () => {
    expect(d.inputs.find((i) => i.active)).toMatchObject({ label: 'HDMI 1', key: 'hdmi:1', signal: true, width: 3904, height: 2300, rate: 59.9 });
    expect(d.inputs.find((i) => i.label === 'SDI 1')).toMatchObject({ active: false, signal: false });
  });

  it('splits a combined loop state into one loop per chain', () => {
    expect(d.loops.map((l) => [l.key, l.found, l.to])).toEqual([
      ['1:A1', true, 'B1'],
      ['2:C1', false, undefined],
      ['2:C2', false, undefined],
      ['2:C4', true, 'D4'],
      ['2:C5', true, 'D5'],
      ['2:D1', false, undefined],
      ['2:D3', false, undefined],
    ]);
  });

  it('treats preset 0 as none loaded, and reads tiles, boxes, temperatures and failover', () => {
    expect(d.preset).toBeUndefined();
    expect(d.presets).toEqual([{ number: 1, name: 'Preset 1' }]);
    expect(d.tiles).toEqual({ associated: 81, online: 81, errors: 0, firmware: { '3.5.1 3.5.1 r1': 79, '3.5.3 3.5.3 r1': 2 } });
    expect(d.devices?.map((x) => x.id)).toEqual(['017680', '017692', '019345', '019346']);
    expect(d.temperatures.find((t) => t.key === 'ethernet.copper.a')?.value).toBe(65);
    expect(d.genlock).toEqual({ source: 'internal', rate: 30 });
    expect(d.failover).toMatchObject({ enabled: false, role: 'primary', active: false, partnerPresent: true, partnerName: 'Running_Backup (107)', partnerSerial: '022770' });
  });

  it('reads the uptime formats seen so far', () => {
    expect(parseUptime('2h 43m 1s')).toBe(9781);
    expect(parseUptime('3d 4h 0m 5s')).toBe(3 * 86400 + 4 * 3600 + 5);
    expect(parseUptime('50d 1215h 71607m 4294997s')).toBe(4294997);
    expect(parseUptime('')).toBeUndefined();
  });
});
