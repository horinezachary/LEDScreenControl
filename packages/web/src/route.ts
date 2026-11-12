import { useEffect, useState } from 'react';

// Pages are real paths (/topology, /events...) so a link can be shared. The server answers every unknown path with
// the dashboard, which then picks the page from the address.
export type Page = 'overview' | 'topology' | 'events' | 'settings' | 'processor';

export interface Route {
  page: Page;
  /** The processor id on /processors/:id. */
  id?: string;
}

export const TABS: { page: Page; path: string; label: string }[] = [
  { page: 'overview', path: '/', label: 'Overview' },
  { page: 'topology', path: '/topology', label: 'Topology' },
  { page: 'events', path: '/events', label: 'Events' },
  { page: 'settings', path: '/settings', label: 'Settings' },
];

export function routeOf(pathname: string): Route {
  const proc = /^\/processors\/([^/]+)/.exec(pathname);
  if (proc) return { page: 'processor', id: decodeURIComponent(proc[1]) };
  return { page: TABS.find((p) => p.path !== '/' && pathname.startsWith(p.path))?.page ?? 'overview' };
}

export const processorPath = (id: string) => `/processors/${encodeURIComponent(id)}`;

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (path: string) => {
    if (path !== location.pathname + location.search) history.pushState(null, '', path);
    setRoute(routeOf(path));
    window.scrollTo(0, 0);
  };
  return [route, go];
}

/** For <a> elements: a normal click navigates in place, a modified click (new tab) is left to the browser. */
export function linkHandler(go: (path: string) => void, path: string) {
  return (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(path);
  };
}
