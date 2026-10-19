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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { townLabelOf, useReturnFocus } from './bits';
import { hasCritical } from './notify';
import Sheets, { useSheetWidths } from './Sheets';
import styles from './hud.module.css';
import { uiSound } from './sound';
import { Bell, FindButton, useNotificationItems, WorldChip } from './TopBar';
import { stripBox, type Viewport } from './anchor';

/** An element's height (0 while it is empty or absent), kept current with a ResizeObserver. */
function useHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!el) return setH(0);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(Math.round(el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, h];
}

/**
 * Leaving the building from the strip (Leave, Esc) gives focus back to what
 * entered it, else the card's Enter button or the agent's label.
 */
function StripFocus({ agentId }: { agentId: string }) {
  const none = useRef<HTMLElement>(null);
  useReturnFocus(none, () => document.querySelector<HTMLElement>('[data-card-enter]') ?? townLabelOf({ kind: 'agent', id: agentId }));
  return null;
}

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
  const phone = layout.size === 'phone';
  const sheets = useSheetWidths(layout.vw);
  const critical = hasCritical(items);

  const [guideRef, guideH] = useHeight<HTMLDivElement>();
  const [stripRef, stripH] = useHeight<HTMLDivElement>();

  // The bottom-left corner the minimap (or, without it, the Directory button) holds.
  const corner = phone ? undefined : layout.minimap && stage === '3d' ? { w: 16 + layout.minimap.w + 8 + 8, h: 16 + layout.minimap.h + 42 } : { w: 16 + 140, h: 16 + 40 };
  const vp: Viewport = {
    w: layout.vw,
    h: layout.vh,
    right: sheets.right ? sheets.right + 16 : 0,
    left: sheets.left ? sheets.left + 16 : 0,
    top: layout.top,
    // The hotbar, and the session strip above it inside an agent's building.
    bottom: layout.hotbar.height + layout.hotbar.bottom + 8 + (enteredAgent ? 104 : 0),
    ...(corner ? { corner } : {}),
  };
  // The strip and the guide banner centre in the area the sheets leave free (not under a sheet).
  const strip = stripBox(vp);
  // Risen above the minimap (a wide sheet beside it): cards keep clear of it there too.
  if (enteredAgent && strip.bottom !== null && !phone) vp.bottom = Math.max(vp.bottom, strip.bottom + (stripH || 104) + 8);
  const freeMid = Math.round((vp.left + vp.w - vp.right) / 2);
  // Notifications start below the guide banner while it shows (they never cover "Inside … · Esc to leave").
  const notesTop = guideH > 0 ? Math.max(phone ? 68 : 96, (phone ? 68 : 76) + guideH + 10) : undefined;

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
          onLotChange={(id, reason) => store.getState().pickLot(id, reason ?? null)}
          onClose={() => store.getState().cancelLotPick()}
          onDone={(agentId) => store.getState().focusEntity({ kind: 'agent', id: agentId })}
          // Its first real event: the agent's own card takes over (the arrival shot already flies to its robot).
          onArrived={(agentId) => {
            store.getState().cancelLotPick();
            store.getState().focusEntity({ kind: 'agent', id: agentId }, { camera: false });
          }}
        />
      </CardFrame>
    );
  } else if (top && !lotPick) {
    card = <EntityCard key={`${top.kind}:${top.id}`} refId={top} vp={vp} width={layout.card} phone={phone} />;
  } else if (mode === 'agents' && !lotPick && overlay === 'none') {
    card = <DistrictCard vp={vp} width={layout.card.expanded} phone={phone} onAddToWorld={addToWorld} />;
  }

  return (
    <div
      className={styles.hud}
      data-size={layout.size}
      data-fade={fade || undefined}
      data-hidden={hidden || undefined}
      data-stage={stage ?? undefined}
      data-inside={enteredAgent ? '' : undefined}
      data-town-gestures=""
      style={{ ['--strip-h' as string]: `${enteredAgent ? stripH : 0}px` }}
    >
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

      <div
        className={styles.notesWrap}
        style={{
          width: layout.notifications,
          ...(notesTop !== undefined ? { top: notesTop } : {}),
          ['--notes-right' as string]: `${phone ? 12 : 16 + (sheets.right ? sheets.right + 16 : 0)}px`,
          // A card docked top-right (its entity is off-screen or under the HUD) pushes the notifications left of it.
          ['--docked-card' as string]: `${layout.card.expanded + 12}px`,
          ['--notes-w' as string]: `${layout.notifications}px`,
        }}
      >
        <Notifications onOpen={openItem} single={phone} />
      </div>

      <div ref={guideRef} className={styles.guideWrap} style={phone ? undefined : { left: freeMid, maxWidth: Math.max(240, layout.vw - vp.left - vp.right - 32) }}>
        <GuideBanner />
      </div>

      {card && (
        <div className={styles.cardLayer} style={{ ['--card-w' as string]: `${layout.card.compact}px` }}>
          {card}
        </div>
      )}

      {enteredAgent && (
        <div ref={stripRef} className={styles.stripWrap} style={phone ? undefined : { left: strip.x, width: strip.w, ...(strip.bottom !== null ? { bottom: strip.bottom } : {}) }}>
          <StripFocus agentId={enteredAgent} />
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

      <ControlsHint touch={phone} />
      <HiddenHint hidden={hidden} />
      {hidden && critical && (
        <button type="button" className={styles.criticalDot} aria-label="Something needs you: show the HUD" onClick={() => store.getState().setHudHidden(false)}>
          <Icon name="alert" size={16} />
        </button>
      )}
    </div>
  );
}
