import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus } from '@ledmon/shared';

/** Calls the monitor's JSON API. Throws an Error with the server's own message when it refuses. */
export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The monitor answered ${res.status}.`);
  return data;
}

/** Whether this browser has unlocked the settings. Rechecked every minute so an idle session shows as locked. */
export function useAuth(): { auth?: AuthStatus; setAuth: (a: AuthStatus) => void; refresh: () => void } {
  const [auth, setAuth] = useState<AuthStatus>();
  const refresh = useCallback(() => {
    api<AuthStatus>('GET', '/api/auth').then(setAuth, () => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);
  return { auth, setAuth, refresh };
}
