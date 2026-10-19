'use client';
import type { EntityRef, WorldSpeed } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { Command } from '../../state/commands';
import { ROUTES } from '../../state/deeplink';
import { useWorld, useWorldStore } from '../../world/context';
import { buildEntityIndex } from '../../world/entityIndex';
import { DEFAULT_AZ, DEFAULT_TILT, MODE_LABEL, MODES, worldHref } from '../../world/link';
import { sendWorldCommand } from '../../world/send';
import type { MenuTab, Overlay } from '../../world/store';

const SHEETS: { overlay: Overlay; label: string; keywords: string }[] = [
  { overlay: 'log', label: 'Open the World Log', keywords: 'events intelligence history provenance library' },
  { overlay: 'sessions', label: 'Sessions', keywords: 'overview runs recent live health demo quick start' },
  { overlay: 'compare', label: 'Compare sessions', keywords: 'experiments lab baseline diff' },
  { overlay: 'connect', label: 'Connect Claude Code', keywords: 'integrations plugin install ingest tracer' },
  { overlay: 'list', label: 'Directory of the town', keywords: 'list tree people places entities accessible' },
  { overlay: 'map', label: '2D map', keywords: 'map plan overview' },
];

const MENU: { tab: MenuTab; label: string; keywords: string }[] = [
  { tab: 'display', label: 'Settings: display', keywords: 'theme dark light quality motion reduced 2d map view' },
  { tab: 'sound', label: 'Settings: sound', keywords: 'audio volume mute ambient' },
  { tab: 'controls', label: 'Keyboard map and controls', keywords: 'shortcuts keys mouse touch help legend' },
  { tab: 'runtime', label: 'Settings: runtime', keywords: 'url privacy retention data' },
  { tab: 'pages', label: 'All pages', keywords: 'traces experiments overview integrations settings live world' },
];

/**
 * ⌘K entries for the town (UX §7, immersive contract §4.1): every resident,
 * building, place, district and agent (search only, so an empty palette is not
 * flooded), the modes, the sheets, Add to World, the Esc menu's tabs, the
 * notifications, the camera and the world clock. Choosing an entity is the
 * same as clicking it, with its card's details open.
 */
export function useWorldCommands(pathname: string): Command[] {
  const router = useRouter();
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  const agents = useWorld((s) => s.agents);
  const mode = useWorld((s) => s.mode);
  const overlay = useWorld((s) => s.overlay);
  const speed = useWorld((s) => s.snapshot?.speed ?? null);
  const prevSpeed = useWorld((s) => s.snapshot?.prevSpeed ?? 1);
  // Rebuild the entity list when the roster or agents change, not on every movement.
  const agentCount = useWorld((s) => s.snapshot?.agents.length ?? 0);
  const residentCount = useWorld((s) => s.snapshot?.residents.length ?? 0);

  return useMemo(() => {
    const onTown = (pathname.replace(/\/+$/, '') || '/') === '/';
    const s = () => store.getState();
    const focus = (ref: EntityRef) => {
      if (!onTown) return router.push(worldHref({ focus: ref }));
      s().focusEntity(ref, { expand: true });
      // Like a click in the town: residents and robots are followed (their card stays put on screen).
      if (ref.kind === 'resident' || ref.kind === 'agent') s().setFollow(ref);
    };
    const cmds: Command[] = [
      { id: 'nav:/', group: 'Go to', label: 'Town', keywords: 'world home map residents explore', hint: onTown ? 'current' : undefined, run: () => router.push('/') },
    ];
    for (const m of MODES) {
      cmds.push({
        id: `mode:${m}`,
        group: 'World',
        label: `Mode: ${MODE_LABEL[m]}`,
        keywords: m === 'lab' ? 'experiments compare lattice lab' : m === 'intelligence' ? 'world log events traces library' : m === 'agents' ? 'agent district arrivals claim' : 'town',
        hint: onTown && mode === m ? 'current' : undefined,
        run: () => (onTown ? s().setMode(m) : router.push(worldHref({ mode: m }))),
      });
    }
    cmds.push({
      id: 'add-to-world',
      group: 'World',
      label: 'Add to World',
      keywords: 'agent claude code connect building lot new',
      shortcut: onTown ? ['N'] : undefined,
      run: () => s().openAddToWorld(),
    });
    for (const sh of SHEETS) {
      cmds.push({
        id: `sheet:${sh.overlay}`,
        group: 'World',
        label: sh.label,
        keywords: sh.keywords,
        hint: onTown && overlay === sh.overlay ? 'open' : undefined,
        run: () => (onTown ? s().setOverlay(sh.overlay) : router.push(`/?overlay=${sh.overlay}`)),
      });
    }
    for (const t of MENU) {
      cmds.push({ id: `menu:${t.tab}`, group: 'Settings', label: t.label, keywords: t.keywords, run: () => (onTown ? s().setMenu(t.tab) : router.push(ROUTES.settings)) });
    }
    if (onTown) {
      cmds.push({ id: 'notifications', group: 'World', label: 'Notifications', keywords: 'bell attention needs you alerts feed', run: () => s().setBellOpen(true) });
      cmds.push({ id: 'hud-toggle', group: 'World', label: 'Hide or show the HUD', keywords: 'interface chrome screenshot', shortcut: ['H'], run: () => s().setHudHidden(!s().hud.hidden) });
    }
    if (speed !== null) {
      const setSpeed = (v: WorldSpeed, label: string) => void sendWorldCommand(store, { type: 'clock.set', speed: v }, label);
      cmds.push(
        speed === 0
          ? { id: 'world-resume', group: 'World', label: `Resume the world at ${prevSpeed}×`, keywords: 'play clock time unpause', shortcut: onTown ? ['Space'] : undefined, run: () => setSpeed(prevSpeed, `Resuming at ${prevSpeed}×…`) }
          : { id: 'world-pause', group: 'World', label: 'Pause the world', keywords: 'stop clock time freeze', shortcut: onTown ? ['Space'] : undefined, run: () => setSpeed(0, 'Pausing…') },
      );
      for (const v of [1, 4, 16] as const) {
        cmds.push({ id: `world-speed:${v}`, group: 'World', label: `World speed ${v}×`, keywords: 'clock time fast faster', hint: speed === v ? 'current' : undefined, run: () => setSpeed(v, `Setting ${v}×…`) });
      }
    }
    cmds.push({
      id: 'world-overview',
      group: 'Camera',
      label: 'Show the whole town',
      keywords: 'camera zoom out map overview',
      shortcut: onTown ? ['0'] : undefined,
      run: () => (onTown ? s().requestCamera('overview', null) : router.push('/')),
    });
    if (onTown) {
      cmds.push({
        id: 'camera-reset',
        group: 'Camera',
        label: 'Reset the view direction',
        keywords: 'camera north rotate tilt default',
        shortcut: ['R'],
        run: () => {
          const c = s().cam;
          if (c) s().requestCamera('cam', null, 'quick', { cam: { x: c.x, z: c.z, zoom: c.zoom, az: DEFAULT_AZ, tilt: DEFAULT_TILT } });
          else s().requestCamera('overview', null);
        },
      });
    }
    for (const e of buildEntityIndex(snapshot, town, agents)) {
      cmds.push({
        id: `entity:${e.ref.kind}:${e.ref.id}`,
        group: 'Town',
        label: e.name,
        keywords: `${e.detail} ${e.keywords}`,
        hint: e.kind,
        searchOnly: true,
        run: () => focus(e.ref),
      });
    }
    return cmds;
    // The entity list follows the roster and agents (counts); details are as of the last rebuild.
  }, [router, store, pathname, town, agents, mode, overlay, speed, prevSpeed, agentCount, residentCount, snapshot?.worldId]);
}
