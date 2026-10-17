'use client';
import dynamic from 'next/dynamic';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { START_RUNTIME_COMMAND } from '../lib/config';
import { useStudio } from '../state/context';
import CharacterRoster from './CharacterRoster';
import styles from './WorldView.module.css';

const WorldCanvas = dynamic(() => import('../scene/WorldCanvas'), {
  ssr: false,
  loading: () => <p className={styles.message}>Loading the 3D world…</p>,
});

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** The 3D world plus its DOM overlays (view toggles, character roster, fallbacks). */
export default function WorldView() {
  const world = useStudio((s) => s.world);
  const runId = useStudio((s) => s.runId);
  const loadError = useStudio((s) => s.loadError);
  const runtimeStatus = useStudio((s) => s.runtime.status);
  const getFrame = useStudio((s) => s.getFrame);
  const subscribeEffects = useStudio((s) => s.subscribeEffects);
  const selectedAgentId = useStudio((s) => s.selectedAgentId);
  const selectedStationId = useStudio((s) => s.selectedStationId);
  const selectAgent = useStudio((s) => s.selectAgent);
  const selectStation = useStudio((s) => s.selectStation);
  const cameraMode = useStudio((s) => s.cameraMode);
  const setCameraMode = useStudio((s) => s.setCameraMode);
  const follow = useStudio((s) => s.follow);
  const toggleFollow = useStudio((s) => s.toggleFollow);
  const quality = useStudio((s) => s.quality);
  const setQuality = useStudio((s) => s.setQuality);
  const reducedMotion = useStudio((s) => s.reducedMotion);

  const [webgl, setWebgl] = useState<'checking' | 'ok' | 'unavailable'>('checking');
  // The world whose canvas has rendered: a new run's world is not ready until its own canvas says so.
  const [readyWorld, setReadyWorld] = useState<typeof world>(null);
  useEffect(() => setWebgl(webglAvailable() ? 'ok' : 'unavailable'), []);
  const onReady = useCallback(() => setReadyWorld(world), [world]);

  let body: ReactNode;
  if (loadError) {
    body = (
      <div className={styles.message} role="alert">
        <p>
          <span aria-hidden="true">✗</span> Could not load this run: {loadError}
        </p>
        {runtimeStatus === 'offline' && (
          <p>
            Start the local runtime with <code>{START_RUNTIME_COMMAND}</code>; the Studio reconnects automatically.
          </p>
        )}
      </div>
    );
  } else if (!runId) {
    body = (
      <div className={styles.message}>
        {runtimeStatus === 'offline' ? (
          <p>
            The local runtime is offline. Start it with <code>{START_RUNTIME_COMMAND}</code>, then press{' '}
            <strong>Run demo mission</strong>.
          </p>
        ) : (
          <p>
            No run yet. Press <strong>Run demo mission</strong> to watch agents work.
          </p>
        )}
      </div>
    );
  } else if (!world) {
    body = <p className={styles.message}>Loading run…</p>;
  } else if (webgl === 'unavailable') {
    body = (
      <div className={styles.message} role="status">
        <p>
          <span aria-hidden="true">⚠</span> WebGL is not available in this browser, so the 3D world cannot be shown.
        </p>
        <p>The Timeline, Logs and State tabs still show everything that happened.</p>
      </div>
    );
  } else if (webgl === 'ok') {
    body = (
      <SceneBoundary>
        <WorldCanvas
          key={world.def.id}
          world={world}
          getFrame={getFrame}
          subscribeEffects={subscribeEffects}
          selectedAgentId={selectedAgentId}
          selectedStationId={selectedStationId}
          onSelectAgent={selectAgent}
          onSelectStation={selectStation}
          cameraMode={cameraMode}
          follow={follow}
          quality={quality}
          reducedMotion={reducedMotion}
          onReady={onReady}
        />
      </SceneBoundary>
    );
  }

  return (
    <section className={styles.view} aria-label="World view" data-world-ready={world && readyWorld === world ? 'true' : undefined}>
      <div className={styles.canvas}>{body}</div>

      {world && (
        <>
          <div className={styles.toolbar} role="toolbar" aria-label="View options">
            <div className={styles.segmented} role="group" aria-label="Camera">
              <button type="button" className="btn" aria-pressed={cameraMode === 'iso'} onClick={() => setCameraMode('iso')}>
                3D
              </button>
              <button type="button" className="btn" aria-pressed={cameraMode === 'top'} onClick={() => setCameraMode('top')}>
                2D
              </button>
            </div>
            <button
              type="button"
              className="btn"
              aria-pressed={follow}
              onClick={toggleFollow}
              title="Keep the selected character centred (F)"
            >
              <span aria-hidden="true">◎</span> Follow
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={quality === 'high'}
              onClick={() => setQuality(quality === 'high' ? 'low' : 'high')}
              title="High quality adds glow effects"
            >
              <span aria-hidden="true">✦</span> {quality === 'high' ? 'High quality' : 'Low quality'}
            </button>
          </div>
          <CharacterRoster />
        </>
      )}
    </section>
  );
}

/** If the scene throws, keep the rest of the Studio usable. */
class SceneBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
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
        <div className={styles.message} role="alert">
          <p>
            <span aria-hidden="true">⚠</span> The 3D world failed to render: {this.state.error}
          </p>
          <p>The Timeline, Logs and State tabs still show everything that happened.</p>
          <p>
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Reload 3D view
            </button>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
