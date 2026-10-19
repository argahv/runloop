'use client';
/**
 * "Open in the world" on a legacy page (contract §4.1): the same run, event,
 * filter or pair, opened on `/` in its sheet beside the live town. Settings
 * (no sheet; they live in the Esc menu) get "Back to the world" instead.
 * The href is computed from the address bar when used, because the page
 * rewrites its own query (selection, filter) as you work.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { plainClick } from './nav';
import { hasInWorldSheet, inWorldHref } from './routes';

const here = () => `${window.location.pathname}${window.location.search}`;

export default function OpenInWorld({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [href, setHref] = useState('/');
  const [sheet, setSheet] = useState(true);
  const refresh = useCallback(() => {
    setHref(inWorldHref(here()));
    setSheet(hasInWorldSheet(here()));
  }, []);
  useEffect(refresh, [refresh]);
  const label = sheet ? 'Open in the world' : 'Back to the world';
  return (
    <a
      href={href}
      className={buttonClass('ghost', 'sm', compact)}
      title={sheet ? 'Open this in the town, beside the live world' : 'Back to the town'}
      aria-label={compact ? label : undefined}
      onPointerEnter={refresh}
      onFocus={refresh}
      onClick={(e) => {
        if (!plainClick(e)) return refresh();
        e.preventDefault();
        router.push(inWorldHref(here()));
      }}
    >
      <Icon name="globe" size={14} />
      {!compact && label}
    </a>
  );
}
