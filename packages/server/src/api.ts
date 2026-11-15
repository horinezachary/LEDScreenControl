// The JSON API behind the dashboard. Reading is open to everyone on the network, and so are processor controls (as
// designed). Settings need the admin session cookie from the password.
//
//   GET  /api/state                         whole dashboard state (also pushed over /ws)
//   GET  /api/events[.csv]                  event log search
//   GET  /api/processors/:id/history        chart data, ?range=1h|24h|7d
//   POST /api/processors/:id/control        {action, value}
//   GET  /api/auth                          is this browser unlocked, is a password set
//   POST /api/auth/login | logout | password
//   GET  /api/settings, PUT /api/settings   admin only
//   POST /api/settings/test-email           admin only
//   POST /api/scan                          admin only, {subnet}
import type http from 'node:http';
import type { AuthStatus, ControlRequest, EmailSettings } from '@ledmon/shared';
import { Auth, AuthError, COOKIE, isLocal, MIN_PASSWORD, readCookie } from './auth.js';
import { ConfigError, parseConfig, saveConfig, type Config } from './config.js';
import { eventsCsv, type EventFilter } from './events.js';
import { RANGES, type Range } from './history.js';
import { ControlError, type Monitor } from './monitor.js';
import { isSubnet, localSubnets, scanSubnet } from './scan.js';
import { smtpSender } from './alerter.js';

export const MASK = '********';

export interface ApiContext {
  monitor: Monitor;
  auth: Auth;
  /** Where config.json lives; settings cannot be saved without it. */
  dataDir?: string;
  /** Called after new settings are saved, to apply them. */
  onSettings?: (config: Config) => void;
  /** For tests: replaces SMTP for the test email. */
  testMail?: (settings: EmailSettings) => Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleApi(ctx: ApiContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  try {
    await route(ctx, req, res, url);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof AuthError || err instanceof ControlError ? err.status : err instanceof ConfigError ? 400 : 500;
    if (status === 500) console.error(err);
    json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : (err as Error).message });
  }
}

async function route(ctx: ApiContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const { monitor, auth } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;
  const address = req.socket.remoteAddress ?? '';
  const token = readCookie(req.headers.cookie, COOKIE);

  if (method === 'GET' && p === '/api/state') return json(res, 200, monitor.state());

  if (method === 'GET' && (p === '/api/events' || p === '/api/events.csv')) {
    const events = monitor.events.search(eventFilter(url.searchParams));
    if (p.endsWith('.csv')) {
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="led-monitor-events-${stamp}.csv"`,
        'cache-control': 'no-store',
      });
      res.end(eventsCsv(events));
      return;
    }
    return json(res, 200, events);
  }

  const proc = /^\/api\/processors\/([^/]+)\/(history|control)$/.exec(p);
  if (proc) {
    const id = decodeURIComponent(proc[1]);
    if (!monitor.state().processors.some((x) => x.id === id)) throw new HttpError(404, 'No such processor.');
    if (proc[2] === 'history' && method === 'GET') {
      const range = (url.searchParams.get('range') ?? '1h') as Range;
      if (!(range in RANGES)) throw new HttpError(400, 'range must be 1h, 24h or 7d.');
      return json(res, 200, monitor.history.series(id, range));
    }
    if (proc[2] === 'control' && method === 'POST') {
      const body = await readJson(req);
      const view = await monitor.control(id, controlRequest(body), who(req));
      return json(res, 200, view);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (p === '/api/auth' && method === 'GET') return json(res, 200, status(auth, token, address));
  if (p === '/api/auth/login' && method === 'POST') {
    const { password } = (await readJson(req)) as { password?: unknown };
    if (typeof password !== 'string') throw new HttpError(400, 'Enter the password.');
    const t = auth.login(password, address);
    setCookie(res, t);
    monitor.events.add({ level: 'info', message: `Settings unlocked from ${who(req)}` });
    return json(res, 200, status(auth, t, address));
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    auth.logout(token);
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(res, 200, status(auth, undefined, address));
  }
  if (p === '/api/auth/password' && method === 'POST') {
    const { current, next } = (await readJson(req)) as { current?: unknown; next?: unknown };
    if (typeof next !== 'string' || next.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters.`);
    if (auth.passwordSet) {
      if (!auth.touch(token)) throw new HttpError(401, 'Unlock the settings first.');
      if (typeof current !== 'string' || !auth.check(current)) throw new HttpError(401, 'The current password is wrong.');
    } else if (!isLocal(address)) {
      throw new HttpError(403, 'Set the first password from the computer running LED Monitor (open the dashboard there).');
    }
    auth.setPassword(next);
    const t = auth.startSession();
    setCookie(res, t);
    monitor.events.add({ level: 'info', message: `Settings password ${current ? 'changed' : 'set'} from ${who(req)}` });
    return json(res, 200, status(auth, t, address));
  }

  if (p.startsWith('/api/settings') || p === '/api/scan') {
    if (!auth.touch(token)) throw new HttpError(401, 'Unlock the settings with the password first.');

    if (p === '/api/settings' && method === 'GET') return json(res, 200, { config: masked(monitor.settings), subnets: localSubnets() });
    if (p === '/api/settings' && method === 'PUT') {
      if (!ctx.dataDir) throw new HttpError(409, 'This server has no settings folder to save to.');
      const body = (await readJson(req)) as Record<string, unknown>;
      const raw = unmask(body, monitor.settings);
      const config = parseConfig(raw);
      saveConfig(ctx.dataDir, config);
      monitor.reconfigure(config);
      ctx.onSettings?.(config);
      monitor.events.add({ level: 'info', message: `Settings saved from ${who(req)}` });
      return json(res, 200, { config: masked(config) });
    }
    if (p === '/api/settings/test-email' && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const merged = unmask({ ...monitor.settings, email: { ...(body.email as object), enabled: true } }, monitor.settings);
      const { email } = parseConfig(merged);
      const send = ctx.testMail ?? (async (s: EmailSettings) => smtpSender(s)({ from: s.from, to: s.to, subject: '[LED Monitor] Test email', text: 'This is a test from LED Monitor. Alert emails will look like this one and come from the same address.' }));
      try {
        await send(email);
      } catch (err) {
        throw new HttpError(502, `The mail server said: ${(err as Error).message}`);
      }
      return json(res, 200, { sent: email.to });
    }
    if (p === '/api/scan' && method === 'POST') {
      const { subnet } = (await readJson(req)) as { subnet?: unknown };
      if (typeof subnet !== 'string' || !isSubnet(subnet)) throw new HttpError(400, 'Give the first three parts of an address, like 10.10.20.');
      const known = new Set(monitor.settings.processors.map((x) => x.host));
      return json(res, 200, await scanSubnet(subnet, known));
    }
    throw new HttpError(404, 'Not found.');
  }

  throw new HttpError(404, 'Not found.');
}

function status(auth: Auth, token: string | undefined, address: string): AuthStatus {
  const unlocked = auth.touch(token);
  return {
    unlocked,
    passwordSet: auth.passwordSet,
    canSetFirstPassword: !auth.passwordSet && isLocal(address),
    expiresInMinutes: unlocked ? auth.minutesLeft(token) : undefined,
  };
}

function setCookie(res: http.ServerResponse, token: string): void {
  // No Max-Age: the cookie ends with the browser session, and the server ends it after 30 idle minutes anyway.
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
}

/** The settings as the settings page sees them: the SMTP password replaced by a mask. */
export function masked(c: Config): Config {
  return { ...c, email: { ...c.email, pass: c.email.pass ? MASK : undefined } };
}

/** Puts the stored SMTP password back where the page sent the mask. */
function unmask(body: Record<string, unknown>, current: Config): Record<string, unknown> {
  const email = (body.email ?? {}) as Record<string, unknown>;
  if (email.pass === MASK) return { ...body, email: { ...email, pass: current.email.pass } };
  return body;
}

function who(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function controlRequest(body: unknown): ControlRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.action) {
    case 'brightness':
    case 'preset':
      if (typeof b.value !== 'number' || !Number.isFinite(b.value)) throw new HttpError(400, `${b.action} needs a number.`);
      return { action: b.action, value: b.value };
    case 'blackout':
    case 'freeze':
      if (typeof b.value !== 'boolean') throw new HttpError(400, `${b.action} needs true or false.`);
      return { action: b.action, value: b.value };
    case 'input':
      if (typeof b.value !== 'string') throw new HttpError(400, 'input needs the input key.');
      return { action: 'input', value: b.value };
    case 'failover':
    case 'reboot':
    case 'resetErrors':
      return { action: b.action };
    default:
      throw new HttpError(400, 'Unknown control.');
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  // Requiring JSON also keeps other sites' plain form posts out (they cannot send this content type cross-site).
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'Too large.');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'That is not valid JSON.');
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function eventFilter(q: URLSearchParams): EventFilter {
  const num = (k: string) => (q.get(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
  const levels = q.get('level')?.split(',').filter((l): l is NonNullable<EventFilter['levels']>[number] => ['info', 'ok', 'warning', 'critical'].includes(l));
  const source = q.get('source');
  return {
    processorId: q.get('processor') || undefined,
    levels: levels?.length ? levels : undefined,
    source: source === 'monitor' || source === 'syslog' || source === 'control' ? source : undefined,
    q: q.get('q') || undefined,
    since: num('since'),
    until: num('until'),
    limit: num('limit'),
  };
}
