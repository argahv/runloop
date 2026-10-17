/** Base URL of the local runtime API (no trailing slash). */
export const API_BASE = (process.env.NEXT_PUBLIC_RUNLOOP_API ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');

/** Mission started by the "Run demo mission" button. */
export const DEMO_MISSION_ID = 'coding-mission';

/** Command shown when the runtime is offline. */
export const START_RUNTIME_COMMAND = 'pnpm dev';
