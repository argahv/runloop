import * as z from 'zod';

/** Current schema version for every event type in this package. */
export const SCHEMA_VERSION = 1 as const;

export const VisibilitySchema = z.enum(['public', 'redacted', 'sensitive']);
export type Visibility = z.infer<typeof VisibilitySchema>;

/**
 * Fields shared by every recorded event. `sequence` is the only ordering key:
 * timestamps are informational and may be non-monotonic.
 */
export const EnvelopeSchema = z.object({
  eventId: z.uuid(),
  runId: z.uuid(),
  sequence: z.int().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  type: z.string().min(1),
  schemaVersion: z.int().min(1),
  /** Index copy of the agent (or 'system') responsible. Derived from the payload when possible. */
  actorId: z.string().min(1).optional(),
  /** Index copy of the related task. Derived from the payload when possible. */
  taskId: z.string().min(1).optional(),
  /** Causal link, e.g. tool.call_completed -> its tool.call_started. */
  parentEventId: z.uuid().optional(),
  visibility: VisibilitySchema,
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
