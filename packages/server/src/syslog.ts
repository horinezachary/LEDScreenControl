// A small syslog receiver. Tessera can send its log to a syslog server (System > Syslog in Tessera), which is the only
// way it reports some things the HTTP API does not, such as genlock lock loss and panel faults. Point it at this
// machine on the port in config.json ("syslogPort", 5514 by default, since 514 needs admin rights on a Mac).
// Every line becomes an event, attributed to the processor whose address it came from.
import dgram from 'node:dgram';

export interface SyslogMessage {
  /** 0 emergency ... 7 debug. */
  severity: number;
  facility: number;
  host?: string;
  app?: string;
  text: string;
}

/** Parses RFC 3164 ("<13>Nov 11 16:00:00 host app: text") and RFC 5424 ("<13>1 2026-11-11T16:00:00Z host app - - - text"). */
export function parseSyslog(raw: string): SyslogMessage {
  const line = raw.replace(/[\r\n]+$/, '');
  const pri = /^<(\d{1,3})>/.exec(line);
  if (!pri) return { severity: 6, facility: 1, text: line.trim() };
  const value = Number(pri[1]);
  const rest = line.slice(pri[0].length);
  const severity = value & 7;
  const facility = value >> 3;

  const v5424 = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\]) ?(.*)$/s.exec(rest);
  if (v5424) {
    const [, , host, app, , , , msg] = v5424;
    return { severity, facility, host: dash(host), app: dash(app), text: msg.replace(/^\uFEFF/, '').trim() };
  }
  const v3164 = /^([A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d) (\S+) (.*)$/s.exec(rest);
  if (v3164) {
    const [, , host, body] = v3164;
    const tag = /^([^:[\s]+)(?:\[\d+\])?: (.*)$/s.exec(body);
    return { severity, facility, host, app: tag?.[1], text: (tag ? tag[2] : body).trim() };
  }
  return { severity, facility, text: rest.trim() };
}

function dash(v: string): string | undefined {
  return v === '-' ? undefined : v;
}

export function levelOf(severity: number): 'info' | 'warning' | 'critical' {
  if (severity <= 2) return 'critical';
  if (severity <= 4) return 'warning';
  return 'info';
}

export interface SyslogServer {
  port: number;
  close(): Promise<void>;
}

export async function startSyslog(
  port: number,
  onMessage: (address: string, msg: SyslogMessage) => void,
  log: (line: string) => void,
): Promise<SyslogServer | undefined> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (buf, rinfo) => {
    // Debug lines would flood the event log.
    const msg = parseSyslog(buf.toString('utf8'));
    if (msg.severity === 7 || !msg.text) return;
    onMessage(rinfo.address, msg);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, '0.0.0.0', () => {
        socket.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // Monitoring works without syslog, so a taken port is reported and skipped rather than stopping the server.
    log(`Syslog not started: port ${port} is not available (${(err as Error).message}).`);
    socket.close();
    return undefined;
  }
  socket.on('error', (err) => log(`Syslog error: ${err.message}`));
  return {
    port: socket.address().port,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
