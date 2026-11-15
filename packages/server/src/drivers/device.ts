// Any other device on the show network with no API the monitor reads, such as a NovaStar fiber converter: it only
// checks that the device accepts a TCP connection (port 80 unless set), so the dashboard says when it drops off.
import net from 'node:net';
import type { ProcessorConfig } from '@ledmon/shared';
import type { Driver, PolledData } from './types.js';

export const DEVICE_PORT = 80;

export function connects(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const socket = net.connect({ host, port });
    const done = (err?: Error) => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => done(new Error('aborted'));
    signal.addEventListener('abort', onAbort);
    socket.on('connect', () => done());
    socket.on('error', (err) => done(err));
  });
}

export function deviceDriver(config: ProcessorConfig): Driver {
  const port = config.port ?? DEVICE_PORT;
  return {
    async poll(signal): Promise<PolledData> {
      await connects(config.host, port, signal);
      return {
        model: 'Network device',
        temperatures: [],
        fans: [],
        inputs: [],
        loops: [],
        note: `Only checked for an answer on port ${port}; this device has no API the monitor reads.`,
      };
    },
  };
}
