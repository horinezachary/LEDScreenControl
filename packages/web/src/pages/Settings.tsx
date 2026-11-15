import { useEffect, useState } from 'react';
import type { AuthStatus, DashboardState, EmailSettings, GroupLayout, ProcessorConfig, ProcessorKind, ScanResult, WallLayout } from '@ledmon/shared';
import { wallGroupsFromLoops } from '@ledmon/shared';
import { api } from '../api';

// The settings page: everything in config.json, behind the one admin password. Saving checks the whole file the
// same way the server does at start-up, keeps the previous file as config.json.bak, and applies it at once.

interface Thresholds {
  tempWarnC: number;
  tempCritC: number;
  fanMinRpm: number;
  tilesOfflineCritPercent: number;
  unreachableAfterPolls: number;
  portLoadWarnPercent: number;
}

export interface AppSettings {
  port: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  syslogPort: number;
  controls: boolean;
  processors: ProcessorConfig[];
  walls: WallLayout[];
  thresholds: Thresholds;
  email: EmailSettings;
}

const SECTIONS = ['Processors', 'Walls', 'Alerts', 'Email', 'General', 'Password'] as const;
type Section = (typeof SECTIONS)[number];

export function SettingsPage({ auth, setAuth, state }: { auth?: AuthStatus; setAuth: (a: AuthStatus) => void; state?: DashboardState }) {
  if (!auth) return <p className="empty">Checking…</p>;
  if (!auth.unlocked) return <Unlock auth={auth} setAuth={setAuth} />;
  return <Editor setAuth={setAuth} state={state} />;
}

function Unlock({ auth, setAuth }: { auth: AuthStatus; setAuth: (a: AuthStatus) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (!auth.passwordSet && password !== again) return setError('The two passwords are different.');
    setBusy(true);
    try {
      setAuth(await api<AuthStatus>('POST', auth.passwordSet ? '/api/auth/login' : '/api/auth/password', auth.passwordSet ? { password } : { next: password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!auth.passwordSet && !auth.canSetFirstPassword) {
    return (
      <div className="card narrow">
        <h2>Settings are not set up yet</h2>
        <p className="sub">
          The settings password has to be set first from the computer running LED Monitor. Open the dashboard there
          (the menu bar app's <em>Open Dashboard</em>) and choose Settings.
        </p>
      </div>
    );
  }

  return (
    <form className="card narrow form" onSubmit={(e) => void submit(e)}>
      <h2>{auth.passwordSet ? 'Unlock settings' : 'Set the settings password'}</h2>
      <p className="sub">
        {auth.passwordSet
          ? 'Viewing and processor controls need no password. Changing the settings does.'
          : 'This password protects the settings: processors, walls, alert limits and email. Viewing and controls stay open to everyone on the network. Use at least 8 characters.'}
      </p>
      <label>
        <span>{auth.passwordSet ? 'Password' : 'New password'}</span>
        <input type="password" autoComplete={auth.passwordSet ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
      </label>
      {!auth.passwordSet && (
        <label>
          <span>Type it again</span>
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
      )}
      {error && <p className="note bad">{error}</p>}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !password}>
          {auth.passwordSet ? 'Unlock' : 'Set password'}
        </button>
      </div>
    </form>
  );
}

function Editor({ setAuth, state }: { setAuth: (a: AuthStatus) => void; state?: DashboardState }) {
  const [saved, setSaved] = useState<AppSettings>();
  const [draft, setDraft] = useState<AppSettings>();
  const [subnets, setSubnets] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('Processors');
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ config: AppSettings; subnets: string[] }>('GET', '/api/settings').then(
      (r) => {
        setSaved(r.config);
        setDraft(structuredClone(r.config));
        setSubnets(r.subnets);
      },
      (e: Error) => setStatus({ ok: false, text: e.message }),
    );
  }, []);

  if (!draft || !saved) return <p className="empty">{status?.text ?? 'Loading settings…'}</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const update = (f: (d: AppSettings) => void) =>
    setDraft((d) => {
      const next = structuredClone(d!);
      f(next);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const r = await api<{ config: AppSettings }>('PUT', '/api/settings', draft);
      setSaved(r.config);
      setDraft(structuredClone(r.config));
      const restart = r.config.port !== saved.port || r.config.syslogPort !== saved.syslogPort;
      setStatus({ ok: true, text: `Saved and applied.${restart ? ' The dashboard and syslog ports change after a restart (the menu bar app\'s Restart Server).' : ''}` });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => setAuth(await api<AuthStatus>('POST', '/api/auth/logout'));

  return (
    <div className="settings">
      <div className="settings-bar card">
        <nav className="seg" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s} type="button" className={s === section ? 'on' : ''} aria-pressed={s === section} onClick={() => setSection(s)}>
              {s}
            </button>
          ))}
        </nav>
        <div className="settings-actions">
          {status && <span className={`note ${status.ok ? 'good' : 'bad'}`}>{status.text}</span>}
          {dirty && (
            <button type="button" className="btn" onClick={() => setDraft(structuredClone(saved))} disabled={busy}>
              Undo changes
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? 'Saving…' : dirty ? 'Save and apply' : 'Saved'}
          </button>
          <button type="button" className="btn" onClick={() => void lock()}>
            Lock
          </button>
        </div>
      </div>

      {section === 'Processors' && <Processors draft={draft} update={update} subnets={subnets} />}
      {section === 'Walls' && <Walls draft={draft} update={update} state={state} />}
      {section === 'Alerts' && <AlertLimits draft={draft} update={update} />}
      {section === 'Email' && <Email draft={draft} update={update} />}
      {section === 'General' && <General draft={draft} update={update} />}
      {section === 'Password' && <ChangePassword setAuth={setAuth} />}
    </div>
  );
}

type Edit = { draft: AppSettings; update: (f: (d: AppSettings) => void) => void };

const KINDS: { value: ProcessorKind; label: string }[] = [
  { value: 'brompton', label: 'Brompton Tessera' },
  { value: 'coex', label: 'NovaStar COEX' },
  { value: 'vxpro', label: 'NovaStar VX Pro' },
  { value: 'device', label: 'Other device (answers or not)' },
];

function Processors({ draft, update, subnets }: Edit & { subnets: string[] }) {
  const [subnet, setSubnet] = useState(subnets[0] ?? '');
  const [scan, setScan] = useState<{ busy: boolean; found?: ScanResult[]; error?: string }>({ busy: false });

  const runScan = async () => {
    setScan({ busy: true });
    try {
      setScan({ busy: false, found: await api<ScanResult[]>('POST', '/api/scan', { subnet: subnet.replace(/\.$/, '') }) });
    } catch (err) {
      setScan({ busy: false, error: (err as Error).message });
    }
  };
  const ids = new Set(draft.processors.map((p) => p.id));
  const add = (p: Partial<ProcessorConfig>) =>
    update((d) => {
      let id = p.id ?? slug(p.name ?? p.host ?? 'processor');
      for (let n = 2; ids.has(id) || !id; n++) id = `${slug(p.name ?? 'processor')}-${n}`;
      d.processors.push({ id, kind: p.kind ?? 'brompton', host: p.host ?? '', name: p.name });
    });

  return (
    <div className="card form">
      <h2>Processors</h2>
      <p className="sub">
        The id is used in the event log and in wall layouts. Turn on IP control on each processor first (Tessera: the
        IP Control application; COEX: the Open API, and close VMP).
      </p>
      {draft.processors.length === 0 && (
        <p className="note">No processors in the settings yet (simulated processors in demo mode are not listed here). Add one by address, or scan the network below.</p>
      )}
      <div className="table-scroll" hidden={draft.processors.length === 0}>
        <table className="edit-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Address</th>
              <th>Port</th>
              <th>Port capacity (NovaStar)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.processors.map((p, i) => (
              <tr key={i}>
                <td>
                  <input value={p.id} onChange={(e) => update((d) => void (d.processors[i].id = e.target.value.trim()))} aria-label="Id" />
                </td>
                <td>
                  <input value={p.name ?? ''} placeholder="(from the processor)" onChange={(e) => update((d) => void (d.processors[i].name = e.target.value || undefined))} aria-label="Name" />
                </td>
                <td>
                  <select value={p.kind} onChange={(e) => update((d) => void (d.processors[i].kind = e.target.value as ProcessorKind))} aria-label="Kind">
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input value={p.host} placeholder="10.10.20.11" onChange={(e) => update((d) => void (d.processors[i].host = e.target.value.trim()))} aria-label="Address" />
                </td>
                <td>
                  <NumberField value={p.port} placeholder={p.kind === 'coex' ? '8001' : p.kind === 'vxpro' ? '15200' : '80'} onChange={(v) => update((d) => void (d.processors[i].port = v))} label="Port" />
                </td>
                <td>
                  {p.kind === 'coex' || p.kind === 'vxpro' ? (
                    <NumberField value={p.portCapacity} placeholder="From the processor" onChange={(v) => update((d) => void (d.processors[i].portCapacity = v))} label="Pixels per output port" />
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
                <td>
                  <button type="button" className="btn" onClick={() => update((d) => void d.processors.splice(i, 1))} aria-label={`Remove ${p.name ?? p.id}`}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" className="btn" onClick={() => add({})}>
          Add a processor
        </button>
      </div>

      <h3>Find processors on the network</h3>
      <p className="sub">
        Asks every address in a /24 the read-only identity questions of Tessera and COEX. Nothing is sent that changes
        a processor. VX Pro processors that do not answer the COEX API are not found this way; add them by address.
      </p>
      <div className="inline">
        <label>
          <span>Network</span>
          <input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="10.10.20" list="subnets" />
          <datalist id="subnets">
            {subnets.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <button type="button" className="btn" onClick={() => void runScan()} disabled={scan.busy || !subnet}>
          {scan.busy ? 'Scanning…' : 'Scan'}
        </button>
      </div>
      {scan.error && <p className="note bad">{scan.error}</p>}
      {scan.found && scan.found.length === 0 && <p className="sub">Nothing answered. Check that IP control is on.</p>}
      {scan.found && scan.found.length > 0 && (
        <ul className="found">
          {scan.found.map((f) => {
            const already = f.known || draft.processors.some((p) => p.host === f.host);
            return (
              <li key={f.host}>
                <span className="mono">{f.host}</span> · {f.name ?? 'unnamed'} · {f.model ?? f.kind}
                {f.serial && <> · SN {f.serial}</>}
                {already ? (
                  <span className="tag">already added</span>
                ) : (
                  <button type="button" className="btn" onClick={() => add({ host: f.host, kind: f.kind, name: f.name })}>
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Walls({ draft, update, state }: Edit & { state?: DashboardState }) {
  const live = (id: string) => state?.processors.find((p) => p.id === id);
  /** Fills a wall's XD pairs and chains from what its primary processor reports, and its backup from the failover partner. */
  const fillFromProcessor = (wi: number) =>
    update((d) => {
      const w = d.walls[wi];
      const p = live(w.primary);
      if (!p) return;
      w.groups = wallGroupsFromLoops(p.loops, w.groups, p.tiles?.associated ?? 0);
      const partner = p.failover?.partnerSerial && state?.processors.find((x) => x.id !== p.id && x.serial === p.failover?.partnerSerial);
      if (partner && !w.backup) w.backup = partner.id;
    });
  const procs = draft.processors.filter((p) => p.kind === 'brompton');
  const addWall = () =>
    update((d) =>
      d.walls.push({
        id: `wall-${d.walls.length + 1}`,
        name: `Wall ${d.walls.length + 1}`,
        primary: procs[0]?.id ?? '',
        backup: procs[1]?.id,
        groups: [newGroup('A', 'B')],
      }),
    );
  return (
    <div className="form">
      <div className="card">
        <h2>Walls</h2>
        <p className="sub">
          Brompton processors do not report where their tiles are, so each wall is described here once: the processor
          pair, and for each pair of XD boxes the tiles on each port's chain. A chain runs from port N on the left box
          to port N on the right box as a cable loop. NovaStar COEX walls come from the processor and need nothing here.
        </p>
        <p className="sub">
          "Fill in from" reads the XD pairs and cabled ports from the processor's cable loop reports. Tessera does not say
          how many tiles are on each chain, so new chains share the processor's tile count evenly: check each one.
        </p>
        {procs.length === 0 && <p className="note">Add a Brompton processor first.</p>}
        <button type="button" className="btn" onClick={addWall} disabled={procs.length === 0}>
          Add a wall
        </button>
      </div>
      {draft.walls.map((w, wi) => (
        <section key={wi} className="card form">
          <div className="section-head">
            <h3>{w.name || 'Wall'}</h3>
            <div className="inline">
              <button type="button" className="btn" disabled={!live(w.primary)?.loops.length} onClick={() => fillFromProcessor(wi)}>
                Fill in from {live(w.primary)?.name ?? 'the processor'}
              </button>
              <button type="button" className="btn" onClick={() => update((d) => void d.walls.splice(wi, 1))}>
                Remove wall
              </button>
            </div>
          </div>
          <div className="inline">
            <label>
              <span>Name</span>
              <input value={w.name} onChange={(e) => update((d) => void (d.walls[wi].name = e.target.value))} />
            </label>
            <label>
              <span>Id</span>
              <input value={w.id} onChange={(e) => update((d) => void (d.walls[wi].id = e.target.value.trim()))} />
            </label>
            <label>
              <span>Primary processor</span>
              <select value={w.primary} onChange={(e) => update((d) => void (d.walls[wi].primary = e.target.value))}>
                {procs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Backup processor</span>
              <select value={w.backup ?? ''} onChange={(e) => update((d) => void (d.walls[wi].backup = e.target.value || undefined))}>
                <option value="">None</option>
                {procs
                  .filter((p) => p.id !== w.primary)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name ?? p.id}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {w.groups.map((g, gi) => (
            <GroupEditor
              key={gi}
              g={g}
              onChange={(f) => update((d) => f(d.walls[wi].groups[gi]))}
              onRemove={() => update((d) => void d.walls[wi].groups.splice(gi, 1))}
            />
          ))}
          <div>
            <button
              type="button"
              className="btn"
              onClick={() =>
                update((d) => {
                  const n = d.walls[wi].groups.length * 2;
                  const letter = (i: number) => String.fromCharCode(65 + i);
                  d.walls[wi].groups.push(newGroup(letter(n), letter(n + 1)));
                })
              }
            >
              Add a pair of boxes
            </button>
          </div>
          <p className="sub">
            {w.groups.reduce((n, g) => n + g.chains.filter((c) => c > 0).length, 0)} chains,{' '}
            {w.groups.reduce((n, g) => n + g.chains.reduce((a, b) => a + b, 0), 0)} tiles in this layout.
          </p>
        </section>
      ))}
    </div>
  );
}

function newGroup(a: string, b: string): GroupLayout {
  return { left: { name: `XD ${a}`, trunk: a, ports: 10 }, right: { name: `XD ${b}`, trunk: b, ports: 10 }, chains: Array.from({ length: 10 }, () => 0) };
}

function GroupEditor({ g, onChange, onRemove }: { g: GroupLayout; onChange: (f: (g: GroupLayout) => void) => void; onRemove: () => void }) {
  const ports = Math.min(g.left.ports ?? 10, g.right?.ports ?? Infinity);
  const chains = Array.from({ length: ports }, (_, i) => g.chains[i] ?? 0);
  const box = (side: 'left' | 'right') => {
    const b = g[side]!;
    return (
      <fieldset className="box-edit">
        <legend>{side === 'left' ? 'Left box (drives the chains)' : 'Right box (loop end)'}</legend>
        <label>
          <span>Name</span>
          <input value={b.name} onChange={(e) => onChange((x) => void (x[side]!.name = e.target.value))} />
        </label>
        <label>
          <span>Trunk</span>
          <input className="short" value={b.trunk ?? ''} maxLength={2} onChange={(e) => onChange((x) => void (x[side]!.trunk = e.target.value.toUpperCase() || undefined))} />
        </label>
        <label>
          <span>Ports</span>
          <input
            className="short"
            type="number"
            min={1}
            max={32}
            value={b.ports ?? 10}
            onChange={(e) => onChange((x) => void (x[side]!.ports = Math.max(1, Number(e.target.value) || 1)))}
          />
        </label>
        <label>
          <span>Serial (optional)</span>
          <input value={b.serial ?? ''} onChange={(e) => onChange((x) => void (x[side]!.serial = e.target.value.trim() || undefined))} />
        </label>
      </fieldset>
    );
  };
  return (
    <div className="group-edit">
      <div className="group-boxes">
        {box('left')}
        {g.right ? (
          box('right')
        ) : (
          <p className="sub">Chains end at the last tile (not looped).</p>
        )}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={!!g.right}
          onChange={(e) =>
            onChange((x) => {
              if (e.target.checked) x.right = { name: 'XD', trunk: undefined, ports: x.left.ports ?? 10 };
              else delete x.right;
            })
          }
        />
        Chains loop back to a second box
      </label>
      <div className="chain-edit" role="group" aria-label="Tiles on each port">
        <span className="sub">Tiles on each port (0 for an empty port)</span>
        <div className="chain-cells">
          {chains.map((c, i) => (
            <label key={i} className="chain-cell">
              <span className="mono">
                {g.left.trunk ?? ''}
                {i + 1}
              </span>
              <input
                type="number"
                min={0}
                value={c}
                onChange={(e) =>
                  onChange((x) => {
                    const next = Array.from({ length: ports }, (_, j) => x.chains[j] ?? 0);
                    next[i] = Math.max(0, Math.round(Number(e.target.value) || 0));
                    x.chains = trimZeros(next);
                  })
                }
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            onChange((x) => {
              const first = x.chains.find((n) => n > 0) ?? 0;
              if (first) x.chains = Array.from({ length: ports }, () => first);
            })
          }
        >
          Same as the first port on every port
        </button>
      </div>
      <button type="button" className="btn" onClick={onRemove}>
        Remove this pair
      </button>
    </div>
  );
}

function trimZeros(list: number[]): number[] {
  const out = [...list];
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out;
}

function AlertLimits({ draft, update }: Edit) {
  const t = draft.thresholds;
  const field = (key: keyof Thresholds, label: string, hint: string) => (
    <label>
      <span>{label}</span>
      <input type="number" value={t[key]} onChange={(e) => update((d) => void (d.thresholds[key] = Number(e.target.value)))} />
      <small className="sub">{hint}</small>
    </label>
  );
  return (
    <div className="card form">
      <h2>Alert limits</h2>
      <p className="sub">The defaults are placeholders. Set them from what your processors normally run at after a week of history.</p>
      <div className="grid-form">
        {field('tempWarnC', 'Temperature warning (°C)', 'Any processor sensor at or above this.')}
        {field('tempCritC', 'Temperature critical (°C)', '')}
        {field('fanMinRpm', 'Slowest fan speed (RPM)', 'A running fan below this is a warning. 0 turns it off.')}
        {field('tilesOfflineCritPercent', 'Tiles offline critical (%)', 'Below this share it is a warning.')}
        {field('unreachableAfterPolls', 'Missed polls before critical', 'One missed poll is a warning.')}
        {field('portLoadWarnPercent', 'Port load warning (%)', 'COEX. Over 100% is critical.')}
      </div>
    </div>
  );
}

function Email({ draft, update }: Edit) {
  const e = draft.email;
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const set = <K extends keyof EmailSettings>(k: K, v: EmailSettings[K]) => update((d) => void (d.email[k] = v));
  const sendTest = async () => {
    setTest({ ok: true, text: 'Sending…' });
    try {
      const r = await api<{ sent: string[] }>('POST', '/api/settings/test-email', { email: draft.email });
      setTest({ ok: true, text: `Sent to ${r.sent.join(', ')}.` });
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <div className="card form">
      <h2>Email alerts</h2>
      <p className="sub">
        New problems are collected for a few seconds and sent as one email. A recovery email follows when an emailed
        problem clears. The same problem is not emailed again within the repeat time.
      </p>
      <label className="check">
        <input type="checkbox" checked={e.enabled} onChange={(x) => set('enabled', x.target.checked)} />
        Send alert emails
      </label>
      <div className="grid-form">
        <label>
          <span>SMTP server</span>
          <input value={e.host} placeholder="smtp.gmail.com" onChange={(x) => set('host', x.target.value)} />
        </label>
        <label>
          <span>Port</span>
          <input type="number" value={e.port} onChange={(x) => set('port', Number(x.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={e.secure} onChange={(x) => set('secure', x.target.checked)} />
          TLS from the start (port 465)
        </label>
        <label>
          <span>User name</span>
          <input value={e.user ?? ''} autoComplete="off" onChange={(x) => set('user', x.target.value || undefined)} />
        </label>
        <label>
          <span>Password</span>
          <input type="password" autoComplete="new-password" value={e.pass ?? ''} onChange={(x) => set('pass', x.target.value || undefined)} />
        </label>
        <label>
          <span>From</span>
          <input value={e.from} placeholder="led-monitor@example.org" onChange={(x) => set('from', x.target.value)} />
        </label>
        <label className="wide">
          <span>Send to (commas between addresses)</span>
          <input
            value={e.to.join(', ')}
            onChange={(x) =>
              set(
                'to',
                x.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </label>
        <label>
          <span>Send for</span>
          <select value={e.minSeverity} onChange={(x) => set('minSeverity', x.target.value as EmailSettings['minSeverity'])}>
            <option value="critical">Critical problems only</option>
            <option value="warning">Warnings and critical problems</option>
          </select>
        </label>
        <label>
          <span>Repeat after (minutes)</span>
          <input type="number" min={0} value={e.repeatMinutes} onChange={(x) => set('repeatMinutes', Number(x.target.value))} />
        </label>
      </div>
      <div className="inline">
        <button type="button" className="btn" onClick={() => void sendTest()} disabled={!e.host || !e.to.length}>
          Send a test email
        </button>
        {test && <span className={`note ${test.ok ? 'good' : 'bad'}`}>{test.text}</span>}
      </div>
    </div>
  );
}

function General({ draft, update }: Edit) {
  return (
    <div className="card form">
      <h2>General</h2>
      <label className="check">
        <input type="checkbox" checked={draft.controls} onChange={(e) => update((d) => void (d.controls = e.target.checked))} />
        Processor controls on the dashboard (brightness, preset, input, blackout, freeze, failover, reboot). Anyone who can
        open the dashboard can use them.
      </label>
      <div className="grid-form">
        <label>
          <span>Poll every (seconds)</span>
          <input type="number" min={1} value={draft.pollIntervalMs / 1000} onChange={(e) => update((d) => void (d.pollIntervalMs = Math.round(Number(e.target.value) * 1000)))} />
        </label>
        <label>
          <span>Give up on an answer after (seconds)</span>
          <input type="number" min={1} value={draft.requestTimeoutMs / 1000} onChange={(e) => update((d) => void (d.requestTimeoutMs = Math.round(Number(e.target.value) * 1000)))} />
        </label>
        <label>
          <span>Dashboard port</span>
          <input type="number" value={draft.port} onChange={(e) => update((d) => void (d.port = Number(e.target.value)))} />
          <small className="sub">Changes after a restart.</small>
        </label>
        <label>
          <span>Syslog port (UDP, 0 for off)</span>
          <input type="number" value={draft.syslogPort} onChange={(e) => update((d) => void (d.syslogPort = Number(e.target.value)))} />
          <small className="sub">Changes after a restart.</small>
        </label>
      </div>
    </div>
  );
}

function ChangePassword({ setAuth }: { setAuth: (a: AuthStatus) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) return setMsg({ ok: false, text: 'The two new passwords are different.' });
    try {
      setAuth(await api<AuthStatus>('POST', '/api/auth/password', { current, next }));
      setMsg({ ok: true, text: 'Password changed. Other browsers have been locked out.' });
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <form className="card form narrow" onSubmit={(e) => void submit(e)}>
      <h2>Change the settings password</h2>
      <label>
        <span>Current password</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label>
        <span>New password (at least 8 characters)</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
      </label>
      <label>
        <span>Type the new one again</span>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </label>
      {msg && <p className={`note ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</p>}
      <div>
        <button type="submit" className="btn primary">
          Change password
        </button>
      </div>
    </form>
  );
}

function NumberField({ value, placeholder, onChange, label }: { value?: number; placeholder?: string; onChange: (v: number | undefined) => void; label: string }) {
  return (
    <input
      className="short"
      type="number"
      value={value ?? ''}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
