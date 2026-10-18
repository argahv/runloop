/**
 * The organisation's dispatch policy (org_policies.dispatch_json, plan §4.4):
 * haiku by default, a $0.25 budget capped at $1, a 10-minute timeout, and the
 * two tool presets. A request is resolved against it at preview and checked
 * again at approval.
 */
import {
  AGENT_ORG_ID,
  DISPATCH_DEFAULTS,
  DISPATCH_PRESETS,
  type DispatchErrorCode,
  type DispatchPolicy,
  type DispatchPreset,
  type DispatchPreviewRequest,
} from '@runloop-world/events';
import type { Db } from '../store/db';

/** Hard ceilings no stored policy can raise. */
const HARD_MAX_TIMEOUT_MIN = 60;
const PRESETS = Object.keys(DISPATCH_PRESETS) as DispatchPreset[];

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  enabled: true,
  models: [DISPATCH_DEFAULTS.model, 'sonnet'],
  defaultBudgetUsd: DISPATCH_DEFAULTS.maxBudgetUsd,
  maxBudgetUsd: DISPATCH_DEFAULTS.maxBudgetCapUsd,
  defaultTimeoutMin: DISPATCH_DEFAULTS.timeoutMin,
  maxTimeoutMin: 30,
  presets: [...PRESETS],
  maxRunningPerAgent: 1,
  maxRunningTotal: 2,
};

const MODEL = /^[a-z][a-z0-9.-]{0,63}$/;
const cents = (usd: number) => Math.round(usd * 100) / 100;

/** A stored policy made safe: unknown or invalid fields fall back to the defaults, and caps never exceed the hard caps. */
export function normalizePolicy(raw: unknown): DispatchPolicy {
  const d = DEFAULT_DISPATCH_POLICY;
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback);
  const models = Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string' && MODEL.test(m)) : [];
  const presets = Array.isArray(r.presets) ? r.presets.filter((p): p is DispatchPreset => PRESETS.includes(p as DispatchPreset)) : [];
  const maxBudgetUsd = cents(num(r.maxBudgetUsd, 0.01, DISPATCH_DEFAULTS.maxBudgetCapUsd, d.maxBudgetUsd));
  const maxTimeoutMin = Math.floor(num(r.maxTimeoutMin, 1, HARD_MAX_TIMEOUT_MIN, d.maxTimeoutMin));
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    models: models.length ? models : [...d.models],
    defaultBudgetUsd: Math.min(cents(num(r.defaultBudgetUsd, 0.01, DISPATCH_DEFAULTS.maxBudgetCapUsd, d.defaultBudgetUsd)), maxBudgetUsd),
    maxBudgetUsd,
    defaultTimeoutMin: Math.min(Math.floor(num(r.defaultTimeoutMin, 1, HARD_MAX_TIMEOUT_MIN, d.defaultTimeoutMin)), maxTimeoutMin),
    maxTimeoutMin,
    presets: presets.length ? presets : [...d.presets],
    maxRunningPerAgent: Math.floor(num(r.maxRunningPerAgent, 1, 8, d.maxRunningPerAgent)),
    maxRunningTotal: Math.floor(num(r.maxRunningTotal, 1, 16, d.maxRunningTotal)),
  };
}

/** The org's policy; the defaults are written on first use so the row shows what applies. */
export function ensurePolicy(db: Db, orgId: string = AGENT_ORG_ID): DispatchPolicy {
  db.prepare('INSERT OR IGNORE INTO org_policies (org_id, dispatch_json) VALUES (?, ?)').run(orgId, JSON.stringify(DEFAULT_DISPATCH_POLICY));
  return readPolicy(db, orgId);
}

export function readPolicy(db: Db, orgId: string = AGENT_ORG_ID): DispatchPolicy {
  const row = db.prepare('SELECT dispatch_json FROM org_policies WHERE org_id = ?').get(orgId) as { dispatch_json: string } | undefined;
  if (!row) return { ...DEFAULT_DISPATCH_POLICY, enabled: false };
  try {
    return normalizePolicy(JSON.parse(row.dispatch_json));
  } catch {
    return { ...DEFAULT_DISPATCH_POLICY, enabled: false };
  }
}

export interface ResolvedRequest {
  preset: DispatchPreset;
  allowedTools: string[];
  model: string;
  maxBudgetUsd: number;
  timeoutMin: number;
}

export type PolicyRefusal = { ok: false; status: 400 | 403; code: DispatchErrorCode; error: string };

/** Fill in the defaults and check the request against the policy. */
export function resolveRequest(policy: DispatchPolicy, req: DispatchPreviewRequest): ({ ok: true } & ResolvedRequest) | PolicyRefusal {
  if (!policy.enabled) return { ok: false, status: 403, code: 'blocked_by_policy', error: "Your organisation's policy does not allow task dispatch" };
  if (!policy.presets.includes(req.preset)) return { ok: false, status: 403, code: 'preset_not_allowed', error: 'The policy does not allow that tool preset' };
  const model = req.model ?? policy.models[0] ?? DISPATCH_DEFAULTS.model;
  if (!policy.models.includes(model)) {
    return { ok: false, status: 400, code: 'model_not_allowed', error: `The policy allows only these models: ${policy.models.join(', ')}` };
  }
  const budget = cents(req.maxBudgetUsd ?? policy.defaultBudgetUsd);
  if (budget < 0.01 || budget > policy.maxBudgetUsd) {
    return { ok: false, status: 400, code: 'budget_over_cap', error: `The budget must be between $0.01 and $${policy.maxBudgetUsd}` };
  }
  const timeoutMin = req.timeoutMin ?? policy.defaultTimeoutMin;
  if (timeoutMin > policy.maxTimeoutMin) {
    return { ok: false, status: 400, code: 'timeout_over_cap', error: `The timeout can be at most ${policy.maxTimeoutMin} minutes` };
  }
  return { ok: true, preset: req.preset, allowedTools: [...DISPATCH_PRESETS[req.preset]], model, maxBudgetUsd: budget, timeoutMin };
}
