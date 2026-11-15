import { useEffect, useRef, useState } from 'react';
import type { HistorySeries } from '@ledmon/shared';

// One reading over time, as a small line chart. Readings are drawn as small multiples, one chart each, so every
// chart has one series and its title names it: no legend, no colour to decode. Hovering shows the value under the
// pointer; a dashed line marks the alert limit where there is one.

const H = 132;
const PAD = { top: 10, right: 12, bottom: 22, left: 44 };

export function Chart({ series, limit, rangeMs }: { series: HistorySeries; limit?: { value: number; label: string }; rangeMs: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number>();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = series.points;
  const end = pts.length ? Math.max(pts[pts.length - 1][0], Date.now()) : Date.now();
  const start = end - rangeMs;
  const values = pts.map((p) => p[1]);
  if (limit) values.push(limit.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (series.unit === 'RPM' || series.unit === '%' || series.unit === 'tiles') lo = Math.min(lo, 0);
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const span = hi - lo;
  hi += span * 0.08;
  if (lo !== 0) lo -= span * 0.08;

  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - start) / rangeMs) * iw;
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;

  // Break the line where samples are missing (the processor was unreachable), rather than drawing across the gap.
  const gap = Math.max(rangeMs / 60, 30_000);
  let d = '';
  pts.forEach(([t, v], i) => {
    const jump = i === 0 || t - pts[i - 1][0] > gap;
    d += `${jump ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const ticks = [lo, (lo + hi) / 2, hi];
  const nearest = hover === undefined ? undefined : pts.reduce((best, p) => (Math.abs(p[0] - hover) < Math.abs(best[0] - hover) ? p : best), pts[0]);
  const last = pts[pts.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < PAD.left || px > width - PAD.right) return setHover(undefined);
    setHover(start + ((px - PAD.left) / iw) * rangeMs);
  };

  return (
    <figure className="chart">
      <figcaption>
        <span>{series.label}</span>
        {last && (
          <span className="chart-now mono">
            {fmt(last[1])} {series.unit}
          </span>
        )}
      </figcaption>
      <div ref={box} className="chart-box">
        <svg width={width} height={H} role="img" aria-label={`${series.label}, ${pts.length} readings`} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="axis" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
                {fmt(v)}
              </text>
            </g>
          ))}
          <text className="axis" x={PAD.left} y={H - 5}>
            {timeLabel(start, rangeMs)}
          </text>
          <text className="axis" x={width - PAD.right} y={H - 5} textAnchor="end">
            now
          </text>
          {limit && (
            <g>
              <line className="limit" x1={PAD.left} x2={width - PAD.right} y1={y(limit.value)} y2={y(limit.value)} />
              <text className="axis limit-label" x={width - PAD.right} y={y(limit.value) - 4} textAnchor="end">
                {limit.label}
              </text>
            </g>
          )}
          <path className="line" d={d} />
          {nearest && (
            <g>
              <line className="cross" x1={x(nearest[0])} x2={x(nearest[0])} y1={PAD.top} y2={H - PAD.bottom} />
              <circle className="dot-mark" cx={x(nearest[0])} cy={y(nearest[1])} r={4} />
            </g>
          )}
        </svg>
        {nearest && (
          <div className="tooltip" style={{ left: Math.min(Math.max(x(nearest[0]) - 60, 0), width - 130) }}>
            <strong className="mono">
              {fmt(nearest[1])} {series.unit}
            </strong>
            <span>{new Date(nearest[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: rangeMs <= 3600_000 ? '2-digit' : undefined })}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString();
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

function timeLabel(t: number, range: number): string {
  if (range <= 3600_000) return '1 h ago';
  if (range <= 86400_000) return '24 h ago';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
