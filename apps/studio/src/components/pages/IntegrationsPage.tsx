'use client';
import { useRouter } from 'next/navigation';
import { CC, connectCommands, PLUGIN_DEFAULT_URL, pluginUrlPrefix } from '../../lib/claude-code';
import { apiBase, normalizeApiBase } from '../../lib/config';
import { useStudio, useStudioStore } from '../../state/context';
import { ROUTES } from '../../state/deeplink';
import { formatWhen } from '../../state/format';
import { selectRun, useTicker } from '../../state/hooks';
import { formatAgo, isTracedRun, lastTracedEventAt, runSubtitle } from '../../state/runs';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chip } from '../../ui/Chip';
import { CommandSnippet } from '../../ui/CommandSnippet';
import { Icon } from '../../ui/Icon';
import { Skeleton } from '../../ui/States';
import { OfflineState } from '../RunStates';
import { useStartDemo } from '../useStartDemo';
import styles from './Pages.module.css';

/** From integrations/claude-code-plugin/README.md, "What is collected". */
const COLLECTED = [
  ['Sessions', 'start and end, the project folder’s name only (never its path), the permission mode'],
  ['Prompts and final replies', 'stored as sensitive; RUNLOOP_TRACE_PROMPTS=0 stores a placeholder instead of your prompts'],
  ['Tool calls', 'tool name and inputs (commands, project-relative paths, search patterns), success or failure'],
  ['Tool results, summarised', 'sizes and counts (lines read, lines changed, files found) and the last 2 KB of command output, which the runtime reads for test counts such as “12 tests: 10 passed, 2 failed”'],
  ['Subagents', 'start and stop, their own tool calls, and the model and token usage Claude Code reports for them'],
  ['Permissions and markers', 'what was asked (a denial no hook reports is marked inferred), compaction, notifications, API errors'],
] as const;

const NOT_COLLECTED = [
  'File contents, diffs, or full command output',
  'Claude Code’s transcript files or their paths',
  'Absolute paths: they are made relative to the project, or shortened to ~/…',
  'Anything sent off this machine: the plugin posts to loopback addresses only',
  'The main agent’s token usage: Claude Code hooks do not report it',
] as const;

/** Integrations: connect Claude Code (real ingest status, install, doctor, what is collected, how to turn it off) and the scripted demo. */
export default function IntegrationsPage() {
  const runtime = useStudio((s) => s.runtime);
  useStudio((s) => s.apiBaseOverride); // re-render when the runtime URL changes
  const demo = useStartDemo();
  const base = apiBase();
  const cmds = connectCommands(base);
  const customUrl = pluginUrlPrefix(base) !== '';

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.pageHead}>
          <div>
            <h1 className={styles.h1}>Integrations</h1>
            <p className={styles.lede}>Bring real agent sessions into Runloop. Everything stays on this machine.</p>
          </div>
        </header>

        <Card title="Claude Code" subtitle="Plugin runloop-tracer · observe-only hooks" actions={<IngestChip />}>
          <div className={styles.cardBody}>
            <p className={styles.cardText}>
              The plugin records each Claude Code session as a run: the main agent and every subagent become robots, tool calls go to stations, failing commands become incidents.
              It never blocks, approves or changes what Claude Code does: hooks exit cleanly and print nothing.
            </p>
            {runtime.status === 'offline' ? <OfflineState compact /> : <IngestStatus />}

            <ol className={styles.steps}>
              <li className={styles.step}>
                <div className={styles.stepBody}>
                  <span className={styles.stepTitle}>Start the Runloop runtime</span>
                  <span className={styles.cardText}>From the Runloop repository root. On first start it writes the per-user ingest token the plugin reads.</span>
                  <CommandSnippet command={cmds.serve} />
                </div>
              </li>
              <li className={styles.step}>
                <div className={styles.stepBody}>
                  <span className={styles.stepTitle}>Load the plugin in Claude Code</span>
                  <span className={styles.cardText}>From your Runloop checkout (run it in the repository root):</span>
                  <CommandSnippet command={cmds.claude} />
                  <span className={styles.cardText}>Or install it from the marketplace, inside Claude Code:</span>
                  <CommandSnippet prompt=">" command={CC.marketplaceAdd} />
                  <CommandSnippet prompt=">" command={CC.marketplaceInstall} />
                  <span className={styles.cardText}>or from a shell:</span>
                  <CommandSnippet command={customUrl ? `${CC.shellInstall} --config runtime_url=${normalizeApiBase(base)}` : CC.shellInstall} />
                  <span className={styles.hint}>
                    <Icon name="alert" size={13} />
                    <span>Install it once: with both the checkout and the marketplace copy, every event is sent twice.</span>
                  </span>
                  {customUrl && (
                    <span className={styles.hint}>
                      <Icon name="link" size={13} />
                      <span>
                        This Studio reads the runtime at <code>{normalizeApiBase(base)}</code>, but the plugin posts to <code>{PLUGIN_DEFAULT_URL}</code> unless told otherwise, so these commands
                        set <code>RUNLOOP_URL</code> (or the plugin’s <code>runtime_url</code> option).
                      </span>
                    </span>
                  )}
                </div>
              </li>
              <li className={styles.step}>
                <div className={styles.stepBody}>
                  <span className={styles.stepTitle}>Check the connection</span>
                  <span className={styles.cardText}>Prints the runtime URL, whether the token file exists and the runtime answers, the spool size, the last accepted event and the last error, and sends anything still waiting in the spool.</span>
                  <CommandSnippet command={cmds.doctor} />
                </div>
              </li>
              <li className={styles.step}>
                <div className={styles.stepBody}>
                  <span className={styles.stepTitle}>Use Claude Code as normal</span>
                  <span className={styles.cardText}>The session appears under Live sessions on the Overview with your first prompt, labelled Traced · Claude Code, and the Studio opens it when nothing else is open.</span>
                </div>
              </li>
            </ol>
          </div>
        </Card>

        <div className={styles.grid2}>
          <Card title="What is collected" subtitle="Sent to the local runtime only">
            <div className={styles.cardBody}>
              <ul className={styles.list}>
                {COLLECTED.map(([what, detail]) => (
                  <li key={what} className={styles.yes}>
                    <Icon name="check" size={14} />
                    <span>
                      <strong>{what}</strong>: {detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.cardText}>Never collected:</p>
              <ul className={styles.list}>
                {NOT_COLLECTED.map((what) => (
                  <li key={what} className={styles.no}>
                    <Icon name="slash" size={14} />
                    <span>{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
          <Card title="Privacy and control">
            <div className={styles.cardBody}>
              <ul className={styles.list}>
                <li className={styles.yes}>
                  <Icon name="shield" size={14} />
                  <span>
                    <strong>Local only.</strong> The runtime listens on loopback; the plugin refuses any other address.
                  </span>
                </li>
                <li className={styles.yes}>
                  <Icon name="key" size={14} />
                  <span>
                    <strong>Authenticated writes.</strong> A per-user token in <code>~/.config/runloop/ingest-token</code> (mode 0600); requests from browser pages are rejected.
                  </span>
                </li>
                <li className={styles.yes}>
                  <Icon name="eyeOff" size={14} />
                  <span>
                    <strong>Secrets are masked twice</strong>, in the plugin and again in the runtime, before anything is stored.
                  </span>
                </li>
                <li className={styles.yes}>
                  <Icon name="eye" size={14} />
                  <span>
                    <strong>Honest labels.</strong> Traced runs say <em>Traced · Claude Code</em>; anything Runloop reconstructed says <em>inferred</em>; values Claude Code does not report say <em>not reported</em>.
                  </span>
                </li>
                <li className={styles.no}>
                  <Icon name="alert" size={14} />
                  <span>
                    <strong>Reads are local and unauthenticated.</strong> Any process of yours can read traced runs from the runtime, as it can read its database file. Traced runs contain prompts and commands.
                  </span>
                </li>
              </ul>
              <p className={styles.stepTitle}>Turn it off</p>
              <CommandSnippet label="This shell only" command={CC.offForShell} />
              <CommandSnippet label="Disable" command={CC.disable} />
              <CommandSnippet label="Uninstall" command={CC.uninstall} />
              <p className={styles.cardText}>
                <code>claude --bare</code> and <code>--safe-mode</code> sessions skip plugins, so they are never traced. <code>claude -p</code> sessions are traced while the plugin is enabled; set <code>RUNLOOP_TRACE=0</code> in CI.
              </p>
            </div>
          </Card>
        </div>

        <Card
          title="Scripted demo"
          subtitle="Built in · no setup"
          actions={
            <Chip icon="terminal" title="Runloop's runtime runs every tool itself">
              Executed
            </Chip>
          }
        >
          <div className={styles.cardBody}>
            <p className={styles.cardText}>
              A deterministic coding mission: scripted decisions, real tools. The runtime edits files and runs the test suite in a throwaway copy of a small repository, so you can see
              Runloop end to end before connecting an agent. It is not a model; its runs are labelled Executed, never Traced.
            </p>
            <div className={styles.cardActions}>
              <Button variant="primary" icon="play" onClick={() => void demo.start()} busy={demo.starting} disabled={demo.disabledReason !== null} title={demo.disabledReason ?? undefined}>
                Run demo mission
              </Button>
            </div>
            <CommandSnippet label="Or headless" command="pnpm demo -- --speed 0" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function IngestChip() {
  const runtime = useStudio((s) => s.runtime);
  const ingest = runtime.ingest;
  if (runtime.status === 'offline')
    return (
      <Chip tone="err" icon="x">
        runtime offline
      </Chip>
    );
  if (runtime.status === 'unknown') return <Chip icon="ellipsis">checking</Chip>;
  if (ingest?.claudeCode)
    return (
      <Chip tone="ok" icon="check">
        ingest ready
      </Chip>
    );
  if (ingest) return <Chip icon="slash">ingest turned off</Chip>;
  return (
    <Chip tone="warn" icon="alert">
      no Claude Code ingest in this runtime
    </Chip>
  );
}

/** What the runtime reports right now: the ingest endpoint, live traced sessions, and the last event Claude Code sent. */
function IngestStatus() {
  const store = useStudioStore();
  const router = useRouter();
  const runtime = useStudio((s) => s.runtime);
  const runs = useStudio((s) => s.runs);
  const live = runs.filter((r) => r.status === 'running' && isTracedRun(r));
  useTicker(live.length > 0, 15_000);
  if (runtime.status === 'unknown') return <Skeleton height={64} radius={8} />;
  const ingest = runtime.ingest;
  const last = lastTracedEventAt(runs);
  const traced = runs.filter(isTracedRun).length;
  const newest = live[0];

  return (
    <dl className={styles.statusStrip}>
      <div>
        <dt>Ingest endpoint</dt>
        <dd>
          {ingest?.claudeCode ? (
            <>
              ready · protocol {ingest.claudeCode.protocol}
              <br />
              <code className={styles.small}>/api/ingest/claude-code</code>
            </>
          ) : ingest ? (
            'turned off: the runtime was started with RUNLOOP_TRACE=off'
          ) : (
            'not available: update Runloop and restart the runtime'
          )}
        </dd>
      </div>
      <div>
        <dt>Live sessions</dt>
        <dd>
          {live.length === 0 ? (
            'none'
          ) : (
            <>
              {live.length} ·{' '}
              <button
                type="button"
                className={styles.rowLink}
                onClick={() => {
                  selectRun(store, newest!.runId);
                  router.push(ROUTES.world);
                }}
              >
                watch {runSubtitle(newest!) ?? 'the newest'}
              </button>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Sessions recorded</dt>
        <dd>{traced}</dd>
      </div>
      <div>
        <dt>Last event from Claude Code</dt>
        <dd>{last ? `${formatAgo(Math.max(0, Date.now() - Date.parse(last)))} ago · ${formatWhen(last)}` : <span className={styles.none}>none yet</span>}</dd>
      </div>
    </dl>
  );
}
