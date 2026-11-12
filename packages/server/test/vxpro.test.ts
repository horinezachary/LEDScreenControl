import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { CoexSimulator } from '../src/sim/coex.js';
import { VxSimulator } from '../src/sim/vxpro.js';
import { decodeFrame, loadPreset, readModeId, setBrightness, vxproDriver, VX_REG } from '../src/drivers/vxpro.js';

const hex = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const bytes = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function vx() {
  const sim = new VxSimulator();
  const port = await sim.listen();
  cleanup.push(() => sim.close());
  return { sim, port };
}

describe('VX Pro frames', () => {
  // Every example below is copied from NovaStar's VX Pro Series Control Protocol V1.0.0.
  it('builds the device ID read exactly as NovaStar shows it', () => {
    expect(hex(readModeId())).toBe('55 aa 00 00 fe 00 00 00 00 00 00 00 02 00 00 00 02 00 57 56');
  });

  it('builds brightness frames exactly as NovaStar shows them', () => {
    expect(hex(setBrightness(0))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 00 55 5a');
    expect(hex(setBrightness(10))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 19 6e 5a');
    expect(hex(setBrightness(50))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 7f d4 5a');
    expect(hex(setBrightness(70))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 b2 07 5b');
    expect(hex(setBrightness(90))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 e5 3a 5b');
    expect(hex(setBrightness(100))).toBe('55 aa 00 00 fe ff 01 ff ff ff 01 00 01 00 00 02 01 00 ff 54 5b');
  });

  it('builds preset frames exactly as NovaStar shows them', () => {
    expect(hex(loadPreset(1))).toBe('55 aa 00 00 fe 00 00 00 00 00 01 00 00 01 51 13 01 00 00 ba 56');
    expect(hex(loadPreset(3))).toBe('55 aa 00 00 fe 00 00 00 00 00 01 00 00 01 51 13 01 00 02 bc 56');
    expect(hex(loadPreset(10))).toBe('55 aa 00 00 fe 00 00 00 00 00 01 00 00 01 51 13 01 00 09 c3 56');
  });

  it('reads NovaStar’s example answers', () => {
    const b = decodeFrame(bytes('aa 55 00 00 ff fe 01 ff ff ff 01 00 01 00 00 02 00 00 54 5a'));
    expect(b?.reply).toMatchObject({ ack: 0, address: VX_REG.brightness });
    const p = decodeFrame(bytes('aa 55 00 00 00 fe 00 00 00 00 01 00 00 01 51 13 00 00 b9 56'));
    expect(p?.reply).toMatchObject({ ack: 0, address: VX_REG.preset });
    expect(decodeFrame(bytes('aa 55 00 00 00 fe'))).toBeUndefined();
    expect(() => decodeFrame(bytes('aa 55 00 00 00 fe 00 00 00 00 01 00 00 01 51 13 00 00 b9 57'))).toThrow(/checksum/);
  });
});

describe('VX Pro driver', () => {
  it('sees the processor over the control protocol when it does not answer the COEX API', async () => {
    const { port } = await vx();
    // Port 1 on loopback refuses at once, standing in for a VX Pro without the COEX API.
    const d = vxproDriver({ id: 'v', kind: 'vxpro', host: '127.0.0.1', port }, { coexPort: 1 });
    const data = await d.poll(AbortSignal.timeout(2000));
    expect(data.model).toBe('VX Pro (mode ID 0x0a20)');
    expect(data.presets).toHaveLength(10);
    expect(data.note).toMatch(/only shows that the processor is there/);
    expect(d.capabilities).toEqual({ brightness: { min: 0, max: 100, step: 1, unit: '%' }, preset: true });
  });

  it('sets brightness and loads presets, and refuses the rest', async () => {
    const { sim, port } = await vx();
    const d = vxproDriver({ id: 'v', kind: 'vxpro', host: '127.0.0.1', port }, { coexPort: 0 });
    await d.control!({ action: 'brightness', value: 50 }, AbortSignal.timeout(2000));
    await d.control!({ action: 'preset', value: 3 }, AbortSignal.timeout(2000));
    expect(sim.brightness).toBe(127);
    expect(sim.preset).toBe(3);
    expect(sim.writes.map((w) => w.address)).toEqual([VX_REG.brightness, VX_REG.preset]);
    await expect(d.control!({ action: 'preset', value: 11 }, AbortSignal.timeout(2000))).rejects.toThrow(/1 to 10/);
    await expect(d.control!({ action: 'blackout', value: true }, AbortSignal.timeout(2000))).rejects.toThrow(/only take brightness and preset/);
    expect(sim.writes).toHaveLength(2);
  });

  it('reports a refusal and a silent processor', async () => {
    const { sim, port } = await vx();
    const d = vxproDriver({ id: 'v', kind: 'vxpro', host: '127.0.0.1', port }, { coexPort: 0 });
    sim.scenario = 'refuse';
    await expect(d.control!({ action: 'brightness', value: 20 }, AbortSignal.timeout(2000))).rejects.toThrow(/refused the brightness \(code 1\)/);
    sim.scenario = 'silent';
    await expect(d.poll(AbortSignal.timeout(300))).rejects.toThrow();
  });

  it('reads and controls a VX Pro that answers the COEX API like a COEX processor', async () => {
    const coex = new CoexSimulator({ name: 'VX (COEX API)', serial: '42' });
    const coexPort = await coex.listen();
    cleanup.push(() => coex.close());
    const d = vxproDriver({ id: 'v', kind: 'vxpro', host: '127.0.0.1', port: 1 }, { coexPort });
    const data = await d.poll(AbortSignal.timeout(2000));
    expect(data.temperatures.length).toBeGreaterThan(0);
    expect(d.capabilities?.blackout).toBe(true);
    await d.control!({ action: 'blackout', value: true }, AbortSignal.timeout(2000));
    expect(coex.writes.length).toBe(1);
  });

  it('shows up in the monitor as reachable', async () => {
    const { port } = await vx();
    const monitor = new Monitor(parseConfig({ processors: [{ id: 'v', kind: 'vxpro', host: '127.0.0.1', port }] }), undefined, (p) => vxproDriver(p, { coexPort: 0 }));
    const v = await monitor.pollOnce('v');
    expect(v).toMatchObject({ reachable: true, severity: 'ok', model: 'VX Pro (mode ID 0x0a20)' });
    expect(v.controls?.preset).toBe(true);
  });
});
