import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, EventEntry } from '@ledmon/shared';

// The whole event log, searched on the server (it keeps every event on disk), with a CSV download of what is shown.

const LEVELS: EventEntry['level'][] = ['critical', 'warning', 'ok', 'info'];
const LEVEL_WORD: Record<EventEntry['level'], string> = { critical: 'Critical', warning: 'Warning', ok: 'Recovered', info: 'Info' };
const SOURCES = [
  { value: '', label: 'Any source' },
  { value: 'monitor', label: 'Monitor' },
  { value: 'syslog', label: 'Processor syslog' },
  { value: 'control', label: 'Control actions' },
];
const RANGES = [
  { value: '', label: 'Any time' },
  { value: '3600000', label: 'Last hour' },
  { value: '86400000', label: 'Last 24 hours' },
  { value: '604800000', label: 'Last 7 days' },
];

export function EventsPage({ state }: { state: DashboardState }) {
  const [processor, setProcessor] = useState('');
  const [levels, setLevels] = useState<EventEntry['level'][]>([]);
  const [source, setSource] = useState('');
  const [range, setRange] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<EventEntry[]>();
  const [error, setError] = useState<string>();
  // Refetch whenever a new event arrives over the WebSocket.
  const newest = state.events[0]?.id;

  // Wait for typing to pause before searching.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: '1000' });
    if (processor) p.set('processor', processor);
    if (levels.length) p.set('level', levels.join(','));
    if (source) p.set('source', source);
    if (range) p.set('since', String(Date.now() - Number(range)));
    if (query) p.set('q', query);
    return p.toString();
    // `newest` is in the list so the time window moves on as events arrive.
  }, [processor, levels, source, range, query, newest]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/events?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<EventEntry[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list) => {
        setEvents(list);
        setError(undefined);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(`Could not load events: ${err.message}`);
      });
    return () => ctrl.abort();
  }, [params]);

  const names = new Map(state.processors.map((p) => [p.id, p.name]));
  const toggle = (l: EventEntry['level']) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  return (
    <section className="card events-page" aria-label="Events">
      <div className="filters">
        <label>
          <span>Processor</span>
          <select value={processor} onChange={(e) => setProcessor(e.target.value)}>
            <option value="">All processors</option>
            {state.processors.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>When</span>
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span>Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Words in the message" />
        </label>
        <fieldset className="chips">
          <legend>Level</legend>
          {LEVELS.map((l) => (
            <button key={l} type="button" className={`chip lvl-${l} ${levels.includes(l) ? 'on' : ''}`} aria-pressed={levels.includes(l)} onClick={() => toggle(l)}>
              <span className="dot" />
              {LEVEL_WORD[l]}
            </button>
          ))}
        </fieldset>
        <a className="btn" href={`/api/events.csv?${params}`} download>
          Download CSV
        </a>
      </div>

      {error && <p className="note bad">{error}</p>}
      {!events ? (
        <p className="sub">Loading…</p>
      ) : events.length === 0 ? (
        <p className="sub">No events match.</p>
      ) : (
        <>
          <p className="sub">
            {events.length === 1000 ? 'Newest 1,000 matching events' : `${events.length} event${events.length === 1 ? '' : 's'}`}
          </p>
          <div className="table-scroll">
            <table className="event-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Level</th>
                  <th scope="col">Processor</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={`${e.id}-${e.time}`}>
                    <td className="mono nowrap">{stamp(e.time)}</td>
                    <td className={`nowrap lvl-${e.level}`}>
                      <span className="dot" /> {LEVEL_WORD[e.level]}
                    </td>
                    <td className="nowrap">{e.processorId ? names.get(e.processorId) ?? e.processorId : '—'}</td>
                    <td>
                      {e.message}
                      {e.source && e.source !== 'monitor' && <span className="tag">{e.source === 'syslog' ? 'syslog' : 'control'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}
