'use client';
import type { EntityRef, WorldSpeed } from '@runloop-world/events';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { Command } from '../../state/commands';
import { useWorld, useWorldStore } from '../../world/context';
import { buildEntityIndex } from '../../world/entityIndex';
import { MODE_LABEL, MODES, worldHref } from '../../world/link';
import { sendWorldCommand } from '../../world/send';

/**
 * ⌘K entries for the town (UX §7): every resident, building, place, district
 * and agent (search only, so an empty palette is not flooded), the modes,
 * and the world clock. Choosing an entity is the same as clicking it.
 */
export function useWorldCommands(pathname: string): Command[] {
  const router = useRouter();
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  const agents = useWorld((s) => s.agents);
  const mode = useWorld((s) => s.mode);
  const speed = useWorld((s) => s.snapshot?.speed ?? null);
  const prevSpeed = useWorld((s) => s.snapshot?.prevSpeed ?? 1);
  // Rebuild the entity list when the roster or agents change, not on every movement.
  const agentCount = useWorld((s) => s.snapshot?.agents.length ?? 0);
  const residentCount = useWorld((s) => s.snapshot?.residents.length ?? 0);

  return useMemo(() => {
    const onTown = (pathname.replace(/\/+$/, '') || '/') === '/';
    const s = () => store.getState();
    const focus = (ref: EntityRef) => {
      if (onTown) s().focusEntity(ref);
      else router.push(worldHref({ focus: ref }));
    };
    const cmds: Command[] = [
      { id: 'nav:/', group: 'Go to', label: 'Town', keywords: 'world home map residents explore', hint: onTown ? 'current' : undefined, run: () => router.push('/') },
    ];
    for (const m of MODES) {
      cmds.push({
        id: `mode:${m}`,
        group: 'World',
        label: `Mode: ${MODE_LABEL[m]}`,
        keywords: m === 'lab' ? 'experiments compare' : m === 'intelligence' ? 'world log events traces' : m === 'agents' ? 'agent district arrivals claim' : 'town',
        hint: onTown && mode === m ? 'current' : undefined,
        run: () => (m === 'lab' ? router.push('/experiments') : onTown ? s().setMode(m) : router.push(worldHref({ mode: m }))),
      });
    }
    cmds.push({
      id: 'add-to-world',
      group: 'World',
      label: 'Add to World',
      keywords: 'agent claude code connect building lot new',
      run: () => s().openAddToWorld(),
    });
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
      group: 'World',
      label: 'Show the whole town',
      keywords: 'camera zoom out map overview',
      run: () => (onTown ? s().requestCamera('overview', null) : router.push('/')),
    });
    cmds.push({
      id: 'world-log',
      group: 'World',
      label: 'Open the World Log',
      keywords: 'events intelligence history provenance',
      run: () => (onTown ? s().showInLog({}) : router.push(worldHref({ mode: 'intelligence' }))),
    });
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
  }, [router, store, pathname, town, agents, mode, speed, prevSpeed, agentCount, residentCount, snapshot?.worldId]);
}
