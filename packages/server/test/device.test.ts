import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { deviceDriver } from '../src/drivers/device.js';

describe('other network devices', () => {
  it('is up while it accepts a connection, and down when it refuses', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const d = deviceDriver({ id: 'fiber', kind: 'device', host: '127.0.0.1', port });
    expect(await d.poll(AbortSignal.timeout(2000))).toMatchObject({ model: 'Network device', temperatures: [] });
    expect(d.capabilities).toBeUndefined();
    await new Promise<void>((r) => server.close(() => r()));
    await expect(d.poll(AbortSignal.timeout(2000))).rejects.toThrow(/ECONNREFUSED/);
  });
});
