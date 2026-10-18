/**
 * Persistence of real agents (MIGRATIONS[4]): agents, workspaces,
 * connections, session bindings and the audit log. Absolute paths are not
 * stored here; roots go through LocalRoots (P8).
 */
import { AGENT_ORG_ID, type BindingMethod, type RunStatus, type WorkspaceSummary } from '@runloop-world/events';
import { tx, type Db } from '../store/db';
import type { LocalRoots } from './local-roots';

/** The identity hues of docs/design/design-system.md (--rl-id-1…8, dark theme). Lime is never one. */
export const AGENT_HUES = ['#5aa9f5', '#e0946a', '#43c6d9', '#a08cf9', '#e67ccb', '#8fa4bf', '#c38bd9', '#cdb592'] as const;

export interface AgentRecord {
  agentId: string;
  displayName: string;
  hue: string;
  orgId: string;
  lotId: string | null;
  housed: boolean;
  createdAt: string;
  workspace: WorkspaceSummary | null;
  firstEventAt: string | null;
  /** As last persisted (the service keeps a fresher value in memory). */
  lastEnvelopeAt: string | null;
  dispatchEnabled: boolean;
}

/** A traced run of a session bound to an agent. */
export interface BoundRun {
  runId: string;
  sessionId: string;
  segment: number;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string | null;
  method: BindingMethod;
}

/** A traced session no agent's workspace holds, as recorded (its cwd is not stored). */
export interface UnboundSession {
  sessionId: string;
  projectLabel: string;
  runIds: string[];
  firstSeenAt: string;
  lastEventAt: string | null;
}

export interface NewAgent {
  agentId: string;
  displayName: string;
  hue: string;
  lotId: string;
  workspaceId: string;
  label: string;
  pathHint: string;
  rootRealpath: string;
}

interface AgentRow {
  agent_id: string;
  display_name: string;
  hue: string;
  org_id: string;
  lot_id: string | null;
  housed: number;
  created_at: string;
  workspace_id: string | null;
  label: string | null;
  path_hint: string | null;
  first_event_at: string | null;
  last_envelope_at: string | null;
  dispatch_enabled: number | null;
}

const AGENT_SELECT = `
  SELECT a.agent_id, a.display_name, a.hue, a.org_id, a.lot_id, a.housed, a.created_at,
         w.workspace_id, w.label, w.path_hint, c.first_event_at, c.last_envelope_at, c.dispatch_enabled
  FROM agents a
  LEFT JOIN workspaces w ON w.agent_id = a.agent_id
  LEFT JOIN agent_connections c ON c.agent_id = a.agent_id`;

function toRecord(r: AgentRow): AgentRecord {
  return {
    agentId: r.agent_id,
    displayName: r.display_name,
    hue: r.hue,
    orgId: r.org_id,
    lotId: r.lot_id,
    housed: r.housed === 1,
    createdAt: r.created_at,
    workspace: r.workspace_id ? { workspaceId: r.workspace_id, label: r.label ?? '', pathHint: r.path_hint ?? '' } : null,
    firstEventAt: r.first_event_at,
    lastEnvelopeAt: r.last_envelope_at,
    dispatchEnabled: r.dispatch_enabled === 1,
  };
}

export class AgentRegistry {
  constructor(
    private readonly db: Db,
    readonly roots: LocalRoots,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Insert an agent (unhoused), its workspace, root and connection row, and optionally a first binding, in one transaction. */
  insert(a: NewAgent, binding?: { sessionId: string; method: BindingMethod }): void {
    const at = this.now().toISOString();
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO agents (agent_id, display_name, hue, org_id, lot_id, housed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(a.agentId, a.displayName, a.hue, AGENT_ORG_ID, a.lotId, at);
      this.db
        .prepare('INSERT INTO workspaces (workspace_id, agent_id, label, path_hint) VALUES (?, ?, ?, ?)')
        .run(a.workspaceId, a.agentId, a.label, a.pathHint);
      this.roots.add(a.workspaceId, a.rootRealpath);
      this.db.prepare('INSERT INTO agent_connections (agent_id, dispatch_enabled) VALUES (?, 0)').run(a.agentId);
      if (binding) this.insertBinding(binding.sessionId, a.agentId, binding.method, at);
      this.insertAudit('agent.created', { agentId: a.agentId, lotId: a.lotId, workspaceId: a.workspaceId }, at);
    });
  }

  /** Undo insert() (the world rejected housing it). Nothing else refers to a fresh agent. */
  remove(agentId: string, reason: string): void {
    const at = this.now().toISOString();
    tx(this.db, () => {
      const ws = this.db.prepare('SELECT workspace_id FROM workspaces WHERE agent_id = ?').get(agentId) as { workspace_id: string } | undefined;
      this.db.prepare('DELETE FROM session_bindings WHERE agent_id = ?').run(agentId);
      this.db.prepare('DELETE FROM agent_connections WHERE agent_id = ?').run(agentId);
      if (ws) this.roots.removeAll(ws.workspace_id);
      this.db.prepare('DELETE FROM workspaces WHERE agent_id = ?').run(agentId);
      this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
      this.insertAudit('agent.removed', { agentId, reason }, at);
    });
  }

  markHoused(agentId: string): void {
    this.db.prepare('UPDATE agents SET housed = 1 WHERE agent_id = ?').run(agentId);
  }

  get(agentId: string): AgentRecord | null {
    const row = this.db.prepare(`${AGENT_SELECT} WHERE a.agent_id = ?`).get(agentId) as AgentRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): AgentRecord[] {
    const rows = this.db.prepare(`${AGENT_SELECT} ORDER BY a.created_at, a.rowid`).all() as unknown as AgentRow[];
    return rows.map(toRecord);
  }

  agentOfWorkspace(workspaceId: string): string | null {
    const row = this.db.prepare('SELECT agent_id FROM workspaces WHERE workspace_id = ?').get(workspaceId) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  lotTaken(lotId: string): boolean {
    return this.db.prepare('SELECT 1 FROM agents WHERE lot_id = ?').get(lotId) !== undefined;
  }

  /** The first identity hue no agent uses yet (cycling once all are taken). */
  nextHue(): string {
    const used = new Set((this.db.prepare('SELECT hue FROM agents').all() as { hue: string }[]).map((r) => r.hue.toLowerCase()));
    return AGENT_HUES.find((h) => !used.has(h)) ?? AGENT_HUES[used.size % AGENT_HUES.length]!;
  }

  // ── bindings ───────────────────────────────────────────────────────

  bindingOf(sessionId: string): { agentId: string; method: BindingMethod } | null {
    const row = this.db.prepare('SELECT agent_id, method FROM session_bindings WHERE session_id = ?').get(sessionId) as
      | { agent_id: string; method: BindingMethod }
      | undefined;
    return row ? { agentId: row.agent_id, method: row.method } : null;
  }

  /** Bind a session (fixed from now on). Returns false when it was already bound. */
  bind(sessionId: string, agentId: string, method: BindingMethod): boolean {
    const at = this.now().toISOString();
    return tx(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM session_bindings WHERE session_id = ?').get(sessionId)) return false;
      this.insertBinding(sessionId, agentId, method, at);
      this.insertAudit(method === 'claimed' ? 'session.claimed' : 'session.bound', { sessionId, agentId, method }, at);
      return true;
    });
  }

  /** Runs of the agent's bound sessions, newest first. */
  runsOf(agentId: string, limit = 50): BoundRun[] {
    const rows = this.db
      .prepare(
        `SELECT r.run_id, r.external_session_id, r.segment, r.status, r.created_at, r.ended_at, r.last_event_at, b.method
         FROM session_bindings b
         JOIN runs r ON r.source_kind = 'claude-code' AND r.external_session_id = b.session_id
         WHERE b.agent_id = ? ORDER BY r.created_at DESC, r.segment DESC LIMIT ?`,
      )
      .all(agentId, limit) as {
      run_id: string;
      external_session_id: string;
      segment: number | null;
      status: RunStatus;
      created_at: string;
      ended_at: string | null;
      last_event_at: string | null;
      method: BindingMethod;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      sessionId: r.external_session_id,
      segment: r.segment ?? 1,
      status: r.status,
      startedAt: r.created_at,
      endedAt: r.ended_at,
      lastEventAt: r.last_event_at,
      method: r.method,
    }));
  }

  /** Open bound runs of the agent, oldest first. */
  openRunIdsOf(agentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.run_id FROM session_bindings b
         JOIN runs r ON r.source_kind = 'claude-code' AND r.external_session_id = b.session_id
         WHERE b.agent_id = ? AND r.status = 'running' ORDER BY r.created_at, r.segment`,
      )
      .all(agentId) as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  sessionCount(agentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_bindings b
         JOIN runs r ON r.source_kind = 'claude-code' AND r.external_session_id = b.session_id WHERE b.agent_id = ?`,
      )
      .get(agentId) as { n: number };
    return row.n;
  }

  /** Runs recorded for a session, by segment. */
  runIdsOfSession(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT run_id FROM runs WHERE source_kind = 'claude-code' AND external_session_id = ? ORDER BY segment`)
      .all(sessionId) as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  /** The traced sessions no agent holds, most recent first. */
  unboundSessions(limit = 50): UnboundSession[] {
    const rows = this.db
      .prepare(
        `SELECT r.run_id, r.external_session_id, r.project_label, r.created_at, r.last_event_at
         FROM runs r LEFT JOIN session_bindings b ON b.session_id = r.external_session_id
         WHERE r.source_kind = 'claude-code' AND r.external_session_id IS NOT NULL AND b.session_id IS NULL
         ORDER BY r.created_at, r.segment`,
      )
      .all() as { run_id: string; external_session_id: string; project_label: string | null; created_at: string; last_event_at: string | null }[];
    const by = new Map<string, UnboundSession>();
    for (const r of rows) {
      let s = by.get(r.external_session_id);
      if (!s) by.set(r.external_session_id, (s = { sessionId: r.external_session_id, projectLabel: '', runIds: [], firstSeenAt: r.created_at, lastEventAt: null }));
      s.runIds.push(r.run_id);
      s.projectLabel = r.project_label ?? s.projectLabel;
      if (r.last_event_at && (!s.lastEventAt || r.last_event_at > s.lastEventAt)) s.lastEventAt = r.last_event_at;
    }
    return [...by.values()].sort((a, b) => (b.lastEventAt ?? b.firstSeenAt).localeCompare(a.lastEventAt ?? a.firstSeenAt)).slice(0, limit);
  }

  // ── connection signals ─────────────────────────────────────────────

  /** Record the first bound event (only once). */
  noteFirstEvent(agentId: string, at: string): void {
    this.db.prepare('UPDATE agent_connections SET first_event_at = ? WHERE agent_id = ? AND first_event_at IS NULL').run(at, agentId);
  }

  persistLastEnvelope(agentId: string, at: string): void {
    this.db.prepare('UPDATE agent_connections SET last_envelope_at = ? WHERE agent_id = ?').run(at, agentId);
  }

  /** The agent a running dispatch launched this session for (S4 fills the table). */
  dispatchAgentFor(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT agent_id FROM dispatches WHERE session_id = ? AND status = 'running'`).get(sessionId) as
      | { agent_id: string }
      | undefined;
    return row?.agent_id ?? null;
  }

  runningDispatches(agentId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE agent_id = ? AND status = 'running'`).get(agentId) as { n: number };
    return row.n;
  }

  /** Whether the organisation's dispatch policy is switched on (S4 writes it; absent = off). */
  policyAllowsDispatch(orgId: string): boolean {
    const row = this.db.prepare('SELECT dispatch_json FROM org_policies WHERE org_id = ?').get(orgId) as { dispatch_json: string } | undefined;
    if (!row) return false;
    try {
      return (JSON.parse(row.dispatch_json) as { enabled?: unknown }).enabled === true;
    } catch {
      return false;
    }
  }

  audit(action: string, detail: Record<string, unknown>): void {
    this.insertAudit(action, detail, this.now().toISOString());
  }

  private insertBinding(sessionId: string, agentId: string, method: BindingMethod, at: string): void {
    this.db.prepare('INSERT INTO session_bindings (session_id, agent_id, method, bound_at) VALUES (?, ?, ?, ?)').run(sessionId, agentId, method, at);
  }

  /** Audit details carry ids only: never paths, task text or tokens. */
  private insertAudit(action: string, detail: Record<string, unknown>, at: string): void {
    this.db.prepare('INSERT INTO audit_log (at, action, detail_json) VALUES (?, ?, ?)').run(at, action, JSON.stringify(detail));
  }
}
