import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useCrumbs } from './use-crumbs';

/** Page title, focus and screen-reader announcement on navigation. */
export function RouteEffects() {
  const { pathname, hash } = useLocation();
  const crumbs = useCrumbs();
  const title = crumbs.at(-1)?.label ?? '';
  const isFirstRender = useRef(true);

  useEffect(() => {
    document.title = title ? `${title} · CompilerLab` : 'CompilerLab';
  }, [title]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (!hash) return;
    }
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
      return;
    }
    const main = document.getElementById('main');
    main?.scrollTo(0, 0);
    main?.focus({ preventScroll: true });
  }, [pathname, hash]);

  return (
    <div aria-live="polite" className="sr-only">
      {title}
    </div>
  );
}
