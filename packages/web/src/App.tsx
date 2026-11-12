import type { DashboardState, EventEntry, ProcessorView } from '@ledmon/shared';
import { useDashboard, useNow, type Connection } from './useDashboard';
import { ago, clock, duration, rate, SEVERITY_LABEL } from './format';

export function App() {
  const { state, connection, receivedAt } = useDashboard();
  const now = useNow();

  return (
    <div className="page">
      <Header state={state} connection={connection} receivedAt={receivedAt} now={now} />
      <nav className="tabs" aria-label="Views">
        <span className="tab on" aria-current="page">Overview</span>
        <span className="tab soon" title="Coming in phase 2">Topology</span>
        <span className="tab soon" title="Coming in a later phase">Events</span>
        <span className="tab soon" title="Coming in phase 4">Settings</span>
      </nav>
      {!state ? (
        <p className="empty">Connecting to the monitor…</p>
      ) : (
        <div className="layout">
          <main className="grid" aria-label="Processors">
            {state.processors.length === 0 ? (
              <div className="card empty-card">
                <h2>No processors yet</h2>
                <p>
                  Add them to <code>config.json</code> in the settings folder (the launcher's <em>Open settings folder</em>),
                  then restart. Each entry needs a <code>kind</code> (brompton, coex or vxpro) and a <code>host</code>.
                </p>
              </div>
            ) : (
              state.processors.map((p) => <ProcessorCard key={p.id} p={p} now={now} />)
            )}
          </main>
          <Events events={state.events} />
        </div>
      )}
      <footer className="footer">LED Monitor {state?.version ?? ''}</footer>
    </div>
  );
}

function Header({ state, connection, receivedAt, now }: { state?: DashboardState; connection: Connection; receivedAt?: number; now: number }) {
  const total = state?.processors.length ?? 0;
  const alerts = state?.processors.reduce((n, p) => n + p.alerts.length, 0) ?? 0;
  const sev = state?.severity ?? 'unknown';
  const headline =
    !state ? 'Waiting' : sev === 'ok' ? 'All OK' : `${alerts} alert${alerts === 1 ? '' : 's'}`;
  return (
    <header className="header">
      <div className="brand">
        <div className="logo" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        </div>
        <div>
          <h1>LED Processor Monitor</h1>
          <div className="sub">
            {total} processor{total === 1 ? '' : 's'} ·{' '}
            {connection === 'live' ? `updated ${ago(receivedAt, now)}` : connection === 'lost' ? 'connection to the monitor lost, retrying' : 'connecting'}
          </div>
        </div>
        <span className={`pill sev-${connection === 'lost' ? 'critical' : sev}`} role="status">
          <span className="dot" />
          {connection === 'lost' ? 'Monitor offline' : headline}
        </span>
      </div>
    </header>
  );
}

function ProcessorCard({ p, now }: { p: ProcessorView; now: number }) {
  const active = p.inputs.find((i) => i.active);
  const hottest = [...p.temperatures].sort((a, b) => b.value - a.value)[0];
  const fansOk = p.fans.filter((f) => f.running).length;
  const stale = !p.reachable && p.lastSeen !== undefined;

  return (
    <article className={`card proc sev-border-${p.severity}`} aria-label={p.name}>
      <div className="proc-head">
        <div>
          <h2>{p.name}</h2>
          <div className="sub">
            {p.model ?? kindName(p.kind)} · <span className="mono">{p.host}</span>
            {p.serial && <> · SN {p.serial}</>}
          </div>
        </div>
        <span className={`pill sev-${p.severity}`}>
          <span className="dot" />
          {p.reachable || p.severity === 'unknown' ? SEVERITY_LABEL[p.severity] : 'Offline'}
        </span>
      </div>

      {!p.reachable && (
        <p className="note">
          {p.lastError ?? 'Waiting for the first answer.'}
          {stale && <> Last answer {ago(p.lastSeen, now)}. Readings below are from then.</>}
        </p>
      )}

      {p.alerts.length > 0 && (
        <ul className="alerts">
          {p.alerts.map((a) => (
            <li key={a.key} className={`alert sev-${a.severity}`}>
              <span className="dot" />
              <span>{a.message}</span>
              <span className="since">{ago(a.since, now)}</span>
            </li>
          ))}
        </ul>
      )}

      {(p.reachable || stale) && (
        <dl className="facts">
          <Fact label="Input">
            {active ? (
              active.signal ? (
                <>
                  {active.label} · {active.width}×{active.height}
                  {active.rate !== undefined && <> · {rate(active.rate)} Hz</>}
                </>
              ) : (
                <span className="bad">{active.label} · no signal</span>
              )
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Genlock">{p.genlock ? `${p.genlock.source}${p.genlock.source === 'internal' && p.genlock.rate ? ` · ${rate(p.genlock.rate)} Hz` : ''}` : '—'}</Fact>
          <Fact label="Hottest">{hottest ? `${hottest.label} ${hottest.value.toFixed(1)} °C` : '—'}</Fact>
          <Fact label="Fans">{p.fans.length ? <span className={fansOk < p.fans.length ? 'bad' : ''}>{fansOk} of {p.fans.length} running</span> : '—'}</Fact>
          <Fact label="Tiles">
            {p.tiles ? (
              <span className={p.tiles.online < p.tiles.associated ? 'bad' : ''}>
                {p.tiles.online} of {p.tiles.associated} online{p.tiles.errors ? ` · ${p.tiles.errors} with errors` : ''}
              </span>
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Redundancy">{failoverText(p)}</Fact>
          <Fact label="Brightness">{p.brightness !== undefined ? `${p.brightness} nits` : '—'}</Fact>
          <Fact label="Preset">{p.preset ? `${p.preset.number} · ${p.preset.name}` : '—'}</Fact>
          <Fact label="Firmware">{p.firmware ?? '—'}</Fact>
          <Fact label="Uptime">{duration(p.uptimeSeconds)}</Fact>
        </dl>
      )}

      {(p.blackout || p.freeze) && (
        <div className="badges">
          {p.blackout && <span className="pill sev-warning">Blackout on</span>}
          {p.freeze && <span className="pill sev-warning">Frozen</span>}
        </div>
      )}

      {(p.temperatures.length > 0 || p.inputs.length > 0) && (
        <details className="more">
          <summary>All sensors and inputs</summary>
          <div className="more-grid">
            <table>
              <caption>Temperatures</caption>
              <tbody>
                {p.temperatures.map((t) => (
                  <tr key={t.key}>
                    <th scope="row">{t.label}</th>
                    <td className="mono">{t.value.toFixed(1)} °C</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Fans</caption>
              <tbody>
                {p.fans.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">{f.label}</th>
                    <td className={`mono ${f.running ? '' : 'bad'}`}>{f.running ? `${Math.round(f.rpm ?? 0)} RPM` : 'stopped'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Inputs</caption>
              <tbody>
                {p.inputs.map((i) => (
                  <tr key={i.label}>
                    <th scope="row">
                      {i.label}
                      {i.active && ' (active)'}
                    </th>
                    <td className="mono">{i.signal ? `${i.width}×${i.height} ${rate(i.rate)}` : 'no signal'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.loops.length > 0 && (
              <table>
                <caption>Cable loops</caption>
                <tbody>
                  {p.loops.map((l) => (
                    <tr key={l.index}>
                      <th scope="row">Loop {l.index + 1}</th>
                      <td className="mono">{l.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      )}
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function failoverText(p: ProcessorView): React.ReactNode {
  const f = p.failover;
  if (!f) return '—';
  if (!f.enabled) return 'Failover off';
  const role = f.role ? f.role.charAt(0).toUpperCase() + f.role.slice(1) : 'Paired';
  const partner = f.partnerName ?? 'partner';
  if (f.partnerPresent === false) return <span className="bad">{role} · {partner} missing</span>;
  if (f.active) return <span className="bad">{role} · failover active</span>;
  return `${role} · ${partner} present`;
}

function kindName(kind: ProcessorView['kind']): string {
  return { brompton: 'Brompton', coex: 'NovaStar COEX', vxpro: 'NovaStar VX Pro' }[kind];
}

function Events({ events }: { events: EventEntry[] }) {
  return (
    <aside className="card events" aria-label="Recent events">
      <h2>Recent events</h2>
      {events.length === 0 ? (
        <p className="sub">Nothing yet.</p>
      ) : (
        <ol>
          {events.slice(0, 40).map((e) => (
            <li key={e.id}>
              <span className={`dot lvl-${e.level}`} />
              <span className="mono time">{clock(e.time)}</span>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
