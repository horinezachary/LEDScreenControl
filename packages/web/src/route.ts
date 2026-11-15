import { useEffect, useState } from 'react';

// Pages are real paths (/topology, /events...) so a link can be shared. The server answers every unknown path with
// the dashboard, which then picks the page from the address.
export type Page = 'overview' | 'topology' | 'events';

export const PAGES: { page: Page; path: string; label: string }[] = [
  { page: 'overview', path: '/', label: 'Overview' },
  { page: 'topology', path: '/topology', label: 'Topology' },
  { page: 'events', path: '/events', label: 'Events' },
];

function pageOf(pathname: string): Page {
  return PAGES.find((p) => p.path !== '/' && pathname.startsWith(p.path))?.page ?? 'overview';
}

export function useRoute(): [Page, (path: string) => void] {
  const [page, setPage] = useState<Page>(() => pageOf(location.pathname));
  useEffect(() => {
    const onPop = () => setPage(pageOf(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (path: string) => {
    if (path !== location.pathname + location.search) history.pushState(null, '', path);
    setPage(pageOf(path));
    window.scrollTo(0, 0);
  };
  return [page, go];
}

/** For <a> elements: a normal click navigates in place, a modified click (new tab) is left to the browser. */
export function linkHandler(go: (path: string) => void, path: string) {
  return (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(path);
  };
}
