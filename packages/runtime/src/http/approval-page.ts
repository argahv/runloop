/**
 * The runtime's own approval page for a dispatch (plan §4.4, review fix):
 * the one place a person approves a task. It is served from the runtime's
 * origin and never through CORS, so no other web page can read its nonce or
 * submit it; Studio opens it in a window. Plain HTML with no script: every
 * value is escaped, the CSP allows only this page's own inline style and a
 * form posting back to itself, and nothing may frame it.
 */
import { randomBytes } from 'node:crypto';
import type { DispatchManager } from '../dispatch/dispatch-manager';

type View = NonNullable<ReturnType<DispatchManager['approvalView']>>;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** POSIX shell quoting, for showing the argv as one readable command. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Response headers of every approval page. `nonce` is the CSP nonce of its one style block. */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Not no-referrer: under it a browser sends `Origin: null` with the page's own form post.
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

export const newCspNonce = () => randomBytes(16).toString('base64');

const STYLE = `
:root { color-scheme: dark light; --bg: #101114; --surface: #1b1d22; --raised: #292c33; --text: #e8ebf0; --muted: #9297a2; --accent: #b8f36a; --on-accent: #101114; --warn: #f5b84b; --fail: #ff6b76; --ok: #48c78e; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --surface: #ffffff; --raised: #eceef2; --text: #16181d; --muted: #5b616d; --accent: #b8f36a; --on-accent: #16181d; --warn: #8a5a00; --fail: #b3261e; --ok: #1d7a50; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 40px; }
.brand { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
h1 { font-size: 24px; line-height: 1.25; margin: 0 0 8px; font-weight: 600; }
.lede { color: var(--muted); margin: 0 0 20px; }
section { background: var(--surface); border-radius: 12px; padding: 16px; margin: 0 0 16px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--raised); border-radius: 8px; padding: 12px; max-height: 320px; overflow: auto; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
code { font: 13px ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.note { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.warn { color: var(--warn); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0 8px; }
button { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--on-accent); }
button.secondary { background: var(--raised); color: var(--text); }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.status { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
.status.ok { color: var(--ok); } .status.fail { color: var(--fail); }
@media (max-width: 480px) { dl { grid-template-columns: 1fr; gap: 2px; } dd { margin-bottom: 8px; } }
`;

function page(title: string, nonce: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>
<p class="brand">Runloop · approval</p>
${body}
</main></body>
</html>`;
}

/** The approval form: exactly what will run, Approve and Decline. */
export function renderApproval(v: View, nonce: string, notice: string | null = null): string {
  const edits = v.allowedTools.some((t) => /^(Edit|Write)$/.test(t));
  const expires = v.expiresAt.slice(11, 19);
  const command = v.argv.map(shellQuote).join(' ');
  const body = `
<h1>Run this task for ${esc(v.agentName)}?</h1>
<p class="lede">Claude Code will work in “${esc(v.workspaceLabel)}” <code>${esc(v.pathHint)}</code> with only the tools below, without asking again (permission mode <code>dontAsk</code>). Nothing runs until you approve.</p>
${notice ? `<p class="lede warn" role="alert">${esc(notice)}</p>` : ''}
<section aria-labelledby="h-task"><h2 id="h-task">Task</h2><pre>${esc(v.task)}</pre></section>
<section aria-labelledby="h-terms"><h2 id="h-terms">Terms</h2><dl>
<dt>Model</dt><dd>${esc(v.model)}</dd>
<dt>Budget</dt><dd>at most $${v.maxBudgetUsd.toFixed(2)} · Billed to your Anthropic account</dd>
<dt>Time limit</dt><dd>${v.timeoutMin} min</dd>
<dt>Tools allowed</dt><dd>${v.allowedTools.map((t) => `<code>${esc(t)}</code>`).join(', ')}</dd>
<dt>Your files</dt><dd>${edits ? 'Edits land in your working tree' : 'Read-only: no edits'}</dd>
<dt>Environment</dt><dd>${v.envKeys.map((k) => `<code>${esc(k)}</code>`).join(', ')} (names only; values are never stored)</dd>
<dt>Tracing</dt><dd>${v.usesPluginDir ? 'Runloop’s tracer plugin is loaded for this session (<code>--plugin-dir</code>)' : 'by the tracer Claude Code already has'}</dd>
<dt>Claude Code</dt><dd>${esc(v.cliVersion ?? 'version not reported')} · <code>${esc(v.executable)}</code></dd>
<dt>Session</dt><dd><code>${esc(v.sessionId)}</code></dd>
</dl><p class="note">When it ends, Runloop shows the outcome as Claude Code reports it (“Claude Code reports done”).</p></section>
<section aria-labelledby="h-cmd"><h2 id="h-cmd">Exact command</h2><pre>${esc(command)}</pre></section>
<form method="post" action="">
<input type="hidden" name="nonce" value="${esc(v.nonce)}">
<div class="actions">
<button class="primary" type="submit" name="action" value="approve">Approve and run</button>
<button class="secondary" type="submit" name="action" value="decline">Decline</button>
</div>
</form>
<p class="note">This approval expires at ${esc(expires)} UTC. Only this page can approve the task: Runloop refuses approvals from any other web page.</p>`;
  return page('Approve a task · Runloop', nonce, body);
}

/** A page that ends the flow: started, refused, declined or no longer valid. */
export function renderOutcome(o: { ok: boolean; title: string; text: string; detail?: string | null }, nonce: string): string {
  const body = `
<p class="status ${o.ok ? 'ok' : 'fail'}" role="status">${esc(o.title)}</p>
<p class="lede">${esc(o.text)}</p>
${o.detail ? `<p class="note"><code>${esc(o.detail)}</code></p>` : ''}
<p class="note">You can close this window and return to Runloop Studio.</p>`;
  return page(`${o.title} · Runloop`, nonce, body);
}
