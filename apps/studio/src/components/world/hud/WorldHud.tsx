'use client';
/**
 * The game HUD over the town (immersive contract §1): world chip, Find and
 * the bell top-left; clock and speed top-right with notifications under it;
 * the minimap bottom-left; the hotbar bottom-centre; entity cards anchored in
 * the world; the guide banner; sheets; the Esc menu. Glass for floating
 * controls only; cards, sheets and the menu are opaque.
 *
 * Getting out of the way (§1.3): while the viewer drags the view the HUD
 * fades to 0.3 (not cards, the banner, critical notifications or a sheet); H
 * hides it (a needs-you dot stays). Reduced motion: no fades, instant.
 */
import type { EntityRef } from '@runloop-world/events';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useStudioStore } from '../../../state/context';
import type { AttentionItem } from '../../../world/attention';
import { useWorld, useWorldStore } from '../../../world/context';
import { focusOf } from '../../../world/store';
import type { Mode } from '../../../world/link';
import { Icon } from '../../../ui/Icon';
import AddToWorldFlow from '../../agents/AddToWorldFlow';
import { SessionStrip, useStudioNav } from '../../overlays';
import { CardFrame, DistrictCard, EntityCard } from './EntityCard';
import ClockWidget from './ClockWidget';
import { useHudLayout, useTownApi } from './context';
import GameMenu from './GameMenu';
import { ControlsHint, GuideBanner, HiddenHint } from './Guide';
import Hotbar from './Hotbar';
import Minimap from './Minimap';
import Notifications from './Notifications';
import { hasCritical } from './notify';
import Sheets, { useSheetWidths } from './Sheets';
import styles from './hud.module.css';
import { uiSound } from './sound';
import { Bell, FindButton, useNotificationItems, WorldChip } from './TopBar';
import type { Viewport } from './anchor';

/** Fade after 120 ms of dragging; come back 400 ms after it ends. */
function useDragFade(interacting: boolean): boolean {
  const [fade, setFade] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFade(interacting), interacting ? 120 : 400);
    return () => clearTimeout(t);
  }, [interacting]);
  return fade;
}

export default function WorldHud({
  onOpenPalette,
  sound,
  soundSettings,
  menuExtras,
}: {
  onOpenPalette: () => void;
  /** The speaker toggle (SOUND). */
  sound?: ReactNode;
  /** The Esc menu's Sound tab (SOUND). */
  soundSettings?: ReactNode;
  menuExtras?: { connections?: ReactNode; runtime?: ReactNode };
}) {
  const store = useWorldStore();
  const layout = useHudLayout();
  const api = useTownApi();
  const mode = useWorld((s) => s.mode);
  const overlay = useWorld((s) => s.overlay);
  const menu = useWorld((s) => s.menu);
  const hidden = useWorld((s) => s.hud.hidden);
  const interacting = useWorld((s) => s.hud.interacting);
  const top = useWorld((s) => focusOf(s));
  const lotPick = useWorld((s) => s.lotPick);
  const stage = useWorld((s) => s.stage);
  const reduced = useWorld((s) => s.reducedMotion);
  const items = useNotificationItems();
  const studio = useStudioStore();
  const nav = useStudioNav();
  const enteredAgent = useWorld((s) => (s.entered ? (s.snapshot?.agents.find((a) => a.buildingId === s.entered)?.agentId ?? null) : null));
  const fade = useDragFade(interacting) && !reduced;
  const bellOpen = useWorld((s) => s.bellOpen);
  const setBellOpen = useCallback((v: boolean) => store.getState().setBellOpen(v), [store]);
  const [lotReason, setLotReason] = useState<string | null>(null);
  const phone = layout.size === 'phone';
  const sheets = useSheetWidths(layout.vw);
  const critical = hasCritical(items);

  useEffect(() => {
    if (!lotPick) setLotReason(null);
  }, [lotPick]);

  const vp: Viewport = {
    w: layout.vw,
    h: layout.vh,
    right: sheets.right ? sheets.right + 16 : 0,
    left: sheets.left ? sheets.left + 16 : 0,
    top: layout.top,
    // The hotbar, and the session strip above it inside an agent's building.
    bottom: layout.hotbar.height + layout.hotbar.bottom + 8 + (enteredAgent ? 104 : 0),
  };

  const openItem = (item: AttentionItem) => {
    const s = store.getState();
    const ref: EntityRef | undefined = item.refs[0];
    if (item.kind === 'arrival') s.setMode('agents');
    else if (ref) s.focusEntity(ref);
    else if (item.events) s.showInLog({ seq: item.events.last });
  };
  const onMode = (m: Mode) => {
    const s = store.getState();
    if (s.overlay === 'add') s.cancelLotPick();
    s.setMode(m);
  };
  const addToWorld = (fromSessionId?: string) => store.getState().openAddToWorld(fromSessionId ?? null);

  // The card the town shows: the lot being added, the selected entity, or the Agent District.
  let card: ReactNode = null;
  if (lotPick?.selected) {
    card = (
      <CardFrame anchor={{ kind: 'lot', id: lotPick.selected }} vp={vp} title="Add to World" kind="Add to World" width={layout.card.expanded} phone={phone} expanded onClose={() => store.getState().cancelLotPick()}>
        <AddToWorldFlow
          key={lotPick.selected}
          layout="anchored"
          lotId={lotPick.selected}
          fromSessionId={lotPick.fromSessionId}
          onLotChange={(id, reason) => {
            setLotReason(reason ?? null);
            store.getState().pickLot(id);
          }}
          onClose={() => store.getState().cancelLotPick()}
          onDone={(agentId) => store.getState().focusEntity({ kind: 'agent', id: agentId })}
        />
      </CardFrame>
    );
  } else if (top && !lotPick) {
    card = <EntityCard key={`${top.kind}:${top.id}`} refId={top} vp={vp} width={layout.card} phone={phone} />;
  } else if (mode === 'agents' && !lotPick && overlay === 'none') {
    card = <DistrictCard vp={vp} width={layout.card.expanded} phone={phone} onAddToWorld={addToWorld} />;
  }

  return (
    <div className={styles.hud} data-size={layout.size} data-fade={fade || undefined} data-hidden={hidden || undefined} data-stage={stage ?? undefined}>
      {phone ? (
        <div className={styles.topPhone}>
          <ClockWidget size="phone" sound={sound} onFind={onOpenPalette} />
          <Bell onOpen={openItem} compact open={bellOpen} setOpen={setBellOpen} />
        </div>
      ) : (
        <>
          <div className={styles.topLeft}>
            <WorldChip compact={layout.size === 's'} />
            <FindButton onOpen={onOpenPalette} compact={layout.size === 's'} />
            <Bell onOpen={openItem} open={bellOpen} setOpen={setBellOpen} />
          </div>
          <div className={styles.topRight}>
            <ClockWidget size={layout.size} sound={sound} />
          </div>
        </>
      )}

      <div className={styles.notesWrap} style={{ width: layout.notifications, right: phone ? 12 : 16 + (sheets.right ? sheets.right + 16 : 0) }}>
        <Notifications onOpen={openItem} single={phone} />
      </div>

      <div className={styles.guideWrap}>
        <GuideBanner reason={lotReason} />
      </div>

      {card && (
        <div className={styles.cardLayer} style={{ ['--card-w' as string]: `${layout.card.compact}px` }}>
          {card}
        </div>
      )}

      {enteredAgent && (
        <div className={styles.stripWrap}>
          <SessionStrip
            agentId={enteredAgent}
            onOpenTrace={(seq) => {
              const runId = studio.getState().runId;
              if (runId) nav.openTrace(runId, { seq });
            }}
            onLeave={() => store.getState().enter(null)}
          />
        </div>
      )}

      {layout.minimap && stage === '3d' && (
        <div className={styles.minimapWrap}>
          <Minimap
            api={api}
            w={layout.minimap.w}
            h={layout.minimap.h}
            mapOpen={overlay === 'map'}
            listOpen={overlay === 'list'}
            onOpenMap={() => {
              uiSound('open');
              store.getState().setOverlay(overlay === 'map' ? 'none' : 'map');
            }}
            onOpenList={() => {
              uiSound('open');
              store.getState().setOverlay(overlay === 'list' ? 'none' : 'list');
            }}
          />
        </div>
      )}
      {(!layout.minimap || stage !== '3d') && !phone && (
        <div className={styles.minimapWrap}>
          <div className={styles.viewToggles} data-hud-fade>
            <button type="button" className={styles.miniBtn} aria-pressed={overlay === 'list'} aria-keyshortcuts="L" onClick={() => store.getState().setOverlay(overlay === 'list' ? 'none' : 'list')}>
              <Icon name="table" size={13} />
              Directory
            </button>
          </div>
        </div>
      )}

      <div className={styles.hotbarWrap}>
        <Hotbar
          mode={mode}
          adding={overlay === 'add'}
          menuOpen={menu !== null}
          compact={phone || layout.size === 's'}
          onMode={onMode}
          onAdd={() => (overlay === 'add' ? store.getState().cancelLotPick() : addToWorld())}
          onMenu={() => store.getState().setMenu(menu ? null : 'resume')}
        />
      </div>

      <Sheets phone={phone} layout={layout} />

      <GameMenu
        tab={menu}
        onTab={(t) => store.getState().setMenu(t)}
        onClose={() => {
          uiSound('close');
          store.getState().setMenu(null);
        }}
        sound={soundSettings}
        {...(menuExtras?.connections ? { connections: menuExtras.connections } : {})}
        {...(menuExtras?.runtime ? { runtimeExtra: menuExtras.runtime } : {})}
      />

      <ControlsHint />
      <HiddenHint hidden={hidden} />
      {hidden && critical && (
        <button type="button" className={styles.criticalDot} aria-label="Something needs you: show the HUD" onClick={() => store.getState().setHudHidden(false)}>
          <Icon name="alert" size={16} />
        </button>
      )}
    </div>
  );
}
