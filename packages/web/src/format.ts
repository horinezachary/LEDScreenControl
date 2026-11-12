import type { Severity } from '@ledmon/shared';

export const SEVERITY_LABEL: Record<Severity, string> = { ok: 'OK', warning: 'Warning', critical: 'Critical', unknown: 'Waiting' };

export function ago(ms: number | undefined, now: number): string {
  if (ms === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function rate(r: number | undefined): string {
  if (r === undefined) return '';
  return Number.isInteger(r) ? `${r}` : r.toFixed(2);
}
