'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_API_BASE, isLoopbackUrl, normalizeApiBase, validateApiBase } from '../../lib/config';
import { useStudio, useStudioStore } from '../../state/context';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chip } from '../../ui/Chip';
import { Icon } from '../../ui/Icon';
import { Kbd, modKey } from '../../ui/Kbd';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { toast } from '../../ui/Toast';
import styles from './Pages.module.css';

function Setting({ label, help, children }: { label: string; help: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.settingRow}>
      <div>
        <p className={styles.settingLabel}>{label}</p>
        <p className={styles.settingHelp}>{help}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ['Search, jump to a run or page, run a command', ['mod', 'K']],
  ['Focus the search on Traces and the timeline', ['/']],
  ['Play or pause', ['Space']],
  ['Previous / next event', ['←', '→']],
  ['Go live', ['L']],
  ['Previous / next agent', ['[', ']']],
  ['Follow the selected agent', ['F']],
  ['Move between timeline or log rows', ['↑', '↓']],
  ['Clear the selection, close a dialog', ['Esc']],
];

/** Settings: appearance, motion, render quality, runtime URL, privacy and retention, shortcuts. */
export default function SettingsPage() {
  const store = useStudioStore();
  const themePref = useStudio((s) => s.themePref);
  const motionPref = useStudio((s) => s.motionPref);
  const quality = useStudio((s) => s.quality);
  const override = useStudio((s) => s.apiBaseOverride);
  const runtime = useStudio((s) => s.runtime.status);
  const [draft, setDraft] = useState(override ?? DEFAULT_API_BASE);
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => setMod(modKey()), []);
  useEffect(() => setDraft(override ?? DEFAULT_API_BASE), [override]);
  const s = store.getState();

  const error = validateApiBase(draft);
  const normalized = normalizeApiBase(draft);
  const current = override ?? DEFAULT_API_BASE;
  const changed = !error && normalized !== current;

  const saveUrl = () => {
    if (error) return;
    s.setApiBase(normalized === DEFAULT_API_BASE ? null : normalized);
    toast({ tone: 'ok', title: 'Runtime URL saved', description: `Connecting to ${normalized}.` });
  };

  const resetLayout = () => {
    try {
      for (const key of Object.keys(window.localStorage)) if (key.startsWith('runloop.layout.')) window.localStorage.removeItem(key);
      toast({ tone: 'ok', title: 'Panel sizes reset', description: 'They return to the defaults the next time each page opens.' });
    } catch {
      toast({ tone: 'err', title: 'Could not reset panel sizes', description: 'This browser blocks local storage.' });
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.h1}>Settings</h1>
            <p className={styles.lede}>Preferences are kept in this browser only.</p>
          </div>
        </header>

        <Card title="Appearance">
          <Setting label="Theme" help="Dark is the signature look; light suits long trace reading and reports.">
            <SegmentedControl
              label="Theme"
              value={themePref}
              onChange={(v) => s.setThemePref(v)}
              options={[
                { value: 'system', label: 'System', icon: 'monitor' },
                { value: 'dark', label: 'Dark', icon: 'moon' },
                { value: 'light', label: 'Light', icon: 'sun' },
              ]}
            />
          </Setting>
          <Setting label="Motion" help="Reduced motion removes travel and transitions; every state change stays visible.">
            <SegmentedControl
              label="Motion"
              value={motionPref}
              onChange={(v) => s.setMotionPref(v)}
              options={[
                { value: 'system', label: 'System' },
                { value: 'reduce', label: 'Reduced' },
                { value: 'full', label: 'Full' },
              ]}
            />
          </Setting>
          <Setting label="3D render quality" help="Automatic lowers the town's detail when frames run slow; high always adds glow and shadows; low is lighter on battery and older GPUs.">
            <SegmentedControl
              label="Render quality"
              value={quality}
              onChange={(v) => s.setQuality(v)}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'high', label: 'High' },
                { value: 'low', label: 'Low' },
              ]}
            />
          </Setting>
          <Setting label="Panel sizes" help="Resizable panels remember their size in this browser.">
            <Button size="sm" icon="refresh" onClick={resetLayout}>
              Reset panel sizes
            </Button>
          </Setting>
        </Card>

        <Card
          title="Runtime"
          actions={
            runtime === 'online' ? (
              <Chip tone="ok" icon="check">
                online
              </Chip>
            ) : runtime === 'offline' ? (
              <Chip tone="err" icon="x">
                offline
              </Chip>
            ) : (
              <Chip icon="ellipsis">checking</Chip>
            )
          }
        >
          <Setting
            label="Runtime URL"
            help={
              <>
                Where the Studio finds the local runtime. Build default: <code>{DEFAULT_API_BASE}</code> (set NEXT_PUBLIC_RUNLOOP_API when building to change it).
              </>
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveUrl();
              }}
            >
              <div className={styles.field}>
                <label htmlFor="runtime-url" className="sr-only">
                  Runtime URL
                </label>
                <input
                  id="runtime-url"
                  className={styles.input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="runtime-url-msg"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button type="submit" size="sm" disabled={!changed}>
                  Save
                </Button>
                {override && (
                  <Button size="sm" variant="ghost" onClick={() => s.setApiBase(null)}>
                    Use default
                  </Button>
                )}
              </div>
              <p id="runtime-url-msg" className={error ? styles.fieldError : !isLoopbackUrl(normalized) ? styles.fieldWarn : styles.settingHelp} aria-live="polite">
                {error ?? (!isLoopbackUrl(normalized) ? 'This is not a loopback address. The runtime only listens on this machine.' : '')}
              </p>
            </form>
          </Setting>
        </Card>

        <Card title="Privacy and retention">
          <div className={styles.cardBody}>
            <ul className={styles.list}>
              <li className={styles.yes}>
                <Icon name="database" size={14} />
                <span>
                  <strong>Where runs live.</strong> In the runtime’s data directory: <code>.runloop/</code> in the repository by default, or <code>RUNLOOP_DATA_DIR</code>. Events
                  are append-only in <code>runloop.db</code>; artifacts sit next to it.
                </span>
              </li>
              <li className={styles.yes}>
                <Icon name="clock" size={14} />
                <span>
                  <strong>Retention.</strong> Runs are kept until you delete them. There is no deletion command yet: stop the runtime and remove the data directory to erase
                  everything.
                </span>
              </li>
              <li className={styles.yes}>
                <Icon name="shield" size={14} />
                <span>
                  <strong>Nothing leaves this machine.</strong> No telemetry, no accounts; fonts are bundled with the Studio.
                </span>
              </li>
              <li className={styles.yes}>
                <Icon name="alert" size={14} />
                <span>
                  <strong>Read access.</strong> Any process on this machine can read the runtime’s API, including prompts in traced runs.
                </span>
              </li>
            </ul>
          </div>
        </Card>

        <Card title="Keyboard shortcuts">
          <table className={styles.kbdTable} id="shortcuts">
            <tbody>
              {SHORTCUTS.map(([what, keys]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td>
                    <Kbd keys={keys.map((k) => (k === 'mod' ? mod : k))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
