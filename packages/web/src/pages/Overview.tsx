import type { DashboardState, ProcessorView } from '@ledmon/shared';
import { ago, duration, rate, SEVERITY_LABEL } from '../format';
import { linkHandler, processorPath } from '../route';

export function Overview({ state, now, go }: { state: DashboardState; now: number; go: (path: string) => void }) {
  return state.processors.length === 0 ? (
    <div className="card empty-card">
      <h2>No processors yet</h2>
      <p>
        Add them to <code>config.json</code> in the settings folder (the launcher's <em>Open Settings Folder</em>), then
        restart. Each entry needs a <code>kind</code> (brompton, coex or vxpro) and a <code>host</code>.
      </p>
    </div>
  ) : (
    <>
      {state.processors.map((p) => (
        <ProcessorCard key={p.id} p={p} now={now} go={go} />
      ))}
    </>
  );
}

function ProcessorCard({ p, now, go }: { p: ProcessorView; now: number; go: (path: string) => void }) {
  const active = p.inputs.find((i) => i.active);
  const hottest = [...p.temperatures].sort((a, b) => b.value - a.value)[0];
  const fansOk = p.fans.filter((f) => f.running).length;
  const stale = !p.reachable && p.lastSeen !== undefined;

  return (
    <article className={`card proc sev-border-${p.severity}`} aria-label={p.name}>
      <div className="proc-head">
        <div>
          <h2>
            <a href={processorPath(p.id)} onClick={linkHandler(go, processorPath(p.id))}>
              {p.name}
            </a>
          </h2>
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

      {p.reachable && p.note && <p className="note">{p.note}</p>}

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
          <Fact label="Brightness">{p.brightness !== undefined ? (p.brightnessUnit === '%' ? `${Math.round(p.brightness)}%` : `${p.brightness} nits`) : '—'}</Fact>
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
                    <tr key={l.key}>
                      <th scope="row">{l.port ? `Chain ${l.port}` : `Loop ${l.index}`}</th>
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

export function kindName(kind: ProcessorView['kind']): string {
  return { brompton: 'Brompton', coex: 'NovaStar COEX', vxpro: 'NovaStar VX Pro', device: 'Network device' }[kind];
}

