import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Alert, EmailSettings, ProcessorView } from '@ledmon/shared';
import { Auth, isLocal, readCookie } from '../src/auth.js';
import { Alerter, compose, type AlertChange } from '../src/alerter.js';
import { DEFAULT_EMAIL, parseConfig, saveConfig } from '../src/config.js';
import { History } from '../src/history.js';
import { Monitor } from '../src/monitor.js';
import { createHttpServer } from '../src/http.js';
import { TesseraSimulator } from '../src/sim/tessera.js';
import { CoexSimulator } from '../src/sim/coex.js';
import { bromptonCommands } from '../src/drivers/brompton.js';
import { coexCommands } from '../src/drivers/coex.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledmon-'));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function rig(extra: Record<string, unknown> = {}) {
  const tessera = new TesseraSimulator({ name: 'Main', serial: '1', role: 'primary', partnerName: 'B', partnerSerial: '2', seed: 1 });
  const coex = new CoexSimulator({ name: 'IMAG', serial: '7' });
  const [tp, cp] = [await tessera.listen(), await coex.listen()];
  cleanups.push(() => tessera.close(), () => coex.close());
  const dir = tmp();
  const config = parseConfig({
    requestTimeoutMs: 1000,
    processors: [
      { id: 'main', kind: 'brompton', host: '127.0.0.1', port: tp },
      { id: 'imag', kind: 'coex', host: '127.0.0.1', port: cp },
    ],
    ...extra,
  });
  saveConfig(dir, config);
  const monitor = new Monitor(config, dir);
  const auth = new Auth(dir);
  const mails: EmailSettings[] = [];
  const server = createHttpServer({ monitor, auth, dataDir: dir, testMail: async (s) => void mails.push(s) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())), () => monitor.stop());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  await monitor.pollOnce('main');
  await monitor.pollOnce('imag');
  return { tessera, coex, monitor, auth, call, dir, mails, logout: () => (cookie = '') };
}

describe('password and settings', () => {
  it('lets this computer set the first password, then guards the settings with it', async () => {
    const { call, logout } = await rig();
    expect((await call('GET', '/api/auth')).body).toMatchObject({ unlocked: false, passwordSet: false, canSetFirstPassword: true });
    expect((await call('GET', '/api/settings')).status).toBe(401);
    expect((await call('POST', '/api/auth/password', { next: 'short' })).status).toBe(400);
    expect((await call('POST', '/api/auth/password', { next: 'stage-left-42' })).body).toMatchObject({ unlocked: true, passwordSet: true });
    expect((await call('GET', '/api/settings')).status).toBe(200);

    logout();
    expect((await call('GET', '/api/settings')).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { password: 'nope' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { password: 'stage-left-42' })).body).toMatchObject({ unlocked: true });
    expect((await call('POST', '/api/auth/password', { current: 'wrong', next: 'another-one-9' })).status).toBe(401);
    expect((await call('POST', '/api/auth/password', { current: 'stage-left-42', next: 'another-one-9' })).status).toBe(200);
    await call('POST', '/api/auth/logout');
    expect((await call('GET', '/api/auth')).body).toMatchObject({ unlocked: false });
  });

  it('limits wrong guesses per address', () => {
    const auth = new Auth();
    auth.setPassword('correct-horse');
    for (let i = 0; i < 5; i++) expect(() => auth.login('x', '10.0.0.9', 1000)).toThrow(/Wrong/);
    expect(() => auth.login('correct-horse', '10.0.0.9', 2000)).toThrow(/Too many/);
    expect(auth.login('correct-horse', '10.0.0.8', 2000)).toBeTruthy();
    expect(auth.login('correct-horse', '10.0.0.9', 62_000)).toBeTruthy();
  });

  it('ends a session after 30 idle minutes', () => {
    const auth = new Auth();
    const t = auth.startSession(0);
    expect(auth.touch(t, 29 * 60_000)).toBe(true);
    expect(auth.touch(t, 58 * 60_000)).toBe(true);
    expect(auth.touch(t, 89 * 60_000)).toBe(false);
  });

  it('keeps the password hashed in auth.json, out of config.json', async () => {
    const { call, dir } = await rig();
    await call('POST', '/api/auth/password', { next: 'stage-left-42' });
    const stored = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    expect(stored).not.toContain('stage-left-42');
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toContain('stage-left-42');
    expect(new Auth(dir).check('stage-left-42')).toBe(true);
  });

  it('saves settings, applies them at once, and never sends the SMTP password back', async () => {
    const { call, monitor, dir, mails } = await rig();
    await call('POST', '/api/auth/password', { next: 'stage-left-42' });
    const { body } = await call('GET', '/api/settings');
    const config = body.config as Record<string, unknown>;
    const next = {
      ...config,
      thresholds: { ...(config.thresholds as object), tempWarnC: 40 },
      processors: [...(config.processors as object[]), { id: 'new', kind: 'brompton', host: '10.255.0.1' }],
      email: { ...DEFAULT_EMAIL, enabled: true, host: 'smtp.example.org', user: 'ops@example.org', pass: 'smtp-secret', to: ['crew@example.org'] },
    };
    const saved = await call('PUT', '/api/settings', next);
    expect(saved.status).toBe(200);
    expect((saved.body.config as { email: EmailSettings }).email.pass).toBe('********');
    expect(monitor.state().processors.map((p) => p.id)).toEqual(['main', 'imag', 'new']);
    expect(monitor.settings.thresholds.tempWarnC).toBe(40);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).email.pass).toBe('smtp-secret');
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(true);

    // Saving the masked form again keeps the real password.
    const again = (await call('GET', '/api/settings')).body.config as Record<string, unknown>;
    await call('PUT', '/api/settings', again);
    expect(monitor.settings.email.pass).toBe('smtp-secret');

    expect((await call('POST', '/api/settings/test-email', { email: (again as { email: object }).email })).status).toBe(200);
    expect(mails[0]).toMatchObject({ host: 'smtp.example.org', pass: 'smtp-secret', to: ['crew@example.org'] });

    const bad = await call('PUT', '/api/settings', { ...again, processors: [{ kind: 'barco', host: 'x' }] });
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringMatching(/kind/) } });
  });

  it('only treats loopback as this computer, and reads cookies', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(isLocal)).toBe(true);
    expect(isLocal('10.10.20.5')).toBe(false);
    expect(readCookie('a=1; ledmon_admin=x%3Dy', 'ledmon_admin')).toBe('x=y');
  });
});

describe('controls', () => {
  it('maps each control to Tessera requests', () => {
    expect(bromptonCommands({ action: 'brightness', value: 1200.4 })).toEqual([['output/global-colour/brightness', '1200']]);
    expect(bromptonCommands({ action: 'input', value: 'hdmi:1' })).toEqual([
      ['input/active/source/port-type', 'hdmi'],
      ['input/active/source/port-number', '1'],
    ]);
    expect(bromptonCommands({ action: 'failover' })).toEqual([['output/network/failover/actions/request-failover', '']]);
    expect(coexCommands({ action: 'freeze', value: true }, [{ id: 's1' }])).toEqual([
      { method: 'PUT', path: '/api/v1/screen/output/displaymode', body: { value: 2, screenIdList: ['s1'] } },
    ]);
  });

  it('sends Brompton controls without a password, logs who asked and shows the result', async () => {
    const { call, tessera, monitor } = await rig();
    let r = await call('POST', '/api/processors/main/control', { action: 'brightness', value: 900 });
    expect(r.status).toBe(200);
    expect((r.body as unknown as ProcessorView).brightness).toBe(900);
    await call('POST', '/api/processors/main/control', { action: 'blackout', value: true });
    await call('POST', '/api/processors/main/control', { action: 'preset', value: 2 });
    r = await call('POST', '/api/processors/main/control', { action: 'input', value: 'sdi:2' });
    expect((r.body as unknown as ProcessorView).inputs.find((i) => i.active)?.label).toBe('SDI 2');
    await call('POST', '/api/processors/main/control', { action: 'failover' });
    expect(tessera.writes.map(([p, v]) => `${p}=${v}`)).toEqual([
      'output/global-colour/brightness=900',
      'override/blackout/enabled=true',
      'presets/active/number=2',
      'input/active/source/port-type=sdi',
      'input/active/source/port-number=2',
      'output/network/failover/actions/request-failover=',
    ]);
    const view = monitor.state().processors.find((p) => p.id === 'main')!;
    expect(view).toMatchObject({ blackout: true, preset: { number: 2, name: 'Rehearsal' }, failover: { active: true } });
    const log = monitor.events.search({ source: 'control' }).map((e) => e.message);
    expect(log).toContain('Main: blackout on, from 127.0.0.1');
    expect(log).toContain('Main: preset 2 "Rehearsal" loaded, from 127.0.0.1');
  });

  it('sends COEX controls to every screen', async () => {
    const { call, coex } = await rig();
    await call('POST', '/api/processors/imag/control', { action: 'brightness', value: 55 });
    await call('POST', '/api/processors/imag/control', { action: 'freeze', value: true });
    const r = await call('POST', '/api/processors/imag/control', { action: 'input', value: '1' });
    expect(r.body).toMatchObject({ brightness: 55, freeze: true });
    expect((r.body as unknown as ProcessorView).inputs.find((i) => i.active)?.label).toBe('DP 1');
    expect(coex.writes.map((w) => w.path)).toEqual(['/api/v1/screen/brightness', '/api/v1/screen/output/displaymode', '/api/v1/screen/layer/input']);
  });

  it('refuses what a processor cannot do, values out of range, and everything when controls are off', async () => {
    const { call, tessera } = await rig();
    expect((await call('POST', '/api/processors/imag/control', { action: 'reboot' })).status).toBe(400);
    expect((await call('POST', '/api/processors/main/control', { action: 'brightness', value: 20000 })).status).toBe(400);
    expect((await call('POST', '/api/processors/main/control', { action: 'input', value: 'sdi:9' })).status).toBe(400);
    expect((await call('POST', '/api/processors/main/control', { action: 'preset', value: 99 })).status).toBe(400);
    expect((await call('POST', '/api/processors/main/control', { action: 'nonsense' })).status).toBe(400);
    expect((await call('POST', '/api/processors/nope/control', { action: 'reboot' })).status).toBe(404);
    expect(tessera.writes).toEqual([]);

    const off = await rig({ controls: false });
    expect((await off.call('POST', '/api/processors/main/control', { action: 'blackout', value: true })).status).toBe(403);
    expect(off.monitor.state().processors[0].controls).toBeUndefined();
    expect(off.tessera.writes).toEqual([]);
  });

  it('reports a processor that refuses a command', async () => {
    const { call, coex, monitor } = await rig();
    coex.scenario = 'vmp-busy';
    const r = await call('POST', '/api/processors/imag/control', { action: 'blackout', value: true });
    expect(r).toMatchObject({ status: 502, body: { error: expect.stringMatching(/occupied/) } });
    expect(monitor.events.search({ source: 'control' })[0].level).toBe('warning');
  });
});

describe('email alerts', () => {
  const email: EmailSettings = { ...DEFAULT_EMAIL, enabled: true, host: 'smtp', from: 'm@x', to: ['crew@x'], minSeverity: 'warning', repeatMinutes: 10 };
  const alert = (key: string, severity: Alert['severity'] = 'critical'): Alert => ({ key, rule: 'r', severity, message: `Problem ${key}`, since: 0 });
  const change = (key: string, c: AlertChange['change'], severity: Alert['severity'] = 'critical'): AlertChange => ({
    processorId: 'p',
    processorName: 'Stage Main',
    alert: alert(key, severity),
    change: c,
  });

  it('batches new problems into one email and sends a recovery for each', async () => {
    const sent: { subject: string; text: string }[] = [];
    const a = new Alerter(email, async (m) => void sent.push(m), () => {}, 60_000);
    a.handle(change('fan', 'raised'));
    a.handle(change('temp', 'raised', 'warning'));
    await a.flush();
    expect(sent[0].subject).toBe('[LED Monitor] Critical: Stage Main: Problem fan (+1 more)');
    expect(sent[0].text).toContain('- Stage Main: Problem temp (warning)');
    a.handle(change('fan', 'cleared'));
    await a.flush();
    expect(sent[1].subject).toBe('[LED Monitor] Recovered: Stage Main: Problem fan');
    a.stop();
  });

  it('holds repeats for the repeat window and skips alerts below the chosen severity', async () => {
    const sent: unknown[] = [];
    const a = new Alerter({ ...email, minSeverity: 'critical' }, async (m) => void sent.push(m), () => {}, 60_000);
    a.handle(change('fan', 'raised'), 0);
    a.handle(change('fan', 'cleared'), 1000);
    a.handle(change('fan', 'raised'), 2000);
    a.handle(change('temp', 'raised', 'warning'), 2000);
    await a.flush();
    a.handle(change('fan', 'raised'), 11 * 60_000);
    await a.flush();
    expect(sent).toHaveLength(2);
    expect(compose([change('x', 'raised', 'warning')]).subject).toMatch(/^\[LED Monitor\] Warning/);
    a.stop();
  });

  it('logs a send failure instead of throwing', async () => {
    const logged: string[] = [];
    const a = new Alerter(email, async () => Promise.reject(new Error('550 relay denied')), (_l, m) => void logged.push(m), 60_000);
    a.handle(change('fan', 'raised'));
    await a.flush();
    expect(logged[0]).toMatch(/relay denied/);
  });
});

describe('history', () => {
  it('keeps every sample for an hour and averages for longer ranges', () => {
    const h = new History();
    const view = (temp: number) =>
      ({ id: 'p', reachable: true, temperatures: [{ key: 'cpu', label: 'CPU', value: temp, unit: '°C' }], fans: [] }) as unknown as ProcessorView;
    const t0 = Date.UTC(2026, 10, 11, 12, 0, 0);
    h.record(view(40), t0);
    h.record(view(50), t0 + 5_000);
    h.record(view(60), t0 + 2 * 3600_000);
    const hour = h.series('p', '1h', t0 + 2 * 3600_000);
    expect(hour[0]).toMatchObject({ key: 'temp:cpu', label: 'CPU', unit: '°C', points: [[t0 + 2 * 3600_000, 60]] });
    const day = h.series('p', '24h', t0 + 2 * 3600_000);
    expect(day[0].points).toEqual([
      [t0, 45],
      [t0 + 2 * 3600_000, 60],
    ]);
  });

  it('survives a restart', () => {
    const dir = tmp();
    const h = new History(dir);
    h.record({ id: 'p', reachable: true, temperatures: [{ key: 'cpu', label: 'CPU', value: 41, unit: '°C' }], fans: [] } as unknown as ProcessorView);
    h.close();
    expect(new History(dir).series('p', '24h')[0].points[0][1]).toBe(41);
  });
});
