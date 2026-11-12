// Types shared by the server and the dashboard. Every processor brand is turned into a ProcessorSnapshot by its driver,
// so the dashboard never needs to know which brand it is drawing.

export type ProcessorKind = 'brompton' | 'coex' | 'vxpro';

/** Worst first, so severities can be compared by index. */
export const SEVERITY_ORDER = ['critical', 'warning', 'unknown', 'ok'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface ProcessorConfig {
  /** Stable id used in URLs and the event log. */
  id: string;
  /** Display name. When missing, the name the processor reports is used. */
  name?: string;
  kind: ProcessorKind;
  host: string;
  /** HTTP port. Brompton defaults to 80. */
  port?: number;
}

export interface Reading {
  key: string;
  label: string;
  value: number;
  unit: string;
}

export interface FanStatus {
  key: string;
  label: string;
  rpm?: number;
  running: boolean;
}

export interface InputStatus {
  /** e.g. "SDI 1" */
  label: string;
  type: string;
  number: number;
  active: boolean;
  signal: boolean;
  width?: number;
  height?: number;
  rate?: number;
}

export interface FailoverStatus {
  enabled: boolean;
  role?: string;
  /** True when failover has happened, i.e. the backup is driving the wall. */
  active?: boolean;
  partnerPresent?: boolean;
  partnerName?: string;
  partnerSerial?: string;
  partnerAbsentSeconds?: number;
}

export interface CableLoop {
  index: number;
  /** Raw state text from the processor, e.g. "loop-found: A1->B1". */
  state: string;
  found: boolean;
}

export interface TileSummary {
  associated: number;
  online: number;
  errors: number;
  /** Firmware version -> number of tiles on it. */
  firmware: Record<string, number>;
}

export interface ProcessorSnapshot {
  id: string;
  name: string;
  kind: ProcessorKind;
  host: string;
  reachable: boolean;
  /** Epoch ms of the last good poll. */
  lastSeen?: number;
  lastError?: string;
  missedPolls: number;
  model?: string;
  serial?: string;
  firmware?: string;
  uptimeSeconds?: number;
  project?: string;
  temperatures: Reading[];
  fans: FanStatus[];
  inputs: InputStatus[];
  genlock?: { source: string; rate?: number };
  brightness?: number;
  preset?: { number: number; name: string };
  blackout?: boolean;
  freeze?: boolean;
  failover?: FailoverStatus;
  loops: CableLoop[];
  tiles?: TileSummary;
}

export interface Alert {
  /** Rule id plus the part it is about, e.g. "fan:case-one". Stable while the condition lasts. */
  key: string;
  rule: string;
  severity: 'warning' | 'critical';
  message: string;
  /** Epoch ms when it was first seen. */
  since: number;
}

export interface ProcessorView extends ProcessorSnapshot {
  severity: Severity;
  alerts: Alert[];
}

export interface EventEntry {
  id: number;
  time: number;
  processorId?: string;
  level: 'info' | 'ok' | 'warning' | 'critical';
  message: string;
}

export interface DashboardState {
  version: string;
  startedAt: number;
  severity: Severity;
  processors: ProcessorView[];
  events: EventEntry[];
}

export type ServerMessage = { type: 'state'; state: DashboardState };

export function worstSeverity(list: Severity[]): Severity {
  let worst = SEVERITY_ORDER.length - 1;
  for (const s of list) worst = Math.min(worst, SEVERITY_ORDER.indexOf(s));
  return SEVERITY_ORDER[worst];
}
