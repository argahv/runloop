'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiBase } from '../../lib/config';
import { useStudio, useStudioStore } from '../../state/context';
import { ROUTES } from '../../state/deeplink';
import { useWorld, useWorldStore } from '../../world/context';
import { MODE_LABEL, MODES, modeOfRoute, worldHref, type Mode } from '../../world/link';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import styles from './ModeRail.module.css';

const MODE_ICON: Record<Mode, IconName> = { explore: 'map', agents: 'agent', intelligence: 'pulse', lab: 'flask' };
const MODE_HINT: Record<Mode, string> = {
  explore: 'Explore the town',
  agents: 'Your agents, the Agent District and Arrivals',
  intelligence: 'World Log and traces',
  lab: 'Compare sessions (Experiments)',
};

/** Pages that are not modes but stay one click away. */
const PAGES: { href: string; label: string; icon: IconName }[] = [
  { href: ROUTES.overview, label: 'Sessions', icon: 'overview' },
  { href: ROUTES.integrations, label: 'Connect', icon: 'integrations' },
  { href: ROUTES.settings, label: 'Settings', icon: 'settings' },
];

/**
 * The world's primary navigation (plan §5, UX §1): Explore, Agents,
 * Intelligence and Lab (keys 1–4). Society and Build stay hidden until they
 * work. On the town a mode switches in place; elsewhere it opens the town in
 * that mode (Lab: the Lattice Lab with the compare sheet, `/?mode=lab`).
 */
export default function ModeRail({ pathname, onNavigate, expanded }: { pathname: string; onNavigate?: () => void; expanded?: boolean }) {
  const router = useRouter();
  const world = useWorldStore();
  const studio = useStudioStore();
  const worldMode = useWorld((s) => s.mode);
  const runtime = useStudio((s) => s.runtime);
  const themePref = useStudio((s) => s.themePref);
  const onTown = (pathname.replace(/\/+$/, '') || '/') === '/';
  const path = pathname.replace(/\/+$/, '') || '/';
  // A page with its own rail item (Sessions, Connect, Settings) highlights only that item.
  const active = onTown ? worldMode : PAGES.some((p) => p.href === path) ? null : modeOfRoute(pathname);

  const go = (mode: Mode) => {
    onNavigate?.();
    // Every mode opens in the town now (Lab is the Lattice Lab with the compare sheet).
    if (onTown) world.getState().setMode(mode);
    else router.push(worldHref({ mode }));
  };

  const nextTheme = themePref === 'dark' ? 'light' : themePref === 'light' ? 'system' : 'dark';
  const host = apiBase().replace(/^https?:\/\//, '');

  return (
    <div className={styles.rail} data-expanded={expanded || undefined}>
      <Link href="/" className={styles.brand} aria-label="Runloop, the town" title="Runloop · the town" onClick={onNavigate}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M12 3a9 9 0 1 1-8.5 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="5.2" cy="5.6" r="2.1" fill="currentColor" />
        </svg>
      </Link>
      <nav aria-label="Modes" className={styles.modes}>
        <ul>
          {MODES.map((m, i) => (
            <li key={m}>
              <button
                type="button"
                className={styles.mode}
                aria-current={active === m ? 'page' : undefined}
                aria-keyshortcuts={onTown ? String(i + 1) : undefined}
                title={`${MODE_HINT[m]}${onTown ? ` (${i + 1})` : ''}`}
                onClick={() => go(m)}
              >
                <Icon name={MODE_ICON[m]} size={20} />
                <span className={styles.label}>{MODE_LABEL[m]}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <nav aria-label="Pages" className={styles.pages}>
        <ul>
          {PAGES.map((p) => (
            <li key={p.href}>
              <Link href={p.href} className={styles.page} aria-current={path === p.href ? 'page' : undefined} title={p.label} onClick={onNavigate}>
                <Icon name={p.icon} size={18} />
                <span className={styles.label}>{p.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.foot}>
        <span
          className={styles.runtime}
          data-status={runtime.status}
          title={`${runtime.status === 'online' ? 'Runtime online' : runtime.status === 'offline' ? 'Runtime offline' : 'Checking runtime…'} · ${host}`}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className="sr-only">{runtime.status === 'online' ? 'Runtime online' : runtime.status === 'offline' ? 'Runtime offline' : 'Checking runtime'}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={themePref === 'dark' ? 'moon' : themePref === 'light' ? 'sun' : 'monitor'}
          aria-label={`Theme: ${themePref}. Switch to ${nextTheme}`}
          title={`Theme: ${themePref} (switch to ${nextTheme})`}
          onClick={() => studio.getState().setThemePref(nextTheme)}
        />
      </div>
    </div>
  );
}
