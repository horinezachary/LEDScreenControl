import { useEffect, useState } from 'react';
import type { DashboardState, EventEntry, HistorySeries, ProcessorView } from '@ledmon/shared';
import { api } from '../api';
import { Chart } from '../components/Chart';
import { Controls } from '../components/Controls';
import { ago, clock, duration, rate, SEVERITY_LABEL } from '../format';
import { kindName } from './Overview';

// One processor in full: controls, every reading over the last hour, day or week, inputs, redundancy and its events.

const RANGES = [
  { key: '1h', label: 'Last hour', ms: 3600_000 },
  { key: '24h', label: '24 hours', ms: 86400_000 },
  { key: '7d', label: '7 days', ms: 7 * 86400_000 },
] as const;

export function ProcessorPage({ state, id, now }: { state: DashboardState; id: string; now: number }) {
  const p = state.processors.find((x) => x.id === id);
  if (!p) {
    return (
      <div className="card empty-card">
        <h2>No processor "{id}"</h2>
        <p>It may have been removed in the settings.</p>
      </div>
    );
  }
  return (
    <div className="proc-page">
      <section className={`card proc sev-border-${p.severity}`} aria-label={p.name}>
        <div className="proc-head">
          <div>
            <h2 className="big">{p.name}</h2>
            <div className="sub">
              {p.model ?? kindName(p.kind)} · <span className="mono">{p.host}</span>
              {p.serial && <> · SN {p.serial}</>}
              {p.firmware && <> · firmware {p.firmware}</>}
              {p.uptimeSeconds !== undefined && <> · up {duration(p.uptimeSeconds)}</>}
            </div>
          </div>
          <span className={`pill sev-${p.severity}`}>
            <span className="dot" />
            {p.reachable || p.severity === 'unknown' ? SEVERITY_LABEL[p.severity] : 'Offline'}
          </span>
        </div>
        {!p.reachable && <p className="note">{p.lastError ?? 'Waiting for the first answer.'}</p>}
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
      </section>

      <div className="proc-cols">
        <section className="card" aria-label="Controls">
          <h3>Controls</h3>
          <Controls p={p} />
        </section>
        <section className="card" aria-label="Inputs and redundancy">
          <h3>Inputs</h3>
          <table className="plain">
            <tbody>
              {p.inputs.map((i) => (
                <tr key={i.key ?? i.label}>
                  <th scope="row">
                    {i.label}
                    {i.active && <span className="tag">active</span>}
                  </th>
                  <td className={`mono ${i.active && !i.signal ? 'bad' : ''}`}>{i.signal ? `${i.width}×${i.height} ${rate(i.rate)}${i.rate ? ' Hz' : ''}` : 'no signal'}</td>
                </tr>
              ))}
              {p.inputs.length === 0 && (
                <tr>
                  <td className="sub">Not reported.</td>
                </tr>
              )}
            </tbody>
          </table>
          <h3>Output and redundancy</h3>
          <table className="plain">
            <tbody>
              <Row k="Brightness">{p.brightness !== undefined ? (p.brightnessUnit === '%' ? `${Math.round(p.brightness)}%` : `${p.brightness} nits`) : '—'}</Row>
              <Row k="Preset">{p.preset ? `${p.preset.number} · ${p.preset.name}` : '—'}</Row>
              <Row k="Blackout / freeze">
                {p.blackout === undefined && p.freeze === undefined
                  ? '—'
                  : `${p.blackout === undefined ? 'Blackout unknown' : p.blackout ? 'Blackout on' : 'Blackout off'} · ${p.freeze === undefined ? 'freeze unknown' : p.freeze ? 'frozen' : 'not frozen'}`}
              </Row>
              <Row k="Genlock">{p.genlock ? `${p.genlock.source}${p.genlock.rate ? ` · ${rate(p.genlock.rate)} Hz` : ''}` : '—'}</Row>
              <Row k="Failover">
                {p.failover
                  ? `${p.failover.enabled ? (p.failover.role ?? 'on') : 'off'}${p.failover.partnerName ? ` · partner ${p.failover.partnerName} ${p.failover.partnerPresent === false ? 'missing' : 'present'}` : ''}${p.failover.active ? ' · failover active' : ''}`
                  : '—'}
              </Row>
              <Row k="Tiles">{p.tiles ? `${p.tiles.online} of ${p.tiles.associated} online${p.tiles.errors ? ` · ${p.tiles.errors} with errors` : ''}` : '—'}</Row>
              {p.loops.filter((l) => l.found).length > 0 && <Row k="Cable loops found">{p.loops.filter((l) => l.found).length}</Row>}
            </tbody>
          </table>
        </section>
      </div>

      <History p={p} state={state} />
      <ProcessorEvents p={p} newest={state.events[0]?.id} />
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{k}</th>
      <td>{children}</td>
    </tr>
  );
}

function History({ p, state }: { p: ProcessorView; state: DashboardState }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[0]);
  const [series, setSeries] = useState<HistorySeries[]>();
  const [error, setError] = useState<string>();
  // Refresh with every new reading, at most every 5 seconds.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), range.key === '1h' ? 5000 : 60_000);
    return () => clearInterval(t);
  }, [range.key]);
  useEffect(() => {
    api<HistorySeries[]>('GET', `/api/processors/${encodeURIComponent(p.id)}/history?range=${range.key}`).then(
      (s) => {
        setSeries(s);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [p.id, range.key, tick]);

  const groups: { title: string; match: (s: HistorySeries) => boolean }[] = [
    { title: 'Temperatures', match: (s) => s.key.startsWith('temp:') },
    { title: 'Fans', match: (s) => s.key.startsWith('fan:') },
    { title: 'Port loads', match: (s) => s.key.startsWith('load:') },
    { title: 'Brightness and tiles', match: (s) => s.key === 'brightness' || s.key === 'tiles-online' },
  ];
  const limitFor = (s: HistorySeries) =>
    s.key.startsWith('temp:')
      ? { value: state.limits.tempWarnC, label: `warning ${state.limits.tempWarnC} °C` }
      : s.key.startsWith('load:')
        ? { value: state.limits.portLoadWarnPercent, label: `warning ${state.limits.portLoadWarnPercent}%` }
        : undefined;

  return (
    <section className="card" aria-label="History">
      <div className="section-head">
        <h3>History</h3>
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={r.key === range.key ? 'on' : ''} aria-pressed={r.key === range.key} onClick={() => setRange(r)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="note bad">{error}</p>}
      {!series ? (
        <p className="sub">Loading…</p>
      ) : series.length === 0 ? (
        <p className="sub">No readings yet. They build up from the first answer, and the longer ranges keep a week.</p>
      ) : (
        groups.map((g) => {
          const list = series.filter(g.match);
          if (!list.length) return null;
          return (
            <div key={g.title} className="chart-group">
              <h4>{g.title}</h4>
              <div className="charts">
                {list.map((s) => (
                  <Chart key={s.key} series={s} rangeMs={range.ms} limit={limitFor(s)} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

function ProcessorEvents({ p, newest }: { p: ProcessorView; newest?: number }) {
  const [events, setEvents] = useState<EventEntry[]>([]);
  useEffect(() => {
    api<EventEntry[]>('GET', `/api/events?processor=${encodeURIComponent(p.id)}&limit=30`).then(setEvents, () => undefined);
  }, [p.id, newest]);
  return (
    <section className="card events" aria-label="Events">
      <h3>Recent events</h3>
      {events.length === 0 ? (
        <p className="sub">Nothing yet.</p>
      ) : (
        <ol>
          {events.map((e) => (
            <li key={`${e.id}-${e.time}`}>
              <span className={`dot lvl-${e.level}`} />
              <span className="mono time">{clock(e.time)}</span>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
