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
  /** HTTP port. Brompton defaults to 80, COEX to 8001. */
  port?: number;
  /** COEX: pixels one output port can drive, for the port load bars. Defaults to 650,000 (a 1G port at 8 bit, 60 Hz). */
  portCapacity?: number;
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
  /** What the input control sends to make this input active, e.g. "sdi:1" (Brompton) or "0" (COEX source id). */
  key?: string;
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
  /** Tessera's loop number: one per pair of distribution boxes (Tessera 3.5.2 numbers them from 1). */
  index: number;
  /** Stable key for this chain's loop: the loop number and the port it starts from, e.g. "2:C4". */
  key: string;
  /** The output port the chain starts from, e.g. "C4". Named even when the loop is lost. */
  port?: string;
  /** The port the loop comes back to, e.g. "D4", while it is found. */
  to?: string;
  /** Raw state text for this chain, e.g. "loop-found: A1->B1" or "no-loop-found: C1->No connection". */
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
  /** Brompton reports brightness in nits, COEX as a share of full brightness. Nits when missing. */
  brightnessUnit?: 'nits' | '%';
  preset?: { number: number; name: string };
  blackout?: boolean;
  freeze?: boolean;
  failover?: FailoverStatus;
  loops: CableLoop[];
  tiles?: TileSummary;
  /** Distribution boxes and other devices the processor lists (Brompton XD boxes), for matching the layout. */
  devices?: DeviceInfo[];
  /** Set by processors that report their own cabinet map (COEX): the wall, ready to draw. */
  topology?: ProcessorTopology;
  /** Presets stored on the processor, for the preset control. */
  presets?: { number: number; name: string }[];
  /** A line on what this processor cannot report, shown on its card (VX Pro over its control protocol). */
  note?: string;
  /** What the dashboard may ask this processor to do. Missing when controls are off or the driver has none. */
  controls?: ControlCapabilities;
}

// ---- Controls ----

export interface ControlCapabilities {
  brightness?: { min: number; max: number; step: number; unit: 'nits' | '%' };
  blackout?: boolean;
  freeze?: boolean;
  preset?: boolean;
  /** Inputs that can be made active, by key (see InputStatus). */
  input?: boolean;
  failover?: boolean;
  reboot?: boolean;
}

export type ControlRequest =
  | { action: 'brightness'; value: number }
  | { action: 'blackout'; value: boolean }
  | { action: 'freeze'; value: boolean }
  | { action: 'preset'; value: number }
  | { action: 'input'; value: string }
  | { action: 'failover' }
  | { action: 'reboot' };

/** Actions that change what is on the wall in a big way; the dashboard asks to confirm them, naming the processor. */
export const CONFIRM_ACTIONS: ControlRequest['action'][] = ['blackout', 'failover', 'input', 'reboot'];

// ---- Settings and admin ----

export interface AuthStatus {
  /** This browser holds an admin session. */
  unlocked: boolean;
  passwordSet: boolean;
  /** No password yet and this browser is on the machine running the monitor, so it may set the first one. */
  canSetFirstPassword: boolean;
  /** Minutes left before the session ends without activity. */
  expiresInMinutes?: number;
}

export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  /** TLS from the start (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user?: string;
  /** Write-only: the settings API sends "********" in its place. */
  pass?: string;
  from: string;
  to: string[];
  minSeverity: 'warning' | 'critical';
  /** The same alert is not emailed again within this many minutes. */
  repeatMinutes: number;
}

export interface HistorySeries {
  key: string;
  label: string;
  unit: string;
  points: [number, number][];
}

export interface ScanResult {
  host: string;
  kind: ProcessorKind;
  name?: string;
  model?: string;
  serial?: string;
  /** Already in the settings. */
  known: boolean;
}

export interface DeviceInfo {
  id: string;
  type?: string;
  firmware?: string;
  online?: boolean;
}

export interface ProcessorTopology {
  name?: string;
  groups: GroupView[];
  notes?: string[];
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
  /** Where it came from: the monitor's own rules (default), a processor's syslog, or a control action. */
  source?: 'monitor' | 'syslog' | 'control';
}

export interface DashboardState {
  version: string;
  startedAt: number;
  severity: Severity;
  processors: ProcessorView[];
  walls: WallView[];
  events: EventEntry[];
  /** Alert limits, for drawing them on charts. */
  limits: { tempWarnC: number; tempCritC: number; portLoadWarnPercent: number };
  /** False when the settings turn the dashboard's controls off. */
  controls: boolean;
}

// ---- Topology ----
// A wall is drawn the same way whatever feeds it: the processors at the top and bottom, and between them groups of
// outputs. A group has a left box and an optional right box (a pair of Brompton XD boxes, or a COEX processor's own
// outputs), and each row of a group is one tile chain, fed from a port on the left box and, when the chain is cabled
// as a loop, from the same port number on the right box.

/** How a wall is described in config.json (Brompton). COEX walls are built from the processor's own cabinet map. */
export interface WallLayout {
  id: string;
  name: string;
  /** Processor id of the processor that normally drives the wall. */
  primary: string;
  /** Processor id of its redundant partner, if there is one. */
  backup?: string;
  groups: GroupLayout[];
}

export interface BoxLayout {
  name: string;
  /** Processor output that feeds the box, e.g. "A" for an SX40's trunk A. Used to match cable loop reports. */
  trunk?: string;
  /** Tile ports on the box. Brompton XD: 10. */
  ports?: number;
  serial?: string;
}

export interface GroupLayout {
  left: BoxLayout;
  right?: BoxLayout;
  /** Tiles on the chain at each port, port 1 first. 0 means nothing is plugged into that port. */
  chains: number[];
}

export type LinkState = 'ok' | 'standby' | 'lost' | 'unknown';

export interface TileView {
  id: string;
  severity: Severity;
  label?: string;
  /** Free text for the side panel, e.g. "41.2 °C · 5.0 V". */
  detail?: string;
}

export interface PortView {
  /** e.g. "A1". */
  label: string;
  state: LinkState;
  /** Only where the processor reports enough to work it out (COEX). */
  load?: { pixels: number; capacity: number; percent: number };
}

export interface ChainView {
  id: string;
  label: string;
  /** Tiles drawn on the chain. A Brompton chain has the count from the layout and no per-tile status. */
  tiles: TileView[];
  tileCount: number;
  from: PortView;
  /** The far end, when the chain loops back to a second box. */
  to?: PortView;
  /** Whether the processor confirms the loop: ok, broken (redundant end lost), or not reported. */
  loop: 'ok' | 'broken' | 'unknown' | 'none';
  severity: Severity;
  notes: string[];
}

export interface BoxView {
  name: string;
  trunk?: string;
  online?: boolean;
  firmware?: string;
}

export interface GroupView {
  left: BoxView;
  right?: BoxView;
  chains: ChainView[];
}

export interface WallProcessorView {
  id: string;
  name: string;
  role: 'primary' | 'backup' | 'single';
  /** True for the processor currently driving the wall. */
  driving: boolean;
  severity: Severity;
  reachable: boolean;
  summary: string;
}

export interface TrunkView {
  label: string;
  /** Column of the box it feeds: group index and side. */
  group: number;
  side: 'left' | 'right';
  fromPrimary: LinkState;
  fromBackup?: LinkState;
}

export interface WallView {
  id: string;
  name: string;
  source: 'layout' | 'processor';
  severity: Severity;
  primary: WallProcessorView;
  backup?: WallProcessorView;
  trunks: TrunkView[];
  groups: GroupView[];
  notes: string[];
}

export type ServerMessage = { type: 'state'; state: DashboardState };

export function worstSeverity(list: Severity[]): Severity {
  let worst = SEVERITY_ORDER.length - 1;
  for (const s of list) worst = Math.min(worst, SEVERITY_ORDER.indexOf(s));
  return SEVERITY_ORDER[worst];
}
