/**
 * Dispatch API calls (types: @runloop-world/events world-protocol.ts, plan §4.5).
 * Errors are WorldApiError with the runtime's `code` (bad_nonce, workspace_moved, …).
 */
import {
  worldApiPaths,
  type DispatchPolicyResponse,
  type DispatchPreviewRequest,
  type DispatchPreviewResponse,
  type DispatchResponse,
} from '@runloop-world/events';
import { apiUrl } from '../../lib/api';
import { WorldApiError } from '../../world/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: 'no-store', ...init });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // not JSON
    }
    throw new WorldApiError(res.status, message, code);
  }
  return (await res.json()) as T;
}

/** Writes are JSON; the browser adds the Origin header the runtime requires for approval. */
const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getDispatchPolicy = () => request<DispatchPolicyResponse>(worldApiPaths.dispatchPolicy);
export const previewDispatch = (agentId: string, body: DispatchPreviewRequest) => request<DispatchPreviewResponse>(worldApiPaths.dispatchPreview(agentId), postJson(body));
export const approveDispatch = (previewId: string, approvalNonce: string) => request<DispatchResponse>(worldApiPaths.dispatches, postJson({ previewId, approvalNonce }));
export const getDispatch = (dispatchId: string) => request<DispatchResponse>(worldApiPaths.dispatch(dispatchId));
export const cancelDispatch = (dispatchId: string) => request<DispatchResponse>(worldApiPaths.dispatchCancel(dispatchId), postJson({}));
export const dispatchStreamUrl = (dispatchId: string) => apiUrl(worldApiPaths.dispatchStream(dispatchId));
