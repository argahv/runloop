'use client';
import { useRouter } from 'next/navigation';
import { apiBase } from '../lib/config';
import { useStudio, useStudioStore } from '../state/context';
import { ROUTES } from '../state/deeplink';
import { areaOf, formatWhen, isRunPage } from '../state/format';
import { selectRun, useTicker } from '../state/hooks';
import { isPinned } from '../state/baselines';
import { activityText, groupRuns, isTracedRun, runSourceLabel, shortId } from '../state/runs';
import { runStatusView } from '../state/view';
import type { RunSummary } from '@runloop-world/events';
import { Button } from '../ui/Button';
import { GlyphIcon, Icon } from '../ui/Icon';
import { Sidebar, type NavItem } from '../ui/Sidebar';
import styles from './StudioSidebar.module.css';

/** Areas that work today; Evaluations stays hidden until it does. */
const AREAS = [
  { href: ROUTES.overview, label: 'Overview', icon: 'overview' },
  { href: ROUTES.world, label: 'Live World', icon: 'world' },
  { href: ROUTES.traces, label: 'Traces', icon: 'traces' },
  { href: ROUTES.experiments, label: 'Experiments', icon: 'compare' },
  { href: ROUTES.integrations, label: 'Integrations', icon: 'integrations' },
  { href: ROUTES.settings, label: 'Settings', icon: 'settings' },
] as const;

const RECENT = 8;

export default function StudioSidebar({ pathname, rail, onNavigate }: { pathname: string; rail: boolean; onNavigate?: () => void }) {
  const store = useStudioStore();
  const router = useRouter();
  const runs = useStudio((s) => s.runs);
  const runId = useStudio((s) => s.runId);
  const runtime = useStudio((s) => s.runtime);
  const themePref = useStudio((s) => s.themePref);
  const area = areaOf(pathname);

  const items: NavItem[] = AREAS.map((a) => ({ ...a, active: area === a.href }));

  const open = (id: string) => {
    selectRun(store, id);
    if (!isRunPage(pathname)) router.push(ROUTES.world);
    onNavigate?.();
  };

  const groups = groupRuns(runs);
  const recent = runs.filter((r) => r.status !== 'running').slice(0, RECENT);
  useTicker(groups.live.length > 0, 15_000);
  const now = Date.now();

  const row = (r: RunSummary) => {
    const traced = isTracedRun(r);
    const view = runStatusView(r.status, r.paused, traced);
    const n = runs.length - runs.indexOf(r);
    const activity = r.status === 'running' && traced ? activityText(r, now) : null;
    const meta = r.source ? `session ${shortId(r.source.sessionId)}` : `#${n}`;
    return (
      <li key={r.runId}>
        <button type="button" className={styles.run} aria-current={r.runId === runId ? 'true' : undefined} onClick={() => open(r.runId)}>
          <span className={styles.runStatus} data-tone={view.tone} title={view.text}>
            <GlyphIcon glyph={view.icon} size={12} />
            <span className="sr-only">{view.text}</span>
          </span>
          <span className={styles.runTitle}>{r.title}</span>
          <span className={styles.runMeta}>
            <Icon name={traced ? 'eye' : 'terminal'} size={11} label={runSourceLabel(r)} />
            {/* Before the text, which truncates first, so the baseline mark is never cut off. */}
            {isPinned(r) && (
              <span className={styles.baseline} title="Pinned as a baseline">
                <Icon name="pin" size={11} label="Baseline" />
              </span>
            )}
            <span className={styles.runMetaText}>
              {meta} · {activity ?? formatWhen(r.createdAt)}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const nextTheme = themePref === 'dark' ? 'light' : themePref === 'light' ? 'system' : 'dark';
  const host = apiBase().replace(/^https?:\/\//, '');

  return (
    <div className={styles.wrap} data-rail={rail || undefined}>
      <Sidebar
        items={items}
        rail={rail}
        onNavigate={onNavigate}
        footer={
          <div className={styles.footer}>
            <div className={styles.runtime} title={`Runtime ${host}${runtime.version ? ` · v${runtime.version}` : ''}`}>
              <span className={styles.runtimeDot} data-status={runtime.status} aria-hidden="true" />
              <span className={styles.runtimeText}>
                <span className={styles.runtimeLabel}>
                  {runtime.status === 'online' ? 'Runtime online' : runtime.status === 'offline' ? 'Runtime offline' : 'Checking runtime…'}
                </span>
                <span className={styles.runtimeHost}>{host}</span>
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={themePref === 'dark' ? 'moon' : themePref === 'light' ? 'sun' : 'monitor'}
              aria-label={`Theme: ${themePref}. Switch to ${nextTheme}`}
              title={`Theme: ${themePref} (switch to ${nextTheme})`}
              onClick={() => store.getState().setThemePref(nextTheme)}
            />
          </div>
        }
      >
        {!rail && groups.live.length > 0 && (
          <section aria-labelledby="sidebar-live" className={styles.runs}>
            <h2 id="sidebar-live" className={styles.heading}>
              <span className={styles.liveDot} aria-hidden="true" />
              Live
            </h2>
            <ol className={styles.list}>{groups.live.map(row)}</ol>
          </section>
        )}
        {!rail && recent.length > 0 && (
          <section aria-labelledby="sidebar-runs" className={styles.runs}>
            <h2 id="sidebar-runs" className={styles.heading}>
              Recent runs
            </h2>
            <ol className={styles.list}>{recent.map(row)}</ol>
            {runs.length > groups.live.length + RECENT && (
              <a href={ROUTES.overview} className={styles.more} onClick={(e) => (e.preventDefault(), router.push(ROUTES.overview), onNavigate?.())}>
                All {runs.length} runs
              </a>
            )}
          </section>
        )}
        {!rail && runtime.status === 'online' && runs.length === 0 && (
          <p className={styles.empty}>No runs yet. Start the demo mission or connect Claude Code from Overview.</p>
        )}
      </Sidebar>
    </div>
  );
}
