# Runloop tracer for Claude Code

A Claude Code plugin that records your sessions into a local [Runloop](../../README.md) runtime: prompts, tool calls, subagents, permission requests and replies. Studio shows the session live as a 3D world and a timeline, and you can replay it later.

It only observes. It never blocks, approves or changes anything in Claude Code: every hook exits 0 and prints nothing. Its time budget counts from process start: asynchronous hooks give up after 1.5 s, and the synchronous `Stop`, `StopFailure` and `SessionEnd` after 1 s (they skip the POST and only spool when Node's start-up already used most of it). Measured on a 4-core Linux machine: `Stop` takes about 0.13 s with the runtime up and 0.57 s with a runtime that accepts connections but never answers (0.73 s with 20,000 spooled events), and about 0.6 s with 64 other hook processes starting at the same time. A machine so loaded that Node itself needs more than the hook's timeout to start can still exceed it; the event is then lost only if the spool write never ran.

## Requirements

- The Runloop runtime running on the same machine (`pnpm serve` or `pnpm dev` in the Runloop repo). It listens on `http://127.0.0.1:4380` and creates the ingest token the plugin reads.
- `node` (22 or later) on the `PATH` that Claude Code sees. If it is not, hooks fail silently.

## Install

**From a checkout (development):**

```sh
pnpm serve                                                     # in the Runloop repo
claude --plugin-dir ~/code/runloop/integrations/claude-code-plugin
```

After editing the plugin, run `/reload-plugins` inside Claude Code.

**From the marketplace:**

```
/plugin marketplace add argahv/runloop
/plugin install runloop-tracer@runloop
```

Or from the shell: `claude plugin install runloop-tracer@runloop --scope user`. On Claude Code 2.1.275 or later, `/plugin install runloop-tracer --marketplace argahv/runloop` does both in one step.

Install it once: with both `--plugin-dir` and the marketplace copy, every event is sent twice (most are deduplicated, markers are not).

**Check the setup:**

```sh
node <plugin dir>/scripts/runloop-hook.mjs --doctor
```

It prints the runtime URL, whether the token file exists (and warns when other users can read it, or it belongs to another user) and whether the runtime answers. For each of the plugin's data directories, it prints the spool size, the last accepted event and the last error, and it sends anything waiting in the spool. From a shell it checks every `~/.claude/plugins/data/runloop-tracer*` directory. With `--plugin-dir`, Claude Code uses `runloop-tracer-inline` (verified); an installed copy gets its own `runloop-tracer…` directory. `CLAUDE_PLUGIN_DATA` overrides the search.

## Configuration

Environment variables win over plugin options, which win over defaults.

| Setting | Environment | Plugin option | Default |
|---|---|---|---|
| Runtime URL | `RUNLOOP_URL` | `runtime_url` | `http://127.0.0.1:4380`. Loopback addresses only; anything else is refused. |
| Token file | `RUNLOOP_INGEST_TOKEN_FILE` | none | `$XDG_CONFIG_HOME/runloop/ingest-token`, else `~/.config/runloop/ingest-token` (`%APPDATA%\runloop\ingest-token` on Windows) |
| Tracing on | `RUNLOOP_TRACE=0` turns it off | `enabled` | on |
| Prompt text | `RUNLOOP_TRACE_PROMPTS=0` stores a placeholder | `trace_prompts` | recorded, marked sensitive |
| Debug | `RUNLOOP_TRACE_DEBUG=1` writes errors to stderr | none | off |

## What is collected

Sent to the local runtime only, per hook:
- the session id, the hook name, the project's working directory (Runloop stores only its base name, e.g. `demo`) and the permission mode;
- prompts and Claude's final replies (marked sensitive; prompts can be turned off);
- tool names and inputs (commands, file paths, search patterns), capped at 4 KB per string;
- for tool results, only sizes and counts (lines read, lines added and removed, files found), the last 2 KB of command output (used to read test counts such as `12 tests: 10 passed, 2 failed`), and, for subagents, the model and token usage Claude Code reports.

Not collected: file contents, diffs, full command output, Claude Code's transcript files and their paths. Absolute paths are made relative to the project (or shortened to `~/…`) before anything is stored.

Secrets are masked twice, in the plugin before anything is written or sent, and again in the runtime. Each long string is masked whole before it is cut to size. What is recognised:
- token formats: OpenAI/Anthropic `sk-…`, Stripe `sk_live_…`/`rk_live_…`, GitHub `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`, GitLab `glpat-`, AWS `AKIA…`/`ASIA…`, Slack `xox…` and webhook URLs, Google `AIza…`, npm `npm_…`, Docker `dckr_pat_…`;
- by position: the password in `scheme://user:password@host`, `Authorization: <scheme> <value>`, `Bearer <value>`, `X-…-Key`/`X-…-Token` headers, `name=value` or `name: value` where the name ends in key, token, secret, password, pwd, passphrase or credentials (assignments, form data, query strings, JSON), `curl -u user:password` and `mysql -p<password>`;
- in shell commands also: `NAME_KEY=value` in any case, `--password`/`--token`/`--secret`/`--api-key` values, `login … -p <value>` and `sshpass -p <value>`, and a long value after a credential-like word (`aws configure set aws_secret_access_key <value>`);
- the values of credential-like environment variables (Claude Code's in the plugin, the runtime's in the runtime), and every value found above wherever else the same hook repeats it (for example a password echoed in an error).

Anything else is not recognised: a password given as a bare argument (`tool login hunter2`) or a secret in a format not listed is stored as is. Shell commands are therefore marked *sensitive* in the trace.

## Privacy and security

- **Local only.** The plugin posts only to loopback addresses; the runtime only listens on loopback.
- **Authenticated writes.** Each request carries the per-user token from the token file (mode 0600; the runtime tightens an existing file to 0600 at start-up and warns if another user owns it). Requests from browsers (any `Origin` header) are rejected, so web pages cannot inject events.
- **Reads are local and unauthenticated.** Any process of yours can read traced runs from the runtime's API, the same as its database file. Traced runs contain prompts and commands.
- **Delete.** Remove the runtime's `runloop.db` (and `artifacts/`), and the plugin's spool directory.

## Turning it off

- For one shell: `RUNLOOP_TRACE=0 claude …`
- Without uninstalling: set the plugin option `enabled` to false, or `claude plugin disable runloop-tracer`.
- Uninstall: `claude plugin uninstall runloop-tracer`. Claude Code deletes the plugin's data directory (and the spool) with it.

`claude --bare` and `--safe-mode` sessions skip plugins, so they are never traced. `claude -p` and Agent SDK sessions are traced while the plugin is enabled; set `RUNLOOP_TRACE=0` in CI.

## How it works

```
Claude Code hook ─► node scripts/runloop-hook.mjs
                      read stdin → slim (drop tool output, keep counts) → redact
                      → write spool/<session>/<time>-<id>.json      (before any network call)
                      → POST /api/ingest/claude-code: the spool, oldest first (this event last), in requests
                        of at most 100 events and 512 KiB, until it is empty or the time budget runs out
                      → 2xx: delete what was sent · down/5xx/401/429: keep · 400/413: drop the invalid ones only
                      → exit 0, nothing on stdout
```

- Hooks run asynchronously, except `Stop`, `StopFailure` and `SessionEnd`: under `claude -p` an async `Stop` hook was killed before it ran, so those three are synchronous (a fast spool write and a POST with a 500 ms timeout).
- If the runtime is down, events wait in the spool (`$CLAUDE_PLUGIN_DATA/spool`, at most 50 MiB and 7 days) and later hooks send them, oldest first. An event is never sent ahead of an older one still waiting, so a `SessionEnd` cannot close a run before the rest of its backlog arrives. Whatever a hook's time budget leaves behind stays in the spool, in order, for the next hook or `--doctor`.
- If the spool cannot be written (read-only or full disk), the event is still sent directly.
- `PostToolBatch` marks the end of a batch of tool calls: a permission request whose call got no result in that batch is closed as denied (*inferred*) at the agent's next step.
- Everything else (turns, subagent attribution, permission outcomes, test counts) is worked out in the runtime; see `packages/runtime/README.md`.

## Known limits

- A denied permission fires no hook in default mode. Runloop closes the call as denied at the agent's next step after the batch that held it ended (or at the turn's end, the next prompt, the subagent's end or the session's end) and labels it *inferred*.
- Which `Agent` call started a subagent is only reported by the call's result. Until then the link (the subagent task's title and parent) is *inferred* from arrival order; a wrong guess gets a "Delegation corrected" marker when the result arrives.
- Claude Code reports token usage for subagents only (in the `Agent` tool result). The main agent's usage is shown as not reported.
- If Claude Code is killed, the run is closed as interrupted after 120 minutes without events (`RUNLOOP_TRACE_IDLE_MINUTES` on the runtime).
- Managed settings with `allowManagedHooksOnly` block plugin hooks; nothing is recorded and `--doctor` says so.

## Development

```sh
pnpm vitest run --project claude-code-plugin   # unit tests, plus parity with the runtime's slimming and redaction
pnpm --filter @runloop-world/claude-code-plugin typecheck
claude plugin validate integrations/claude-code-plugin
```

The script uses Node built-ins only and must stay self-contained (a marketplace install copies only this directory). Its slimming and redaction mirror `packages/runtime/src/tracers/claude-code/hook-input.ts`, `summarize.ts` and `packages/events/src/redact.ts`; the parity tests fail if they drift. The end-to-end test (`packages/runtime/test/claude-code-plugin.e2e.test.ts`) runs the real script against a live runtime.
