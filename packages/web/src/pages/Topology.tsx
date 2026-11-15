import { useState } from 'react';
import type { ChainView, DashboardState, GroupView, LinkState, PortView, ProcessorView, TrunkView, WallProcessorView, WallView } from '@ledmon/shared';
import { SEVERITY_LABEL } from '../format';
import { kindName } from './Overview';

// The topology view follows the wall diagram: the processor that normally drives the wall on top, its backup at the
// bottom, distribution boxes as columns between them, and tile chains running between each pair of boxes. Live
// state is painted on: solid lines where signal is driven, dashed where a path is standby, red where it is lost.

type Selection = { kind: 'processor'; id: string } | { kind: 'chain'; id: string } | { kind: 'box'; wall: string; group: number; side: 'left' | 'right' };

const MAX_TILES_DRAWN = 12;

export function Topology({ state }: { state: DashboardState }) {
  const [sel, setSel] = useState<Selection>();
  const walls = state.walls;

  if (walls.length === 0) {
    return (
      <div className="card empty-card">
        <h2>No walls to draw yet</h2>
        <p>
          NovaStar COEX walls are drawn from the processor's own cabinet map. Brompton walls need a layout: add a{' '}
          <code>walls</code> entry to <code>config.json</code> naming the primary and backup processors and the tiles on
          each port of each distribution box (see the README), then restart.
        </p>
      </div>
    );
  }

  return (
    <div className="layout">
      <main className="topo-walls" aria-label="Walls">
        {walls.map((w) => (
          <Wall key={w.id} wall={w} sel={sel} onSelect={setSel} />
        ))}
        <Legend />
      </main>
      <Details state={state} sel={sel} />
    </div>
  );
}

function Wall({ wall, sel, onSelect }: { wall: WallView; sel?: Selection; onSelect: (s: Selection) => void }) {
  // One grid column per box and one per chain area, with a narrow spacer between groups.
  const cols: string[] = [];
  const at: { left: number; chains: number; right?: number }[] = [];
  wall.groups.forEach((g, i) => {
    if (i > 0) cols.push('28px');
    // A box without a partner shows port loads (COEX), which need more room.
    const left = cols.push(g.right ? 'minmax(96px, 120px)' : 'minmax(150px, 190px)');
    const chains = cols.push('minmax(0, 1fr)');
    const right = g.right ? cols.push('minmax(96px, 120px)') : undefined;
    at.push({ left, chains, right });
  });
  const trunkCol = (t: TrunkView) => (t.side === 'left' ? at[t.group].left : at[t.group].right ?? at[t.group].left);
  const minWidth = wall.groups.reduce((n, g) => n + (g.right ? 240 : 170) + 260, 0);

  return (
    <section className={`card wall sev-border-${wall.severity}`} aria-label={wall.name}>
      <div className="wall-head">
        <div>
          <h2>{wall.name}</h2>
          <div className="sub">{wallSummary(wall)}</div>
        </div>
        <span className={`pill sev-${wall.severity}`}>
          <span className="dot" />
          {SEVERITY_LABEL[wall.severity]}
        </span>
      </div>
      {wall.notes.length > 0 && (
        <ul className="wall-notes">
          {wall.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="topo-scroll">
        <div className="topo" style={{ gridTemplateColumns: cols.join(' '), minWidth }}>
          <ProcessorBar p={wall.primary} row={1} sel={sel} onSelect={onSelect} />
          {wall.trunks.map((t) => (
            <Trunk key={`p${t.group}${t.side}`} state={t.fromPrimary} label={t.label} col={trunkCol(t)} row={2} side={t.side} />
          ))}
          {wall.groups.map((g, gi) => (
            <Group key={gi} wall={wall} g={g} gi={gi} at={at[gi]} sel={sel} onSelect={onSelect} />
          ))}
          {wall.backup &&
            wall.trunks.map((t) => <Trunk key={`b${t.group}${t.side}`} state={t.fromBackup ?? 'unknown'} label={t.label} col={trunkCol(t)} row={4} side={t.side} />)}
          {wall.backup && <ProcessorBar p={wall.backup} row={5} sel={sel} onSelect={onSelect} />}
        </div>
      </div>
    </section>
  );
}

function wallSummary(wall: WallView): string {
  const chains = wall.groups.reduce((n, g) => n + g.chains.length, 0);
  const tiles = wall.groups.reduce((n, g) => n + g.chains.reduce((m, c) => m + c.tileCount, 0), 0);
  const boxes = wall.groups.reduce((n, g) => n + (g.right ? 2 : 1), 0);
  const parts = [
    wall.backup ? 'Redundant pair' : 'Single processor',
    wall.source === 'layout' ? `${boxes} distribution box${boxes === 1 ? '' : 'es'}` : `${boxes} output group${boxes === 1 ? '' : 's'}`,
    `${chains} chain${chains === 1 ? '' : 's'}`,
    `${tiles} tile${tiles === 1 ? '' : 's'}`,
  ];
  return parts.join(' · ');
}

function ProcessorBar({ p, row, sel, onSelect }: { p: WallProcessorView; row: number; sel?: Selection; onSelect: (s: Selection) => void }) {
  const selected = sel?.kind === 'processor' && sel.id === p.id;
  const state = !p.reachable ? 'Offline' : p.driving ? 'Driving the wall' : p.role === 'backup' ? 'Standby' : 'Not driving';
  const stateSev = !p.reachable ? 'critical' : p.driving ? (p.role === 'backup' ? 'warning' : 'ok') : 'unknown';
  return (
    <button
      type="button"
      className={`proc-bar sev-border-${p.severity} ${selected ? 'sel' : ''}`}
      style={{ gridRow: String(row) }}
      onClick={() => onSelect({ kind: 'processor', id: p.id })}
      aria-pressed={selected}
    >
      <span className={`dot lvl-${p.severity === 'unknown' ? 'info' : p.severity}`} />
      <span className="proc-name">{p.name}</span>
      {p.role !== 'single' && <span className="pill sev-unknown">{p.role === 'primary' ? 'Primary' : 'Backup'}</span>}
      <span className={`pill sev-${stateSev}`}>{state}</span>
      <span className="proc-meta">{p.summary}</span>
    </button>
  );
}

function Trunk({ state, label, col, row, side }: { state: LinkState; label: string; col: number; row: number; side: 'left' | 'right' }) {
  const word = { ok: 'driving', standby: 'standby', lost: 'lost', unknown: 'not known' }[state];
  return (
    <div className={`trunk link-${state} trunk-${side}`} style={{ gridColumn: String(col), gridRow: String(row) }}>
      <div className="ln" />
      <span className="lbl">
        {label} · {word}
      </span>
    </div>
  );
}

function Group({
  wall,
  g,
  gi,
  at,
  sel,
  onSelect,
}: {
  wall: WallView;
  g: GroupView;
  gi: number;
  at: { left: number; chains: number; right?: number };
  sel?: Selection;
  onSelect: (s: Selection) => void;
}) {
  const boxSel = (side: 'left' | 'right') => sel?.kind === 'box' && sel.wall === wall.id && sel.group === gi && sel.side === side;
  return (
    <>
      <Box
        name={g.left.name}
        online={g.left.online}
        ports={g.chains.map((c) => c.from)}
        col={at.left}
        selected={boxSel('left')}
        onClick={() => onSelect({ kind: 'box', wall: wall.id, group: gi, side: 'left' })}
      />
      <div className="chains" style={{ gridColumn: String(at.chains), gridRow: '3' }}>
        <div className="chain-head">{g.right ? 'Tile chains · looped' : 'Tile chains'}</div>
        {g.chains.map((c) => (
          <Chain key={c.id} c={c} selected={sel?.kind === 'chain' && sel.id === c.id} onClick={() => onSelect({ kind: 'chain', id: c.id })} />
        ))}
      </div>
      {g.right && at.right && (
        <Box
          name={g.right.name}
          online={g.right.online}
          ports={g.chains.map((c) => c.to ?? { label: '', state: 'unknown' })}
          col={at.right}
          selected={boxSel('right')}
          onClick={() => onSelect({ kind: 'box', wall: wall.id, group: gi, side: 'right' })}
        />
      )}
    </>
  );
}

function Box({ name, online, ports, col, selected, onClick }: { name: string; online?: boolean; ports: PortView[]; col: number; selected: boolean; onClick: () => void }) {
  return (
    <div className={`box ${online === false ? 'box-off' : ''}`} style={{ gridColumn: String(col), gridRow: '3' }}>
      <button type="button" className={`box-head ${selected ? 'sel' : ''}`} onClick={onClick} aria-pressed={selected}>
        <span className="box-name">{name}</span>
        <span className="sub">{online === false ? 'not seen' : `${ports.length} in use`}</span>
      </button>
      {ports.map((p, i) => (
        <PortCell key={i} p={p} />
      ))}
    </div>
  );
}

const PORT_WORD: Record<LinkState, string> = { ok: 'Driving', standby: 'Ready', lost: 'Lost', unknown: '—' };

function PortCell({ p }: { p: PortView }) {
  const loadSev = p.load ? (p.load.percent > 100 ? 'critical' : p.load.percent >= 90 ? 'warning' : 'ok') : undefined;
  return (
    <div className={`port link-${p.state} ${loadSev && loadSev !== 'ok' ? `port-${loadSev}` : ''}`} title={p.load ? `${p.load.pixels.toLocaleString()} of ${p.load.capacity.toLocaleString()} pixels` : undefined}>
      <span className="mono port-label">{p.label}</span>
      {p.load ? (
        <>
          <span className="bar" aria-hidden="true">
            <span className={`fill fill-${loadSev}`} style={{ width: `${Math.min(100, p.load.percent)}%` }} />
          </span>
          <span className="mono port-pct">{Math.round(p.load.percent)}%</span>
        </>
      ) : (
        <>
          <span className="dot" />
          <span className="port-state">{PORT_WORD[p.state]}</span>
        </>
      )}
    </div>
  );
}

function Chain({ c, selected, onClick }: { c: ChainView; selected: boolean; onClick: () => void }) {
  const shown = c.tiles.slice(0, MAX_TILES_DRAWN);
  const rightLink = c.loop === 'broken' ? 'lost' : c.loop === 'none' ? 'none' : 'standby';
  return (
    <button type="button" className={`chain ${rightLink === 'none' ? 'single' : ''} ${selected ? 'sel' : ''}`} onClick={onClick} aria-pressed={selected} aria-label={`Chain ${c.label}, ${c.tileCount} tiles, ${SEVERITY_LABEL[c.severity]}`}>
      <span className={`link link-${c.from.state}`} />
      <span className="tiles">
        {shown.map((t) => (
          <span key={t.id} className={`tile tile-${t.severity}`} title={t.label} />
        ))}
        {c.tileCount > shown.length && <span className="more-tiles">+{c.tileCount - shown.length}</span>}
      </span>
      {rightLink !== 'none' && <span className={`link link-${rightLink}`} />}
    </button>
  );
}

function Legend() {
  return (
    <div className="legend card">
      <span>
        <span className="key link-ok" />
        Driving
      </span>
      <span>
        <span className="key link-standby" />
        Standby or redundant end
      </span>
      <span>
        <span className="key link-lost" />
        Lost
      </span>
      <span>
        <span className="tile tile-warning" />
        Tile warning
      </span>
      <span>Port loads show where the processor reports enough to work them out (COEX). Brompton walls show link state only.</span>
    </div>
  );
}

// ---- Side panel ----

function Details({ state, sel }: { state: DashboardState; sel?: Selection }) {
  const body = detailBody(state, sel);
  return (
    <aside className="card details" aria-label="Details">
      <div className="kicker">Selected</div>
      {body ?? <p className="sub">Click a processor, distribution box or chain to see its details.</p>}
    </aside>
  );
}

function detailBody(state: DashboardState, sel?: Selection): React.ReactNode {
  if (!sel) return undefined;
  if (sel.kind === 'processor') {
    const p = state.processors.find((x) => x.id === sel.id);
    return p ? <ProcessorDetail p={p} /> : undefined;
  }
  if (sel.kind === 'box') {
    const wall = state.walls.find((w) => w.id === sel.wall);
    const g = wall?.groups[sel.group];
    const box = g?.[sel.side];
    if (!wall || !g || !box) return undefined;
    const ports = g.chains.map((c) => (sel.side === 'left' ? c.from : c.to)).filter((p): p is PortView => !!p);
    return (
      <>
        <h3>{box.name}</h3>
        <div className="sub">{wall.name}</div>
        <dl className="kv">
          <Row k="Fed by">{box.trunk ? `Trunk ${box.trunk}` : '—'}</Row>
          <Row k="Seen by the processor" cls={box.online === false ? 'bad' : ''}>
            {box.online === undefined ? 'Not checked (no serial in the layout)' : box.online ? 'Yes' : 'No'}
          </Row>
          <Row k="Firmware">{box.firmware ?? '—'}</Row>
          <Row k="Ports in use">{ports.length}</Row>
          <Row k="Ports lost" cls={ports.some((p) => p.state === 'lost') ? 'bad' : ''}>
            {ports.filter((p) => p.state === 'lost').map((p) => p.label).join(', ') || 'None'}
          </Row>
        </dl>
      </>
    );
  }
  for (const wall of state.walls) {
    for (const g of wall.groups) {
      const c = g.chains.find((x) => x.id === sel.id);
      if (!c) continue;
      const loopText = { ok: 'Loop confirmed by the processor', broken: 'Broken: the redundant end is lost', unknown: 'Not reported by the processor', none: 'Single-ended chain' }[c.loop];
      const bad = c.tiles.filter((t) => t.severity === 'warning' || t.severity === 'critical');
      return (
        <>
          <h3>Chain {c.label}</h3>
          <div className="sub">
            {wall.name} · {c.tileCount} tile{c.tileCount === 1 ? '' : 's'}
          </div>
          <dl className="kv">
            <Row k="Driven from">
              {g.left.name} port {c.from.label}
            </Row>
            {c.to && g.right && (
              <Row k="Redundant end" cls={c.to.state === 'lost' ? 'bad' : ''}>
                {g.right.name} port {c.to.label} · {PORT_WORD[c.to.state].toLowerCase()}
              </Row>
            )}
            <Row k="Cable loop" cls={c.loop === 'broken' ? 'bad' : ''}>
              {loopText}
            </Row>
            {c.from.load && (
              <Row k="Port load" cls={c.from.load.percent >= 90 ? 'bad' : ''}>
                {Math.round(c.from.load.percent)}% · {c.from.load.pixels.toLocaleString()} of {c.from.load.capacity.toLocaleString()} px
              </Row>
            )}
            <Row k="Tiles" cls={bad.length ? 'bad' : ''}>
              {bad.length ? `${bad.length} with problems` : c.tiles.some((t) => t.severity === 'ok') ? 'All OK' : 'Count only'}
            </Row>
          </dl>
          {bad.length > 0 && (
            <ul className="tile-list">
              {bad.map((t) => (
                <li key={t.id}>
                  <span className={`dot lvl-${t.severity}`} /> {t.label ?? t.id}
                  {t.detail && <span className="sub"> · {t.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {c.notes.map((n) => (
            <p key={n} className="note">
              {n}
            </p>
          ))}
        </>
      );
    }
  }
  return undefined;
}

function ProcessorDetail({ p }: { p: ProcessorView }) {
  const hottest = [...p.temperatures].sort((a, b) => b.value - a.value)[0];
  const fansOk = p.fans.filter((f) => f.running).length;
  return (
    <>
      <h3>{p.name}</h3>
      <div className="sub">
        {p.model ?? kindName(p.kind)} · <span className="mono">{p.host}</span>
      </div>
      <dl className="kv">
        <Row k="State" cls={p.severity === 'critical' || p.severity === 'warning' ? 'bad' : ''}>
          {p.reachable ? SEVERITY_LABEL[p.severity] : 'Offline'}
        </Row>
        {p.failover && <Row k="Failover role">{p.failover.role ?? '—'}</Row>}
        {p.failover?.partnerName && (
          <Row k="Partner" cls={p.failover.partnerPresent === false ? 'bad' : ''}>
            {p.failover.partnerName} · {p.failover.partnerPresent === false ? 'missing' : 'present'}
          </Row>
        )}
        <Row k="Hottest sensor">{hottest ? `${hottest.label} ${hottest.value.toFixed(1)} °C` : '—'}</Row>
        <Row k="Fans" cls={fansOk < p.fans.length ? 'bad' : ''}>
          {p.fans.length ? `${fansOk} of ${p.fans.length} running` : '—'}
        </Row>
        <Row k="Tiles">{p.tiles ? `${p.tiles.online} of ${p.tiles.associated} online` : '—'}</Row>
        <Row k="Firmware">{p.firmware ?? '—'}</Row>
      </dl>
      {p.alerts.length > 0 && (
        <ul className="alerts">
          {p.alerts.map((a) => (
            <li key={a.key} className={`alert sev-${a.severity}`}>
              <span className="dot" />
              <span>{a.message}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Row({ k, cls, children }: { k: string; cls?: string; children: React.ReactNode }) {
  return (
    <div className="kv-row">
      <dt>{k}</dt>
      <dd className={cls}>{children}</dd>
    </div>
  );
}
