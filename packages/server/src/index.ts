// Starts the whole server: settings, monitor, web layer. Used by the command line (cli.ts) and the launcher app.
import os from 'node:os';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from './config.js';
import { Monitor } from './monitor.js';
import { createHttpServer } from './http.js';
import { demoWall, startDemoPair, type TesseraSimulator } from './sim/tessera.js';
import { startDemoCoex, type CoexSimulator } from './sim/coex.js';
import { startDemoVx, type VxSimulator } from './sim/vxpro.js';
import { vxproDriver } from './drivers/vxpro.js';
import { levelOf, startSyslog, type SyslogServer } from './syslog.js';
import { Auth } from './auth.js';
import { Alerter, type AlertChange } from './alerter.js';
import { APP_VERSION } from './version.js';

export interface StartOptions {
  /** Folder for config.json and events.jsonl. */
  dataDir: string;
  /** Folder with the built dashboard (packages/web/dist). */
  webRoot?: string;
  /** Overrides the port in config.json. */
  port?: number;
  /** Adds two simulated SX40s (a primary and its backup) and a simulated COEX MX40 Pro next to the configured processors. */
  simulate?: boolean;
  /** Overrides syslogPort in config.json (0 turns it off). */
  syslogPort?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** Addresses other people on the network can open, e.g. http://10.10.20.5:8080. */
  urls: string[];
  config: Config;
  monitor: Monitor;
  simulators: (TesseraSimulator | CoexSimulator | VxSimulator)[];
  syslog?: SyslogServer;
  close(): Promise<void>;
}

export { APP_VERSION };
export { ConfigError, configPath } from './config.js';

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const config = loadConfig(opts.dataDir);
  const port = opts.port ?? config.port;
  const monitor = new Monitor(config, opts.dataDir);

  const simulators: (TesseraSimulator | CoexSimulator | VxSimulator)[] = [];
  if (opts.simulate) {
    const { sims, ports } = await startDemoPair();
    simulators.push(...sims);
    sims.forEach((sim, i) => {
      monitor.add({ id: `sim-${sim.options.serial}`, kind: 'brompton', host: '127.0.0.1', port: ports[i] });
    });
    monitor.addWall(demoWall(`sim-${sims[0].options.serial}`, `sim-${sims[1].options.serial}`));
    log(`Simulating two SX40s on ports ${ports.join(' and ')}. Faults: GET http://127.0.0.1:${ports[0]}/sim/scenario?set=signal-loss`);
    const coex = await startDemoCoex();
    simulators.push(coex.sim);
    monitor.add({ id: `sim-${coex.sim.options.serial}`, kind: 'coex', host: '127.0.0.1', port: coex.port });
    log(`Simulating a COEX MX40 Pro on port ${coex.port}. Faults: GET http://127.0.0.1:${coex.port}/sim/scenario?set=port-overload`);
    const vx = await startDemoVx();
    simulators.push(vx.sim);
    const vxConfig = { id: 'sim-vx', name: 'Side Screens (simulated VX2000 Pro)', kind: 'vxpro' as const, host: '127.0.0.1', port: vx.port };
    monitor.add(vxConfig, vxproDriver(vxConfig, { coexPort: 0 }));
    log(`Simulating a VX2000 Pro on TCP port ${vx.port}.`);
  }

  const auth = new Auth(opts.dataDir);
  const alerter = new Alerter(config.email, undefined, (level, message) => monitor.events.add({ level, message }));
  monitor.on('alert', (c: AlertChange) => alerter.handle(c));
  const server: http.Server = createHttpServer(
    { monitor, auth, dataDir: opts.dataDir, onSettings: (c) => alerter.update(c.email) },
    opts.webRoot,
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  const syslogPort = opts.syslogPort ?? config.syslogPort;
  const syslog = syslogPort > 0
    ? await startSyslog(syslogPort, (address, msg) => monitor.syslog(address, levelOf(msg.severity), msg.text), log)
    : undefined;
  monitor.start();
  monitor.events.add({ level: 'info', message: `Monitor ${APP_VERSION} started, watching ${monitor.state().processors.length} processor(s)` });

  const urls = lanUrls(boundPort);
  log(`LED Monitor ${APP_VERSION} on ${urls.join(', ')}`);
  if (syslog) log(`Listening for processor syslog on UDP ${syslog.port}`);

  return {
    port: boundPort,
    urls,
    config,
    monitor,
    simulators,
    syslog,
    async close() {
      monitor.stop();
      await alerter.flush();
      alerter.stop();
      await syslog?.close();
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
