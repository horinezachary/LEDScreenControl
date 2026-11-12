// NovaStar VX Pro processors (VX2000 Pro, VX1000 Pro, VX600 Pro, VX400 Pro).
//
// NovaStar's public "VX Pro Series Control Protocol" (V1.0.0) is TCP on port 15200 and covers three things only:
// reading the device's mode ID, setting brightness, and loading presets 1 to 10. It reports no temperatures, fans,
// inputs or current brightness. So this driver first asks the COEX Open API on HTTP port 8001, in case the VX Pro
// answers it (unverified; newer VX firmware may); if it does, the processor is read and controlled exactly like a COEX
// one. Otherwise it falls back to the binary protocol: the mode ID read shows that the processor is there, and
// brightness and preset can be set.
//
// Frame layout, worked out from the document's examples (every example checksum matches):
//   55 aa | ack | serial | source fe | destination | device type | port | board index (2, LE) | read 00 / write 01 |
//   reserved | register address (4, LE) | data length (2, LE) | data | checksum (2, LE)
// The checksum is the sum of every byte after 55 aa, plus 0x5555. Answers start aa 55 with the same layout; a
// non-zero ack byte means the processor refused.
import net from 'node:net';
import type { ControlCapabilities, ControlRequest, ProcessorConfig } from '@ledmon/shared';
import { coexDriver } from './coex.js';
import type { Driver, PolledData } from './types.js';

export const VX_PORT = 15200;
export const VX_PRESETS = 10;

export interface VxFrame {
  ack?: number;
  serial?: number;
  source?: number;
  destination: number;
  deviceType: number;
  port: number;
  board: number;
  write: boolean;
  address: number;
  /** Data carried: what a write sends, or what a read's answer returns. */
  data?: Buffer;
  /** For a read request, the number of bytes wanted. */
  length?: number;
}

/** Register addresses from NovaStar's examples. */
export const VX_REG = {
  modeId: 0x00000002,
  brightness: 0x02000001,
  preset: 0x13510100,
} as const;

export function checksum(body: Buffer): number {
  let sum = 0x5555;
  for (const b of body) sum += b;
  return sum & 0xffff;
}

export function encodeFrame(f: VxFrame, header = [0x55, 0xaa]): Buffer {
  const data = f.data ?? Buffer.alloc(0);
  const body = Buffer.alloc(16 + data.length);
  body[0] = f.ack ?? 0;
  body[1] = f.serial ?? 0;
  body[2] = f.source ?? 0xfe;
  body[3] = f.destination;
  body[4] = f.deviceType;
  body[5] = f.port;
  body.writeUInt16LE(f.board, 6);
  body[8] = f.write ? 1 : 0;
  body[9] = 0;
  body.writeUInt32LE(f.address >>> 0, 10);
  body.writeUInt16LE(f.data ? data.length : (f.length ?? 0), 14);
  data.copy(body, 16);
  const sum = Buffer.alloc(2);
  sum.writeUInt16LE(checksum(body));
  return Buffer.concat([Buffer.from(header), body, sum]);
}

export interface VxReply {
  ack: number;
  serial: number;
  address: number;
  data: Buffer;
}

/** Reads one frame from the start of buf. Returns undefined while the frame is incomplete; throws on a bad frame. */
export function decodeFrame(buf: Buffer, header = [0xaa, 0x55]): { reply: VxReply; used: number } | undefined {
  if (buf.length < 2) return undefined;
  if (buf[0] !== header[0] || buf[1] !== header[1]) throw new Error('The processor answered with something that is not a VX Pro frame.');
  if (buf.length < 18) return undefined;
  const write = buf[10] === 1;
  const length = buf.readUInt16LE(16);
  // A write's answer carries no data; a read's answer carries the bytes asked for.
  const dataLength = write ? 0 : length;
  const total = 18 + dataLength + 2;
  if (buf.length < total) return undefined;
  const body = buf.subarray(2, 18 + dataLength);
  if (buf.readUInt16LE(18 + dataLength) !== checksum(body)) throw new Error('The processor answered with a bad checksum.');
  return { reply: { ack: buf[2], serial: buf[3], address: buf.readUInt32LE(12), data: Buffer.from(buf.subarray(18, 18 + dataLength)) }, used: total };
}

/** The read-mode-ID request, exactly as NovaStar's example: 55 aa 00 00 fe 00 00 00 00 00 00 00 02 00 00 00 02 00 57 56. */
export const readModeId = (serial = 0) => encodeFrame({ serial, destination: 0, deviceType: 0, port: 0, board: 0, write: false, address: VX_REG.modeId, length: 2 });

/** Brightness 0 to 100 % as the processor's 0 to 255 (rounded down, as NovaStar's table is), sent to every receiving card (destination, port and board ff). */
export const setBrightness = (percent: number, serial = 0) =>
  encodeFrame({ serial, destination: 0xff, deviceType: 1, port: 0xff, board: 0xffff, write: true, address: VX_REG.brightness, data: Buffer.from([Math.floor((Math.min(100, Math.max(0, percent)) * 255) / 100)]) });

/** Preset 1 to 10, sent as 0 to 9. */
export const loadPreset = (preset: number, serial = 0) => encodeFrame({ serial, destination: 0, deviceType: 0, port: 0, board: 0, write: true, address: VX_REG.preset, data: Buffer.from([preset - 1]) });

/** Sends one frame and waits for its answer. One connection per request: the processor serves few clients. */
export function exchange(host: string, port: number, frame: Buffer, signal: AbortSignal): Promise<VxReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err?: Error, reply?: VxReply) => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply!);
    };
    const onAbort = () => done(new Error('aborted'));
    signal.addEventListener('abort', onAbort);
    socket.on('connect', () => socket.write(frame));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const got = decodeFrame(buf);
        if (got) done(undefined, got.reply);
      } catch (err) {
        done(err as Error);
      }
    });
    socket.on('error', (err) => done(err));
    socket.on('end', () => done(new Error('The processor closed the connection without answering.')));
  });
}

const TCP_CAPS: ControlCapabilities = { brightness: { min: 0, max: 100, step: 1, unit: '%' }, preset: true };
const PRESETS = Array.from({ length: VX_PRESETS }, (_, i) => ({ number: i + 1, name: `Preset ${i + 1}` }));
/** How often a processor on the binary protocol is asked again whether it answers the COEX API. */
const COEX_RETRY_MS = 10 * 60_000;

export interface VxOptions {
  /** HTTP port of the COEX Open API to try first; 0 skips it. */
  coexPort?: number;
  /** Passed to the COEX driver, which keeps error count resets there. */
  dataDir?: string;
}

export function vxproDriver(config: ProcessorConfig, opts: VxOptions = {}): Driver {
  const coexPort = opts.coexPort ?? 8001;
  const coex = coexPort ? coexDriver({ ...config, port: coexPort }, { dataDir: opts.dataDir }) : undefined;
  const tcpPort = config.port ?? VX_PORT;
  let mode: 'unknown' | 'coex' | 'tcp' = coex ? 'unknown' : 'tcp';
  let lastCoexTry = 0;
  let serial = 0;
  const next = () => (serial = (serial + 1) & 0xff);

  const send = async (frame: Buffer, signal: AbortSignal, what: string) => {
    const reply = await exchange(config.host, tcpPort, frame, signal);
    if (reply.ack !== 0) throw new Error(`The processor refused ${what} (code ${reply.ack}).`);
    return reply;
  };

  return {
    get capabilities() {
      return mode === 'coex' ? coex!.capabilities : TCP_CAPS;
    },
    async control(req: ControlRequest, signal) {
      if (mode === 'coex') return coex!.control!(req, signal);
      if (req.action === 'brightness') await send(setBrightness(req.value, next()), signal, 'the brightness');
      else if (req.action === 'preset') {
        if (!Number.isInteger(req.value) || req.value < 1 || req.value > VX_PRESETS) throw new Error(`VX Pro presets are 1 to ${VX_PRESETS}.`);
        await send(loadPreset(req.value, next()), signal, `preset ${req.value}`);
      } else throw new Error('VX Pro processors only take brightness and preset over their control protocol.');
    },
    async poll(signal): Promise<PolledData> {
      if (coex && (mode === 'unknown' || (mode === 'tcp' && Date.now() - lastCoexTry > COEX_RETRY_MS))) {
        lastCoexTry = Date.now();
        try {
          const data = await coex.poll(signal);
          mode = 'coex';
          return data;
        } catch (err) {
          if (signal.aborted) throw err;
          mode = 'tcp';
        }
      }
      if (mode === 'coex') {
        try {
          return await coex!.poll(signal);
        } catch (err) {
          // If the COEX API stops answering but the binary protocol does, carry on with that.
          if (signal.aborted) throw err;
          mode = 'tcp';
        }
      }
      const reply = await send(readModeId(next()), signal, 'the device ID read');
      const id = reply.data.length >= 2 ? reply.data.readUInt16LE(0) : reply.data[0];
      return {
        model: `VX Pro (mode ID 0x${(id ?? 0).toString(16).padStart(4, '0')})`,
        presets: PRESETS,
        temperatures: [],
        fans: [],
        inputs: [],
        loops: [],
        note: 'The VX Pro control protocol only shows that the processor is there: no temperatures, fans, inputs or current brightness.',
      };
    },
  };
}
