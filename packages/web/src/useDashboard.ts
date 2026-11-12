import { useEffect, useState } from 'react';
import type { DashboardState, ServerMessage } from '@ledmon/shared';

export type Connection = 'connecting' | 'live' | 'lost';

/** Live state from the server's WebSocket, reconnecting with back-off if the server goes away. */
export function useDashboard(): { state?: DashboardState; connection: Connection; receivedAt?: number } {
  const [state, setState] = useState<DashboardState>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [receivedAt, setReceivedAt] = useState<number>();

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        delay = 1000;
        setConnection('live');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.type === 'state') {
          setState(msg.state);
          setReceivedAt(Date.now());
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setConnection('lost');
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { state, connection, receivedAt };
}

/** Re-renders every second, for "updated 3 s ago" style labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
