import type { DashboardState, EventEntry } from '@ledmon/shared';
import { useDashboard, useNow, type Connection } from './useDashboard';
import { ago, clock } from './format';
import { linkHandler, PAGES, useRoute } from './route';
import { Overview } from './pages/Overview';
import { Topology } from './pages/Topology';
import { EventsPage } from './pages/Events';

export function App() {
  const { state, connection, receivedAt } = useDashboard();
  const now = useNow();
  const [page, go] = useRoute();

  return (
    <div className="page">
      <Header state={state} connection={connection} receivedAt={receivedAt} now={now} />
      <nav className="tabs" aria-label="Views">
        {PAGES.map((p) => (
          <a
            key={p.page}
            href={p.path}
            className={`tab ${page === p.page ? 'on' : ''}`}
            aria-current={page === p.page ? 'page' : undefined}
            onClick={linkHandler(go, p.path)}
          >
            {p.label}
          </a>
        ))}
      </nav>
      {!state ? (
        <p className="empty">Connecting to the monitor…</p>
      ) : page === 'topology' ? (
        <Topology state={state} />
      ) : page === 'events' ? (
        <EventsPage state={state} />
      ) : (
        <div className="layout">
          <main className="grid" aria-label="Processors">
            <Overview state={state} now={now} />
          </main>
          <RecentEvents events={state.events} go={go} />
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
  const headline = !state ? 'Waiting' : sev === 'ok' ? 'All OK' : `${alerts} alert${alerts === 1 ? '' : 's'}`;
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

export function RecentEvents({ events, go, limit = 40 }: { events: EventEntry[]; go: (path: string) => void; limit?: number }) {
  return (
    <aside className="card events" aria-label="Recent events">
      <div className="events-head">
        <h2>Recent events</h2>
        <a href="/events" onClick={linkHandler(go, '/events')}>
          All events
        </a>
      </div>
      {events.length === 0 ? (
        <p className="sub">Nothing yet.</p>
      ) : (
        <ol>
          {events.slice(0, limit).map((e) => (
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
