'use client';
/**
 * Floating entity cards (contract §1.4): anchored beside the selected
 * resident's head or building's screen box, moved every frame by `transform` (no
 * React render), flipped near the edge, docked top-right with an edge chip
 * when the anchor is off-screen. Compact by default; Details ▸ expands the
 * full panel in place. Phones get a bottom sheet above the hotbar instead.
 *
 * Provenance stays on every card: residents "Simulated", agents "Real ·
 * Claude Code · observed", health as icon + text, never colour alone.
 */
import type { EntityRef } from '@runloop-world/events';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStudioStore } from '../../../state/context';
import { selectRun, useTicker } from '../../../state/hooks';
import type { TownApi } from '../../../town/types';
import { useWorld, useWorldStore, useWorldTick } from '../../../world/context';
import { entityName, residentDistrict } from '../../../world/entityIndex';
import { agentView, buildingView, residentView } from '../../../world/selectors';
import { Button } from '../../../ui/Button';
import { Chip } from '../../../ui/Chip';
import { Icon } from '../../../ui/Icon';
import AgentsPanel from '../../agents/AgentsPanel';
import AssignTaskDialog from '../../agents/AssignTask';
import AgentPanel from '../../panels/AgentPanel';
import BuildingPanel from '../../panels/BuildingPanel';
import ExplanationBlock from '../../panels/ExplanationBlock';
import PlacePanel from '../../panels/PlacePanel';
import ResidentPanel from '../../panels/ResidentPanel';
import { placeCard, type Side, type Viewport } from './anchor';
import { floatingRects } from './occlusion';
import { useTownApi } from './context';
import styles from './hud.module.css';
import { useStudioNav } from '../../overlays/nav';
import { townLabelOf, useReturnFocus } from './bits';
import { uiSound } from './sound';

const KIND_LABEL: Record<EntityRef['kind'], string> = {
  resident: 'Resident',
  building: 'Building',
  agent: 'Agent',
  district: 'District',
  lot: 'Lot',
  spot: 'Place',
};

/** The full panel for one entity. A housed agent's building opens its agent panel. */
export function EntityPanel({ refId }: { refId: EntityRef }) {
  const agentOfBuilding = useWorld((s) => (refId.kind === 'building' ? (s.snapshot?.agents.find((a) => a.buildingId === refId.id)?.agentId ?? null) : null));
  switch (refId.kind) {
    case 'resident':
      return <ResidentPanel key={refId.id} id={refId.id} />;
    case 'agent':
      return <AgentPanel key={refId.id} id={refId.id} />;
    case 'building':
      return agentOfBuilding ? <AgentPanel key={agentOfBuilding} id={agentOfBuilding} /> : <BuildingPanel key={refId.id} id={refId.id} />;
    default:
      return <PlacePanel key={`${refId.kind}:${refId.id}`} refId={refId} />;
  }
}

/**
 * Keeps `el` next to the anchor of `ref` every frame (contract §1.4). Without
 * the 3D town (or no anchor) the card docks top-right.
 */
export function useAnchor(el: React.RefObject<HTMLElement | null>, ref: EntityRef | null, vp: Viewport, api: TownApi | null) {
  const side = useRef<Side>('right');
  const vpRef = useRef(vp);
  vpRef.current = vp;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let lastDocked: boolean | null = null;
    let lastSide: Side | null = null;
    let lastSize = '';
    const place = () => {
      const box = { w: node.offsetWidth, h: node.offsetHeight };
      const size = `${box.w}x${box.h}`;
      // Hold still while the viewer points at or types in the card (it follows again after); a new size always re-places it.
      if (lastDocked !== null && size === lastSize && (node.matches(':hover') || node.contains(document.activeElement))) return;
      lastSize = size;
      // Beside the entity's whole screen box (a building, an interior, a lot), not on its roof.
      const p = placeCard(ref && api ? api.projectEntity(ref) : null, box, vpRef.current, side.current, ref && api ? api.projectBounds(ref) : null);
      side.current = p.side;
      node.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      floatingRects.card = { l: p.x, t: p.y, r: p.x + box.w, b: p.y + box.h };
      node.style.setProperty('--tail-y', `${p.tailY}px`);
      if (p.docked !== lastDocked) {
        lastDocked = p.docked;
        if (p.docked) node.setAttribute('data-docked', '');
        else node.removeAttribute('data-docked');
        // Docked because the anchor left the view (not because there is no 3D town): say where it went.
        if (p.docked && api && ref) node.setAttribute('data-offscreen', '');
        else node.removeAttribute('data-offscreen');
      }
      if (p.side !== lastSide) {
        lastSide = p.side;
        node.setAttribute('data-side', p.side);
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(node);
    const off = api ? api.onFrame(place) : () => undefined;
    return () => {
      off();
      ro.disconnect();
      floatingRects.card = null;
    };
  }, [el, ref?.kind, ref?.id, api]);
}

/** The card's frame: header (Back, kind, docked chip, close), body, Details ▸. */
export function CardFrame({
  anchor,
  vp,
  title,
  kind,
  width,
  phone,
  onClose,
  onBack,
  backLabel,
  expanded,
  onExpand,
  children,
  labelledBy,
}: {
  anchor: EntityRef | null;
  vp: Viewport;
  title: string;
  kind: string;
  width: number;
  phone: boolean;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  expanded?: boolean;
  onExpand?: (v: boolean) => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const api = useTownApi();
  const el = useRef<HTMLElement>(null);
  useAnchor(el, phone ? null : anchor, vp, phone ? null : api);
  // Closing it (×, Esc) gives focus back to what opened it, or to its entity's label.
  useReturnFocus(el, () => (anchor ? townLabelOf(anchor) : null));
  return (
    <section
      ref={el}
      className={styles.card}
      data-phone={phone || undefined}
      data-expanded={expanded || undefined}
      style={phone ? undefined : { width, maxHeight: expanded ? vp.h - 176 : Math.min(420, vp.h - 184) }}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : title}
      data-keys="own"
    >
      <span className={styles.cardTail} aria-hidden="true" />
      <header className={styles.cardHead}>
        {onBack ? (
          <button type="button" className={styles.cardBack} onClick={onBack} aria-label={`Back to ${backLabel}`}>
            <Icon name="arrowRight" size={13} className={styles.flip} />
            <span>{backLabel}</span>
          </button>
        ) : (
          <span className={styles.cardKind}>{kind}</span>
        )}
        <span className={styles.edgeChip} aria-hidden="true">
          <Icon name="arrowUp" size={11} className={styles.diag} />
          <span className={styles.edgeChipText}>{title}</span>
        </span>
        <span className={styles.cardHeadEnd}>
          {onExpand && (
            <button type="button" className={styles.cardMore} aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
              {expanded ? 'Less' : 'Details'}
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
            </button>
          )}
          <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Close the card" title="Close (Esc)" onClick={onClose} />
        </span>
      </header>
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

/** The selected entity's card (top of the panel stack). */
export function EntityCard({ refId, vp, width, phone }: { refId: EntityRef; vp: Viewport; width: { compact: number; expanded: number }; phone: boolean }) {
  const store = useWorldStore();
  const expanded = useWorld((s) => s.cardExpanded);
  const stack = useWorld((s) => s.panelStack);
  const snapshot = useWorld((s) => s.snapshot);
  const town = useWorld((s) => s.town);
  const agents = useWorld((s) => s.agents);
  const prev = stack.length > 1 ? stack[stack.length - 2]! : null;
  const name = entityName(refId, snapshot, town, agents);
  const agentOfBuilding = refId.kind === 'building' ? (snapshot?.agents.find((a) => a.buildingId === refId.id)?.agentId ?? null) : null;
  const kind = refId.kind === 'agent' || agentOfBuilding ? 'Agent headquarters' : KIND_LABEL[refId.kind];
  const titleId = `card-${refId.kind}-${refId.id}`;
  return (
    <CardFrame
      anchor={refId}
      vp={vp}
      title={name}
      kind={kind}
      width={expanded ? width.expanded : width.compact}
      phone={phone}
      expanded={expanded}
      onExpand={(v) => {
        uiSound(v ? 'open' : 'close');
        store.getState().setCardExpanded(v);
      }}
      onClose={() => {
        uiSound('close');
        store.getState().closePanels();
      }}
      {...(prev ? { onBack: () => store.getState().back(), backLabel: entityName(prev, snapshot, town, agents) } : {})}
      labelledBy={expanded ? undefined : titleId}
    >
      {expanded ? (
        <div className={styles.cardPanel}>
          <EntityPanel refId={refId} />
        </div>
      ) : refId.kind === 'resident' ? (
        <ResidentCompact id={refId.id} titleId={titleId} />
      ) : refId.kind === 'agent' || agentOfBuilding ? (
        <AgentCompact id={refId.kind === 'agent' ? refId.id : agentOfBuilding!} titleId={titleId} />
      ) : refId.kind === 'building' ? (
        <BuildingCompact id={refId.id} titleId={titleId} />
      ) : (
        <PlaceCompact refId={refId} name={name} titleId={titleId} />
      )}
    </CardFrame>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

function ResidentCompact({ id, titleId }: { id: string; titleId: string }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const seed = useWorld((s) => s.info?.seed ?? 0);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const follow = useWorld((s) => s.follow);
  const tick = useWorldTick(1);
  const [why, setWhy] = useState(false);
  const r = snapshot?.residents.find((x) => x.id === id) ?? null;
  if (!r || !snapshot || !town) return <p className={styles.cardNote}>This resident is not in the current world.</p>;
  const v = residentView(snapshot, town, seed, r, tick);
  const following = follow?.kind === 'resident' && follow.id === id;
  return (
    <>
      <div className={styles.cardTitleRow}>
        <span className={styles.avatar} style={{ background: r.outfit.top }} aria-hidden="true">
          {initials(r.name)}
        </span>
        <div className={styles.cardTitles}>
          <h2 id={titleId} className={styles.cardTitle}>
            {v.name}
          </h2>
          <p className={styles.cardSub}>{v.role}</p>
        </div>
        <Chip icon={v.chip.icon} title={v.chip.detail}>
          {v.chip.label}
        </Chip>
      </div>
      <p className={styles.nowLine}>
        {v.now}
        <span className={styles.cardNote}> · {v.since}</span>
      </p>
      <div className={styles.cardActions}>
        <Button
          size="sm"
          variant={following ? 'secondary' : 'ghost'}
          icon="target"
          aria-pressed={following}
          aria-keyshortcuts="F"
          onClick={() => {
            uiSound('toggle');
            store.getState().setFollow(following ? null : { kind: 'resident', id });
          }}
        >
          {following ? 'Following' : 'Follow'}
        </Button>
        <Button size="sm" variant={why ? 'secondary' : 'ghost'} icon="sparkle" aria-expanded={why} onClick={() => setWhy(!why)}>
          Why
        </Button>
        <Button size="sm" variant="ghost" icon="traces" onClick={() => store.getState().showInLog({ actor: id })}>
          Events
        </Button>
      </div>
      {why && (
        <div className={styles.cardWhy}>
          <ExplanationBlock residentId={id} atSeq={v.lastDecisionSeq} />
        </div>
      )}
    </>
  );
}

function AgentCompact({ id, titleId }: { id: string; titleId: string }) {
  const store = useWorldStore();
  const studio = useStudioStore();
  const nav = useStudioNav();
  useWorld((s) => s.rev);
  const presence = useWorld((s) => s.snapshot?.agents.find((a) => a.agentId === id) ?? null);
  const summary = useWorld((s) => s.agents.find((a) => a.agentId === id) ?? null);
  const agentsApi = useWorld((s) => s.agentsApi);
  const entered = useWorld((s) => s.entered);
  const [assign, setAssign] = useState(false);
  useTicker(true, 1000);
  const v = agentView(presence, summary, Date.now(), agentsApi);
  if (!v) return <p className={styles.cardNote}>This agent is not in the town.</p>;
  const buildingId = presence?.buildingId ?? summary?.buildingId ?? null;
  const inside = buildingId !== null && entered === buildingId;
  const latestRun = v.activeRunId ?? v.sessions[0]?.runId ?? null;
  const submit = v.capabilities.find((c) => c.id === 'submit_task');
  return (
    <>
      <div className={styles.cardTitleRow}>
        <span className={`${styles.avatar} ${styles.square}`} style={{ color: presence?.hue ?? 'var(--rl-text)' }} aria-hidden="true">
          <Icon name="agent" size={18} />
        </span>
        <div className={styles.cardTitles}>
          <h2 id={titleId} className={styles.cardTitle}>
            {v.name}
          </h2>
          <p className={styles.cardSub}>{v.unregistered ? 'Building in the Agent District' : 'Agent · Claude Code'}</p>
        </div>
      </div>
      <Chip icon={v.chip.icon} tone={v.chip.real ? 'info' : 'muted'} title={v.chip.detail}>
        {v.chip.label}
      </Chip>
      {v.unregistered ? (
        // P10: a presence with no registered agent shows nothing real and offers no actions.
        <p className={styles.cardNote}>No agent is registered for this building in this runtime, so nothing here is real agent activity.</p>
      ) : (
        <>
          <p className={styles.health} data-tone={v.health.tone}>
            <Icon name={v.health.icon} size={15} />
            <span>{v.health.text}</span>
            <span className={styles.cardNote}>· {v.lastEvent}</span>
          </p>
          {v.taskNote && (
            <p className={styles.health} data-tone="live">
              <Icon name="play" size={14} />
              <span>{v.taskNote}</span>
            </p>
          )}
          {v.attention && (
            <p className={styles.health} data-tone="warn">
              <Icon name="alert" size={14} />
              <span>{v.attention}</span>
            </p>
          )}
          <div className={styles.cardActions}>
            <Button
              size="sm"
              variant="secondary"
              icon={inside ? 'arrowUp' : 'arrowRight'}
              aria-keyshortcuts="Enter"
              data-card-enter=""
              disabled={!buildingId}
              onClick={() => {
                uiSound('select');
                if (latestRun) selectRun(studio, latestRun);
                store.getState().enter(inside ? null : buildingId);
              }}
            >
              {inside ? 'Leave building' : 'Enter building'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="play"
              disabled={!submit?.available}
              title={submit?.available ? 'Run Claude Code headless in its workspace, after you approve the exact command' : (submit?.reason ?? 'Not reported by this runtime')}
              onClick={() => {
                uiSound('open');
                setAssign(true);
              }}
            >
              Assign task
            </Button>
            {latestRun && (
              <Button size="sm" variant="ghost" icon="traces" onClick={() => nav.openTrace(latestRun)}>
                Trace
              </Button>
            )}
          </div>
          {!submit?.available && <p className={styles.cardNote}>{submit?.reason ? `Assign task: ${submit.reason}.` : 'This runtime does not report whether it can dispatch tasks.'}</p>}
          <AssignTaskDialog open={assign} onClose={() => setAssign(false)} agentId={v.agentId} agentName={v.name} workspaceLabel={v.workspace?.label ?? null} />
        </>
      )}
    </>
  );
}

function BuildingCompact({ id, titleId }: { id: string; titleId: string }) {
  const store = useWorldStore();
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const entered = useWorld((s) => s.entered);
  const tick = useWorldTick(1);
  const v = snapshot && town ? buildingView(snapshot, town, id, tick) : null;
  if (!v) return <p className={styles.cardNote}>This building is not in the town.</p>;
  const inside = entered === id;
  return (
    <>
      <div className={styles.cardTitleRow}>
        <span className={`${styles.avatar} ${styles.square}`} style={{ background: town!.buildingById.get(id)?.def.palette.roof }} aria-hidden="true">
          <Icon name="world" size={16} />
        </span>
        <div className={styles.cardTitles}>
          <h2 id={titleId} className={styles.cardTitle}>
            {v.name}
          </h2>
          <p className={styles.cardSub}>
            {v.purpose}
            {v.district ? ` · ${v.district}` : ''}
          </p>
        </div>
      </div>
      <div className={styles.chipsRow}>
        <Chip icon="diamond" title="A building of the simulated town; its occupants are simulated residents.">
          Simulated building
        </Chip>
        <Chip icon={v.openNow ? 'checkCircle' : 'slash'} tone={v.openNow ? 'ok' : 'muted'}>
          {!v.open ? 'Closed by you' : v.openNow ? 'Open now' : `Closed · ${v.hours}`}
        </Chip>
      </div>
      <p className={styles.occupancy}>
        <span className={styles.big}>{v.occupancy}</span>
        <span className={styles.cardNote}>
          / {v.capacity} inside · {v.occupants.length === 0 ? 'nobody right now' : v.occupants.slice(0, 2).map((o) => o.name).join(', ') + (v.occupants.length > 2 ? '…' : '')}
        </span>
      </p>
      <div className={styles.cardActions}>
        <Button
          size="sm"
          variant="secondary"
          icon={inside ? 'arrowUp' : 'arrowRight'}
          aria-keyshortcuts="Enter"
          data-card-enter=""
          onClick={() => {
            uiSound('select');
            store.getState().enter(inside ? null : id);
          }}
        >
          {inside ? 'Leave interior' : 'Enter'}
        </Button>
      </div>
    </>
  );
}

function PlaceCompact({ refId, name, titleId }: { refId: EntityRef; name: string; titleId: string }) {
  const town = useWorld((s) => s.town);
  const snapshot = useWorld((s) => s.snapshot);
  useWorld((s) => s.rev);
  const tick = useWorldTick(1);
  let sub: string = KIND_LABEL[refId.kind];
  let here: number | null = null;
  if (town && snapshot) {
    if (refId.kind === 'spot') {
      const spot = town.spotById.get(refId.id);
      const d = spot ? town.def.districts.find((x) => x.id === spot.def.districtId) : undefined;
      sub = `Outdoors · ${spot?.def.kind ?? 'place'}${d ? ` · ${d.label}` : ''}`;
      here = snapshot.residents.filter((r) => !r.motion && r.place.kind === 'outdoor' && r.place.spotId === refId.id).length;
    } else if (refId.kind === 'district') {
      const d = town.def.districts.find((x) => x.id === refId.id);
      sub = `District${d ? ` · ${d.kind}` : ''}`;
      here = snapshot.residents.filter((r) => residentDistrict(town, r, tick) === refId.id).length;
    } else if (refId.kind === 'lot') {
      const agent = snapshot.agents.find((a) => a.lotId === refId.id);
      sub = agent ? `Home of ${agent.displayName}` : town.lotById.get(refId.id)?.use === 'agent' ? 'Free agent lot · Add to World (N) to build here' : 'Building lot';
    }
  }
  return (
    <>
      <div className={styles.cardTitleRow}>
        <span className={`${styles.avatar} ${styles.square}`} aria-hidden="true">
          <Icon name="map" size={16} />
        </span>
        <div className={styles.cardTitles}>
          <h2 id={titleId} className={styles.cardTitle}>
            {name}
          </h2>
          <p className={styles.cardSub}>{sub}</p>
        </div>
      </div>
      {here !== null && (
        <p className={styles.occupancy}>
          <span className={styles.big}>{here}</span>
          <span className={styles.cardNote}>{here === 1 ? 'resident here now' : 'residents here now'} · Simulated · Details lists them</span>
        </p>
      )}
    </>
  );
}

/** Agents mode: the Agent District's card (your agents, Arrivals, Add to World), anchored to the district. */
export function DistrictCard({ vp, width, phone, onAddToWorld }: { vp: Viewport; width: number; phone: boolean; onAddToWorld: (fromSessionId?: string) => void }) {
  const store = useWorldStore();
  return (
    <CardFrame
      anchor={{ kind: 'district', id: 'dst_agent_district' }}
      vp={vp}
      title="Agent District"
      kind="Agent District"
      width={width}
      phone={phone}
      expanded
      onClose={() => {
        uiSound('close');
        store.getState().setMode('explore', { camera: false });
      }}
    >
      <div className={styles.cardPanel}>
        <AgentsPanel onAddToWorld={onAddToWorld} />
      </div>
    </CardFrame>
  );
}
