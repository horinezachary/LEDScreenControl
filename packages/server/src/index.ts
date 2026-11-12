// Starts the whole server: settings, monitor, web layer. Used by the command line (cli.ts) and the launcher app.
import os from 'node:os';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from './config.js';
import { Monitor } from './monitor.js';
import { createHttpServer } from './http.js';
import { startDemoPair, type TesseraSimulator } from './sim/tessera.js';
import { APP_VERSION } from './version.js';

export interface StartOptions {
  /** Folder for config.json and events.jsonl. */
  dataDir: string;
  /** Folder with the built dashboard (packages/web/dist). */
  webRoot?: string;
  /** Overrides the port in config.json. */
  port?: number;
  /** Adds two simulated SX40s (a primary and its backup) next to the configured processors. */
  simulate?: boolean;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** Addresses other people on the network can open, e.g. http://10.10.20.5:8080. */
  urls: string[];
  config: Config;
  monitor: Monitor;
  simulators: TesseraSimulator[];
  close(): Promise<void>;
}

export { APP_VERSION };
export { ConfigError, configPath } from './config.js';

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const config = loadConfig(opts.dataDir);
  const port = opts.port ?? config.port;
  const monitor = new Monitor(config, opts.dataDir);

  const simulators: TesseraSimulator[] = [];
  if (opts.simulate) {
    const { sims, ports } = await startDemoPair();
    simulators.push(...sims);
    sims.forEach((sim, i) => {
      monitor.add({ id: `sim-${sim.options.serial}`, kind: 'brompton', host: '127.0.0.1', port: ports[i] });
    });
    log(`Simulating two SX40s on ports ${ports.join(' and ')}. Faults: GET http://127.0.0.1:${ports[0]}/sim/scenario?set=signal-loss`);
  }

  const server: http.Server = createHttpServer(monitor, opts.webRoot);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  monitor.start();
  monitor.events.add({ level: 'info', message: `Monitor ${APP_VERSION} started, watching ${monitor.state().processors.length} processor(s)` });

  const urls = lanUrls(boundPort);
  log(`LED Monitor ${APP_VERSION} on ${urls.join(', ')}`);

  return {
    port: boundPort,
    urls,
    config,
    monitor,
    simulators,
    async close() {
      monitor.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await Promise.all(simulators.map((s) => s.close()));
    },
  };
}

/** Every IPv4 address of this machine, LAN first, so the launcher can show the link to share. */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  out.push(`http://localhost:${port}`);
  return out;
}
