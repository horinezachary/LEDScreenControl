import type { ControlCapabilities, ControlRequest, ProcessorConfig, ProcessorSnapshot } from '@ledmon/shared';

/** What one successful poll learns. The monitor adds id, host, reachability, timing and control capabilities. */
export type PolledData = Omit<ProcessorSnapshot, 'id' | 'host' | 'kind' | 'reachable' | 'lastSeen' | 'lastError' | 'missedPolls' | 'name' | 'controls'> & {
  /** The name the processor reports for itself. */
  reportedName?: string;
};

export interface Driver {
  /** Reads everything this driver can see. Throws on any network or protocol failure. */
  poll(signal: AbortSignal): Promise<PolledData>;
  /** What this driver can control. */
  capabilities?: ControlCapabilities;
  /** Sends one control command. Throws with a message a person can act on when the processor refuses it. */
  control?(req: ControlRequest, signal: AbortSignal): Promise<void>;
}

export type DriverFactory = (config: ProcessorConfig) => Driver;
