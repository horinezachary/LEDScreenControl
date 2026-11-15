// A NovaStar VX Pro on its TCP control protocol (port 15200 on a real one): answers the mode ID read, and takes
// brightness and preset writes, as NovaStar's VX Pro Series Control Protocol describes. It does not answer the COEX
// HTTP API, like a VX Pro whose firmware lacks it.
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { checksum, encodeFrame, VX_REG } from '../drivers/vxpro.js';

export type VxScenario = 'normal' | 'refuse' | 'silent';

export class VxSimulator {
  scenario: VxScenario = 'normal';
  /** Mode ID it reports. NovaStar does not publish VX2000 Pro's; this one is made up. */
  modeId = 0x0a20;
  /** Brightness as the processor holds it, 0 to 255. */
  brightness = 204;
  preset = 1;
  /** Every write received, for tests: register address and data. */
  readonly writes: { address: number; data: number[] }[] = [];
  private server?: net.Server;
  private sockets = new Set<net.Socket>();

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = net.createServer((s) => this.serve(s));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 20) {
        if (buf[0] !== 0x55 || buf[1] !== 0xaa) return void socket.destroy();
        const write = buf[10] === 1;
        const length = buf.readUInt16LE(16);
        const total = 18 + (write ? length : 0) + 2;
        if (buf.length < total) return;
        const frame = buf.subarray(0, total);
        buf = buf.subarray(total);
        const answer = this.answer(frame, write, length);
        if (answer) socket.write(answer);
      }
    });
  }

  private answer(frame: Buffer, write: boolean, length: number): Buffer | undefined {
    if (this.scenario === 'silent') return undefined;
    const body = frame.subarray(2, frame.length - 2);
    if (frame.readUInt16LE(frame.length - 2) !== checksum(body)) return undefined;
    const serial = frame[3];
    const address = frame.readUInt32LE(12);
    const reply = (data?: Buffer, ack = 0) =>
      encodeFrame(
        { ack, serial, source: frame[5], destination: 0xfe, deviceType: frame[6], port: frame[7], board: frame.readUInt16LE(8), write, address, data },
        [0xaa, 0x55],
      );
    if (this.scenario === 'refuse') return reply(undefined, 1);
    if (!write) {
      if (address === VX_REG.modeId) {
        const data = Buffer.alloc(Math.max(2, length));
        data.writeUInt16LE(this.modeId, 0);
        return reply(data);
      }
      if (address === VX_REG.brightness) return reply(Buffer.from([this.brightness]));
      return reply(undefined, 2);
    }
    const data = [...frame.subarray(18, 18 + length)];
    this.writes.push({ address, data });
    if (address === VX_REG.brightness) this.brightness = data[0];
    else if (address === VX_REG.preset) this.preset = data[0] + 1;
    else return reply(undefined, 2);
    return reply();
  }
}

export async function startDemoVx(): Promise<{ sim: VxSimulator; port: number }> {
  const sim = new VxSimulator();
  return { sim, port: await sim.listen() };
}
