'use client';
/**
 * The Esc menu (contract §1.1 M, §4.1): Resume, Display (theme, quality,
 * motion, the 2D map view), Sound, Controls (keyboard, mouse, touch and the
 * truth legend), Runtime (URL, status, privacy and retention), Connections,
 * Pages (every full page) and Help. Settings persist per viewer. The world
 * keeps running behind it (it never auto-pauses).
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CC } from '../../../lib/claude-code';
import { DEFAULT_API_BASE, isLoopbackUrl, normalizeApiBase, validateApiBase } from '../../../lib/config';
import { useStudio, useStudioStore } from '../../../state/context';
import { ROUTES } from '../../../state/deeplink';
import type { MenuTab } from '../../../world/store';
import { Button } from '../../../ui/Button';
import { Chip } from '../../../ui/Chip';
import { CommandSnippet } from '../../../ui/CommandSnippet';
import { Dialog } from '../../../ui/Dialog';
import { Icon, type IconName } from '../../../ui/Icon';
import { Kbd, modKey } from '../../../ui/Kbd';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { toast } from '../../../ui/Toast';
import { useWorld, useWorldStore } from '../../../world/context';
import { BrandRing, WorldClockText } from './bits';
import styles from './hud.module.css';
import { uiSound } from './sound';
import { setTownView, useTownView } from './viewPref';

const TABS: { id: MenuTab; label: string; icon: IconName }[] = [
  { id: 'resume', label: 'Resume', icon: 'play' },
  { id: 'display', label: 'Display', icon: 'monitor' },
  { id: 'sound', label: 'Sound', icon: 'pulse' },
  { id: 'controls', label: 'Controls', icon: 'keyboard' },
  { id: 'runtime', label: 'Runtime', icon: 'database' },
  { id: 'connections', label: 'Connections', icon: 'integrations' },
  { id: 'pages', label: 'Pages', icon: 'overview' },
  { id: 'help', label: 'Help', icon: 'sparkle' },
];

export default function GameMenu({ tab, onTab, onClose, sound, connections, runtimeExtra }: { tab: MenuTab | null; onTab: (t: MenuTab) => void; onClose: () => void; sound?: ReactNode; connections?: ReactNode; runtimeExtra?: ReactNode }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const tabRef = useRef<HTMLButtonElement | null>(null);
  const open = tab !== null;
  const current = tab ?? 'resume';
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === current);
    const next = e.key === 'ArrowDown' ? (i + 1) % TABS.length : e.key === 'ArrowUp' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(TABS[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <Dialog open={open} onClose={onClose} labelledBy="menu-title" className={styles.menu} initialFocus={current === 'resume' ? resumeRef : tabRef}>
      <div className={styles.menuGrid} data-keys="own">
        <aside className={styles.menuSide}>
          <h2 id="menu-title" className={styles.menuTitle}>
            <span className={styles.brand} aria-hidden="true">
              <BrandRing size={16} />
            </span>
            Runloop
          </h2>
          <div role="tablist" aria-orientation="vertical" aria-label="Menu" className={styles.menuTabs} onKeyDown={onKey}>
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[i] = el;
                  if (t.id === current) tabRef.current = el;
                }}
                type="button"
                role="tab"
                id={`menu-tab-${t.id}`}
                aria-selected={t.id === current}
                aria-controls="menu-panel"
                tabIndex={t.id === current ? 0 : -1}
                className={styles.menuTab}
                onPointerEnter={() => uiSound('hover')}
                onClick={() => {
                  uiSound('select');
                  if (t.id === 'resume') onClose();
                  else onTab(t.id);
                }}
              >
                <Icon name={t.icon} size={15} />
                {t.label}
              </button>
            ))}
          </div>
          <p className={styles.menuFoot}>The world keeps running while this menu is open.</p>
        </aside>
        <div id="menu-panel" role="tabpanel" aria-labelledby={`menu-tab-${current}`} className={styles.menuPanel} tabIndex={-1}>
          {current === 'resume' && <ResumeTab onResume={onClose} onTab={onTab} resumeRef={resumeRef} />}
          {current === 'display' && <DisplayTab />}
          {current === 'sound' && <Section title="Sound">{sound ?? <p className={styles.menuHint}>No sound settings in this build.</p>}</Section>}
          {current === 'controls' && <ControlsTab />}
          {current === 'runtime' && <RuntimeTab extra={runtimeExtra} />}
          {current === 'connections' && <ConnectionsTab extra={connections} />}
          {current === 'pages' && <PagesTab onGo={onClose} />}
          {current === 'help' && <HelpTab />}
        </div>
      </div>
    </Dialog>
  );
}

function Section({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <section className={styles.menuSection}>
      <h3 className={styles.menuH}>{title}</h3>
      {lede && <p className={styles.menuHint}>{lede}</p>}
      {children}
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.menuRow}>
      <div>
        <p className={styles.menuLabel}>{label}</p>
        {help && <p className={styles.menuHint}>{help}</p>}
      </div>
      <div className={styles.menuControl}>{children}</div>
    </div>
  );
}

function ResumeTab({ onResume, onTab, resumeRef }: { onResume: () => void; onTab: (t: MenuTab) => void; resumeRef: React.RefObject<HTMLButtonElement | null> }) {
  const townName = useWorld((s) => s.town?.def.name ?? 'The town');
  const residents = useWorld((s) => s.snapshot?.residents.length ?? null);
  useWorld((s) => s.rev);
  const agents = useWorld((s) => s.snapshot?.agents ?? null);
  const speed = useWorld((s) => s.snapshot?.speed ?? null);
  const runtime = useStudio((s) => s.runtime.status);
  const store = useWorldStore();
  const live = agents?.filter((a) => a.health === 'live').length ?? 0;
  const openView = (v: 'map' | 'list') => {
    store.getState().setMenu(null);
    store.getState().setOverlay(v);
  };
  return (
    <Section title="The town keeps living." lede="Nothing pauses while this menu is open. Pick up where you were, or change how the town looks, sounds and moves.">
      <dl className={styles.statusGrid}>
        <div>
          <dt>Town</dt>
          <dd>
            {townName} · <WorldClockText />
          </dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{speed === null ? 'not reported' : speed === 0 ? 'Paused' : `${speed}× simulated time`}</dd>
        </div>
        <div>
          <dt>Residents</dt>
          <dd>{residents === null ? 'not reported' : `${residents} · Simulated`}</dd>
        </div>
        <div>
          <dt>Real agents</dt>
          <dd>{agents === null ? 'not reported' : agents.length === 0 ? 'none yet' : `${agents.length} · ${live} live`}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{runtime === 'online' ? 'Online' : runtime === 'offline' ? 'Offline' : 'Checking…'}</dd>
        </div>
      </dl>
      <div className={styles.menuBig}>
        <Button ref={resumeRef} variant="primary" icon="play" onClick={onResume}>
          Resume
        </Button>
        <Button variant="secondary" icon="keyboard" onClick={() => onTab('controls')}>
          Controls
        </Button>
        <Button variant="secondary" icon="monitor" onClick={() => onTab('display')}>
          Display
        </Button>
      </div>
      <p className={styles.menuLabel} style={{ marginTop: 20 }}>
        Views of the town (the 2D routes)
      </p>
      <div className={styles.menuBig} style={{ marginTop: 8 }}>
        <Button variant="secondary" icon="map" aria-keyshortcuts="M" onClick={() => openView('map')}>
          2D map
        </Button>
        <Button variant="secondary" icon="table" aria-keyshortcuts="L" onClick={() => openView('list')}>
          Directory of everyone and everything
        </Button>
      </div>
    </Section>
  );
}

function DisplayTab() {
  const store = useStudioStore();
  const s = store.getState();
  const theme = useStudio((x) => x.themePref);
  const motion = useStudio((x) => x.motionPref);
  const quality = useStudio((x) => x.quality);
  const view = useTownView();
  return (
    <Section title="Display" lede="Kept in this browser only.">
      <Row label="Theme" help="The HUD and labels. The town's light follows its own clock.">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={(v) => s.setThemePref(v)}
          options={[
            { value: 'system', label: 'System', icon: 'monitor' },
            { value: 'dark', label: 'Dark', icon: 'moon' },
            { value: 'light', label: 'Light', icon: 'sun' },
          ]}
        />
      </Row>
      <Row label="3D quality" help="Automatic lowers detail when frames run slow; low is lighter on battery and older GPUs.">
        <SegmentedControl
          label="3D quality"
          value={quality}
          onChange={(v) => s.setQuality(v)}
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' },
          ]}
        />
      </Row>
      <Row label="Motion" help="Reduced: camera cuts instead of flights, no ambient animation. Every state change stays visible.">
        <SegmentedControl
          label="Motion"
          value={motion}
          onChange={(v) => s.setMotionPref(v)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'reduce', label: 'Reduced' },
            { value: 'full', label: 'Full' },
          ]}
        />
      </Row>
      <Row label="Town view" help="The 2D map draws the same town, people and agents, without 3D.">
        <SegmentedControl
          label="Town view"
          value={view}
          onChange={(v) => setTownView(v)}
          options={[
            { value: '3d', label: '3D town', icon: 'world' },
            { value: 'map', label: '2D map', icon: 'map' },
          ]}
        />
      </Row>
    </Section>
  );
}

const KEYS: [string, string[]][] = [
  ['Move the view', ['W', 'A', 'S', 'D']],
  ['Move the view (arrows)', ['↑', '←', '↓', '→']],
  ['Turn left / right (hold to keep turning)', ['Q', 'E']],
  ['Tilt toward the horizon / top-down', ['Z', 'X']],
  ['Zoom in / out', ['+', '−']],
  ['Whole town · reset the direction', ['0', 'R']],
  ['Modes: Explore, Agents, Intelligence, Lab', ['1', '2', '3', '4']],
  ['Add to World', ['N']],
  ['Find anything', ['mod', 'K']],
  ['Pause or resume the world', ['Space']],
  ['Follow the selected resident', ['F']],
  ['Enter or leave a building', ['Enter']],
  ['2D map · directory (every entity)', ['M', 'L']],
  ['Hide the HUD', ['H']],
  ['This keyboard map', ['?']],
  ['Back out, one step at a time; then this menu', ['Esc']],
];

function ControlsTab() {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);
  return (
    <>
      <Section title="Keyboard">
        <dl className={styles.keys}>
          {KEYS.map(([what, keys]) => (
            <div key={what} className={styles.keyRow}>
              <dt>{what}</dt>
              <dd>
                <Kbd keys={keys.map((k) => (k === 'mod' ? mod : k))} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Mouse and touch">
        <dl className={styles.keys}>
          {[
            ['Pan', 'Drag · one finger'],
            ['Zoom toward the pointer', 'Wheel · pinch'],
            ['Turn and tilt', 'Right-drag or middle-drag · two-finger twist; two fingers up or down tilt'],
            ['Select (residents and robots are followed)', 'Click · tap'],
            ['Fly into a building', 'Double-click · double-tap'],
            ['Select and open the details', 'Long-press'],
          ].map(([what, how]) => (
            <div key={what} className={styles.keyRow}>
              <dt>{what}</dt>
              <dd className={styles.menuHint}>{how}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="What is real" lede="The town is simulated; agents are real. Labels always say which.">
        <ul className={styles.legend}>
          <li>
            <Chip icon="diamond">Simulated</Chip>
            <span>Residents, their decisions and conversations: rule-based and recorded by the engine. Cars, birds and clouds are decoration and never stand for anything.</span>
          </li>
          <li>
            <Chip icon="eye" tone="info">
              Real · Claude Code · observed
            </Chip>
            <span>Agents: what Claude Code's hooks reported. Runloop records it; it did not run or verify the work.</span>
          </li>
          <li>
            <Chip icon="inferred" tone="warn">
              Inferred
            </Chip>
            <span>Reconstructed by Runloop (an idle sweep closed a session); the agent did not report it.</span>
          </li>
          <li>
            <Chip>not reported</Chip>
            <span>The source does not expose a value. It is never shown as zero.</span>
          </li>
        </ul>
      </Section>
    </>
  );
}

function RuntimeTab({ extra }: { extra?: ReactNode }) {
  const store = useStudioStore();
  const override = useStudio((s) => s.apiBaseOverride);
  const runtime = useStudio((s) => s.runtime.status);
  const [draft, setDraft] = useState(override ?? DEFAULT_API_BASE);
  useEffect(() => setDraft(override ?? DEFAULT_API_BASE), [override]);
  const error = validateApiBase(draft);
  const normalized = normalizeApiBase(draft);
  const changed = !error && normalized !== (override ?? DEFAULT_API_BASE);
  const save = () => {
    if (error) return;
    store.getState().setApiBase(normalized === DEFAULT_API_BASE ? null : normalized);
    toast({ tone: 'ok', title: 'Runtime URL saved', description: `Connecting to ${normalized}.` });
  };
  return (
    <>
      <Section title="Runtime">
        <Row
          label="Status"
          help={<>Where the Studio finds the local runtime. Build default: <code>{DEFAULT_API_BASE}</code>.</>}
        >
          {runtime === 'online' ? (
            <Chip tone="ok" icon="check">
              online
            </Chip>
          ) : runtime === 'offline' ? (
            <Chip tone="err" icon="x">
              offline
            </Chip>
          ) : (
            <Chip icon="ellipsis">checking</Chip>
          )}
        </Row>
        <form
          className={styles.urlForm}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor="menu-runtime-url" className={styles.menuLabel}>
            Runtime URL
          </label>
          <div className={styles.urlRow}>
            <input id="menu-runtime-url" className={styles.input} value={draft} onChange={(e) => setDraft(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby="menu-runtime-msg" spellCheck={false} autoComplete="off" />
            <Button type="submit" size="sm" disabled={!changed}>
              Save
            </Button>
            {override && (
              <Button size="sm" variant="ghost" onClick={() => store.getState().setApiBase(null)}>
                Use default
              </Button>
            )}
          </div>
          <p id="menu-runtime-msg" className={error ? styles.fieldError : styles.menuHint} aria-live="polite">
            {error ?? (!isLoopbackUrl(normalized) ? 'This is not a loopback address. The runtime only listens on this machine.' : '')}
          </p>
        </form>
      </Section>
      {extra ?? (
        <Section title="Privacy and retention">
          <ul className={styles.facts}>
            <li>
              <Icon name="database" size={14} />
              <span>Runs and the world live in the runtime's data directory (<code>.runloop/</code> or <code>RUNLOOP_DATA_DIR</code>), append-only.</span>
            </li>
            <li>
              <Icon name="shield" size={14} />
              <span>Everything stays on this machine: the runtime listens on loopback, and secrets are masked before anything is stored.</span>
            </li>
            <li>
              <Icon name="clock" size={14} />
              <span>Kept until you delete them: stop the runtime and remove the data directory to erase everything.</span>
            </li>
          </ul>
          <Link className={styles.menuLink} href={ROUTES.settings}>
            All settings on their own page →
          </Link>
        </Section>
      )}
    </>
  );
}

function ConnectionsTab({ extra }: { extra?: ReactNode }) {
  const ingest = useStudio((s) => s.runtime.ingest);
  const store = useWorldStore();
  if (extra) return <>{extra}</>;
  return (
    <Section title="Connections" lede="Claude Code is observed through the Runloop plugin's hooks; Runloop records what it reports and never runs or approves its tools.">
      <Row label="Claude Code ingest">
        {ingest?.claudeCode ? (
          <Chip tone="ok" icon="check">
            ready · protocol {ingest.claudeCode.protocol}
          </Chip>
        ) : ingest ? (
          <Chip icon="slash">turned off</Chip>
        ) : (
          <Chip icon="ellipsis">not reported</Chip>
        )}
      </Row>
      <p className={styles.menuLabel}>Install the plugin once</p>
      <CommandSnippet command={CC.shellInstall} />
      <button
        type="button"
        className={styles.menuLink}
        onClick={() => {
          store.getState().setMenu(null);
          store.getState().setOverlay('connect');
        }}
      >
        Every step, the doctor and what is collected →
      </button>
    </Section>
  );
}

const PAGES: { href: string; label: string; text: string; icon: IconName }[] = [
  { href: ROUTES.overview, label: 'Sessions', text: 'Runtime health, live sessions, recent runs, the scripted demo', icon: 'overview' },
  { href: ROUTES.world, label: 'Live World', text: 'One run as a 3D diorama and its agent graph', icon: 'world' },
  { href: ROUTES.traces, label: 'Traces', text: 'Timeline, logs, metrics, the inspector', icon: 'traces' },
  { href: ROUTES.experiments, label: 'Experiments', text: 'Compare runs and baselines', icon: 'compare' },
  { href: ROUTES.integrations, label: 'Connect', text: 'Claude Code: status, install, doctor', icon: 'integrations' },
  { href: ROUTES.settings, label: 'Settings', text: 'Every preference on one page', icon: 'settings' },
];

function PagesTab({ onGo }: { onGo: () => void }) {
  return (
    <Section title="Pages" lede="Everything works inside the town; these full pages stay for long reading and old links.">
      <ul className={styles.pages}>
        {PAGES.map((p) => (
          <li key={p.href}>
            <Link className={styles.pageLink} href={p.href} onClick={onGo}>
              <Icon name={p.icon} size={16} />
              <span>
                <span className={styles.menuLabel}>{p.label}</span>
                <span className={styles.menuHint}>{p.text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function HelpTab() {
  return (
    <Section title="Help" lede="Runloop Commons is a simulated town where your real Claude Code agents live and work.">
      <ul className={styles.facts}>
        <li>
          <Icon name="map" size={14} />
          <span>Drag to move, scroll to zoom, right-drag to turn. Click anyone to see what they are doing and why; double-click a building to step inside.</span>
        </li>
        <li>
          <Icon name="plus" size={14} />
          <span>Add to World (N) gives your agent a building in the Agent District. It stays unpainted until Claude Code really reports from its folder.</span>
        </li>
        <li>
          <Icon name="pulse" size={14} />
          <span>Intelligence (3) opens the World Log at the Commons Library; every run link opens its full trace without leaving the town.</span>
        </li>
        <li>
          <Icon name="flask" size={14} />
          <span>Lab (4) compares two sessions at the Lattice Lab.</span>
        </li>
        <li>
          <Icon name="alert" size={14} />
          <span>Anything that needs you pops up top-right and stays in the bell's list. Sounds play only for real agent events.</span>
        </li>
      </ul>
    </Section>
  );
}
