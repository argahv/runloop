'use client';
import dynamic from 'next/dynamic';
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { connectionState, connectionView } from '../state/connection';
import { useStudio, useStudioStore } from '../state/context';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/States';
import GraphView from '../views/graph/GraphView';
import CharacterRoster from './CharacterRoster';
import styles from './WorldStage.module.css';

const WorldCanvas = dynamic(() => import('../scene/WorldCanvas'), {
  ssr: false,
  loading: () => <StageMessage title="Loading the 3D world…" />,
});

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function StageMessage({ title, children, tone }: { title: string; children?: ReactNode; tone?: 'err' | 'warn' }) {
  return (
    <div className={styles.message} role={tone ? 'alert' : 'status'} data-tone={tone}>
      <p className={styles.messageTitle}>{title}</p>
      {children}
    </div>
  );
}

/**
 * The Live World stage: the 3D world (scene internals are owned by src/scene)
 * or, in the 2D slot, the Network view (agent graph or table; src/views/graph).
 * Floating glass controls sit over the canvas; the roster is the keyboard route
 * to every character.
 */
export default function WorldStage({ allow3d = true }: { allow3d?: boolean }) {
  const world = useStudio((s) => s.world);
  const runId = useStudio((s) => s.runId);
  const getFrame = useStudio((s) => s.getFrame);
  const subscribeEffects = useStudio((s) => s.subscribeEffects);
  const selectedAgentId = useStudio((s) => s.selectedAgentId);
  const selectedStationId = useStudio((s) => s.selectedStationId);
  const selectedSeq = useStudio((s) => s.selectedSeq);
  // The overlay chip says what the header says (one source: the connection state).
  const conn = connectionView(useStudio((s) => connectionState(s)));
  const store = useStudioStore();
  const lastSequence = useStudio((s) => s.lastSequence);
  // The scene only knows characters: pass a selected agent through only when it has one.
  const embodiedSelected = useMemo(
    () => selectedAgentId !== null && store.getState().stateAt(lastSequence).exec.agents[selectedAgentId]?.embodied === true,
    [store, selectedAgentId, lastSequence],
  );
  const selectAgent = useStudio((s) => s.selectAgent);
  const selectStation = useStudio((s) => s.selectStation);
  const cameraMode = useStudio((s) => s.cameraMode);
  const setCameraMode = useStudio((s) => s.setCameraMode);
  const follow = useStudio((s) => s.follow);
  const toggleFollow = useStudio((s) => s.toggleFollow);
  const quality = useStudio((s) => s.quality);
  const setQuality = useStudio((s) => s.setQuality);
  const reducedMotion = useStudio((s) => s.reducedMotion);
  const view = useStudio((s) => s.worldView);
  const setView = useStudio((s) => s.setWorldView);

  const [webgl, setWebgl] = useState<'checking' | 'ok' | 'unavailable'>('checking');
  // The world whose canvas has rendered: a new run's world is not ready until its own canvas says so.
  const [readyWorld, setReadyWorld] = useState<typeof world>(null);
  useEffect(() => setWebgl(webglAvailable() ? 'ok' : 'unavailable'), []);
  const onReady = useCallback(() => setReadyWorld(world), [world]);
  // Without WebGL the Network view stands in for the world (same data, no 3D controls).
  const noWebgl = view === 'world' && allow3d && webgl === 'unavailable';
  const show3d = view === 'world' && allow3d && !noWebgl;
  // Characters walk only in the 3D world: the store lets a finished run settle only while one is shown.
  useEffect(() => (show3d ? store.getState().mountWorld() : undefined), [show3d, store]);

  let body: ReactNode;
  if (!world) {
    body = (
      <div className={styles.loading} role="status" aria-label="Loading the world">
        <Skeleton width="62%" height="58%" radius={18} />
      </div>
    );
  } else if (!show3d) {
    body = <GraphView notice={noWebgl ? 'WebGL is not available in this browser, so the agent network stands in for the 3D world. It shows the same agents, tasks and messages.' : undefined} />;
  } else if (webgl === 'ok') {
    body = (
      <SceneBoundary onFallback={() => setView('graph')}>
        <WorldCanvas
          key={world.def.id}
          world={world}
          getFrame={getFrame}
          subscribeEffects={subscribeEffects}
          selectedAgentId={embodiedSelected ? selectedAgentId : null}
          selectedStationId={selectedStationId}
          onSelectAgent={selectAgent}
          onSelectStation={selectStation}
          cameraMode={cameraMode}
          follow={follow}
          quality={quality}
          reducedMotion={reducedMotion}
          onReady={onReady}
          selectedSeq={selectedSeq}
          onSelectEvent={(seq, opts) => store.getState().selectEvent(seq, opts)}
          status={{ text: conn.text, live: conn.state === 'live', detail: conn.detail }}
        />
      </SceneBoundary>
    );
  }

  return (
    <section
      className={styles.stage}
      aria-label={show3d ? 'Live World, 3D view' : 'Live World, Network view'}
      data-view={show3d ? 'world' : 'graph'}
      data-world-ready={show3d && world && readyWorld === world ? 'true' : undefined}
    >
      <div className={styles.canvas}>{body}</div>
      {world && runId && (
        <>
          <div className={styles.toolbarLeft}>
            {allow3d && (
              <SegmentedControl
                glass={show3d}
                size="sm"
                label="World view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'world', label: 'World', icon: 'world' },
                  { value: 'graph', label: 'Network', icon: 'graph' },
                ]}
              />
            )}
          </div>
          {show3d && (
            <div className={styles.toolbar} role="toolbar" aria-label="Camera">
              <SegmentedControl
                glass
                size="sm"
                label="Camera"
                value={cameraMode}
                onChange={setCameraMode}
                options={[
                  { value: 'iso', label: '3D', title: 'Isometric camera' },
                  { value: 'top', label: '2D', title: 'Top-down camera' },
                ]}
              />
              <button type="button" className={styles.glassButton} aria-pressed={follow} onClick={toggleFollow} title="Keep the selected character centred (F)">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                  <path d="M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z" />
                </svg>
                Follow
              </button>
              <button
                type="button"
                className={styles.glassButton}
                aria-pressed={quality !== 'low'}
                onClick={() => setQuality(quality === 'low' ? 'auto' : 'low')}
                title="High quality adds glow; low is faster"
              >
                {quality === 'low' ? 'Low quality' : 'High quality'}
              </button>
            </div>
          )}
          {show3d && <CharacterRoster />}
        </>
      )}
    </section>
  );
}

/** If the scene throws, keep the rest of the Studio usable and offer the 2D route. */
class SceneBoundary extends Component<{ children: ReactNode; onFallback: () => void }, { error: string | null }> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: unknown) {
    console.error('[studio] 3D scene failed', err);
  }

  override render() {
    if (this.state.error) {
      return (
        <StageMessage title="The 3D world failed to render" tone="err">
          <p>{this.state.error}</p>
          <p>No data was lost: the timeline, logs and inspector still show everything recorded.</p>
          <div className={styles.messageActions}>
            <Button size="sm" icon="refresh" onClick={() => this.setState({ error: null })}>
              Reload the 3D view
            </Button>
            <Button size="sm" variant="ghost" onClick={this.props.onFallback}>
              Use the Network view
            </Button>
          </div>
        </StageMessage>
      );
    }
    return this.props.children;
  }
}
