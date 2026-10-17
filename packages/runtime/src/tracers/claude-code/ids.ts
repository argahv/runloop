import { createHash } from 'node:crypto';

/** Fixed namespace for Claude Code run ids (a random UUID, chosen once; never change it). */
export const CLAUDE_CODE_NAMESPACE = '6f1d3a52-8c7e-4b0f-9a3d-2e5c71b94f08';

/** RFC 4122 version-5 UUID (SHA-1 of namespace + name). */
export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error(`Invalid namespace UUID: ${namespace}`);
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic run id for one segment of a Claude Code session. */
export function runIdFor(sessionId: string, segment: number): string {
  return uuidv5(CLAUDE_CODE_NAMESPACE, `claude-code:${sessionId}:${segment}`);
}

export const MAIN_AGENT_ID = 'main';
export const USER_AGENT_ID = 'user';

/** `sa-<agent_id>`, limited to [A-Za-z0-9._-] and 64 characters. */
export function subagentId(ccAgentId: string): string {
  return `sa-${ccAgentId.replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 64);
}

/** Ids inside a run: turn-<n>, delegate-<k>, perm-<n>, msg-<n>. */
export const turnTaskId = (n: number) => `turn-${n}`;
export const delegateTaskId = (k: number) => `delegate-${k}`;
export const permissionId = (n: number) => `perm-${n}`;
export const messageId = (n: number) => `msg-${n}`;

/** Stable JSON (sorted keys), so the same input hashes the same whatever its key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of the stable JSON of a tool input (matches a PermissionRequest to its call). */
export function inputHash(input: unknown): string {
  return createHash('sha256').update(stableJson(input ?? null)).digest('hex');
}
