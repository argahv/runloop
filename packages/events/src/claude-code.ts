/**
 * Validation for the Claude Code ingest protocol (v1). The TypeScript shapes
 * are in protocol.ts; these schemas are what the runtime enforces.
 *
 * Hook payloads are loose on purpose: only `session_id` and
 * `hook_event_name` are required and unknown keys pass, because Claude Code
 * adds fields between versions.
 */
import * as z from 'zod';

export const ClaudeCodeHookSchema = z.looseObject({
  session_id: z.string().min(1).max(200),
  hook_event_name: z.string().min(1).max(100),
});

export const ClaudeCodeHookEnvelopeSchema = z.object({
  v: z.literal(1),
  deliveryId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  observedAt: z.iso.datetime({ offset: true }),
  ppid: z.int().min(0).optional(),
  plugin: z.object({ name: z.string().min(1).max(100), version: z.string().max(50) }),
  hook: ClaudeCodeHookSchema,
});

/** A validated envelope; `hook` keeps every key Claude Code sent. */
export type ValidClaudeCodeHookEnvelope = z.infer<typeof ClaudeCodeHookEnvelopeSchema>;

export const ClaudeCodeIngestRequestSchema = z.object({
  envelopes: z.array(ClaudeCodeHookEnvelopeSchema).min(1).max(100),
});

/** Ingest protocol versions this package understands. */
export const CLAUDE_CODE_PROTOCOLS = [1] as const;
