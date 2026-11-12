import type { ProcessorConfig, ProcessorSnapshot } from '@ledmon/shared';

/** What one successful poll learns. The monitor adds id, host, reachability and timing. */
export type PolledData = Omit<ProcessorSnapshot, 'id' | 'host' | 'kind' | 'reachable' | 'lastSeen' | 'lastError' | 'missedPolls' | 'name'> & {
  /** The name the processor reports for itself. */
  reportedName?: string;
};

export interface Driver {
  /** Reads everything this driver can see. Throws on any network or protocol failure. */
  poll(signal: AbortSignal): Promise<PolledData>;
}

export type DriverFactory = (config: ProcessorConfig) => Driver;
