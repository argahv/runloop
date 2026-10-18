# Runloop product strategy

> Status: working strategy, 2026-10-17 (build-order statuses updated 2026-10-18). The claims below are marked **[V]** (verified at the cited source), **[H]** (hypothesis) or **[D]** (decision). The research that backs this is summarised in [`docs/status/decision-log.md`](../status/decision-log.md).

## One line

**Runloop is a local flight recorder for coding agents. Watch a run live as a 3D world, replay any moment, and diff two runs to prove which setup is better.**

The 3D world is the signature interface: memorable, shareable, and good at showing parallel work. The engineering value is the trace, the replay and the comparison. Every piece of basic work also has a conventional 2D/text path.

## The problem

Heavy Claude Code users keep changing their setup: CLAUDE.md, skills, subagents, hooks, models. They have no reliable way to tell whether a change made their agent better or worse on their own repo, or why a long run went wrong. **[H]**
- Skills can hurt agents. A study of about 6,000 runs found that the best skills mainly avoided regressions **[V]** ([arXiv 2607.22520](https://arxiv.org/abs/2607.22520)).
- Setup packs with large, unmeasured claims are hugely popular (several have over 100k GitHub stars) **[V]**.
- Cost is a pain users have already validated: ccusage has 19k stars **[V]** ([repo](https://github.com/ryoppippi/ccusage)).

## Who it is for (initial)

An individual heavy Claude Code user who runs subagents and maintains their own setup **[D]**.

Not yet:
- **Teams wanting adoption and cost analytics.** Anthropic's own analytics and Datadog cover that **[V]**.
- **People building agent apps.** Langfuse, LangSmith, Laminar and Braintrust are strong there **[V]**.

## What is and isn't defensible

**Not defensible on its own.** Treat these as table stakes:
- **Capturing telemetry.** Claude Code exports OTel natively **[V]** ([docs](https://code.claude.com/docs/en/monitoring-usage)).
- **The hooks → SQLite → live UI architecture.** It already exists in a 1.5k-star MIT project **[V]**.
- **A spatial or pixel view of agents.** Pixel Agents has 9.8k stars **[V]**.
- **Replay alone.** zoetrope and Roundtable already ship it **[V]**.

**Defensible, because it compounds** **[H]**:
1. **Run diffs tied to outcomes:** tool calls, files touched, test results, tokens, cost, permission waits. OTel GenAI has no concept of files or test outcomes **[V]**.
2. **Local-first and live:** source code and prompts never leave the machine. Langfuse's Claude Code plugin ingests only after each response **[V]**.
3. **Cross-harness comparison:** the same task under Claude Code and Codex. Neither vendor has a reason to build this.
4. **Each user's own baseline history:** every past run becomes the baseline for the next change.

## Activation journey (the first 10 minutes)

1. Run one command to start Runloop. Install the Claude Code plugin.
2. Use Claude Code as normal. The session appears live: robots for the main agent and each subagent, the timeline, tool calls, failures.
3. Click a failure to reach the exact tool call and its output. Scrub the replay.
4. Pin the run as a baseline. After the next session, compare the two.

**Retention driver [H]:** comparing against a baseline after every setup change.

**Measure it:**
- the share of installers who come back on day 7;
- the share who use compare.

## Build order [D]

| Step | Scope | Status |
|---|---|---|
| 1 | Foundation: event model, recorder, replay, Studio, scripted demo | Done (verified, see `docs/status/current-state.md`) |
| 2 | **Claude Code tracer:** plugin, live ingest, subagents, provenance | Done (verified with real sessions, B6) |
| 3 | **Compare:** baselines and a side-by-side run diff (calls, files, tests, tokens, time) | Done (verified 2026-10-18, C1–C3); a real A/B session with targets is next |
| 2b | **Runloop Signature design system** (`docs/design/design-system.md`): tokens, components, IA, synchronised world/timeline/inspector, 2D graph fallback. Runs in parallel with 2 | Done (D1–D10) |
| 4 | Search, filter, metrics | Done (D7, D8) |
| 5 | **Codex CLI hooks** (second integration, same user, cross-harness); a documented adapter contract | Next |
| 6 | Headless A/B runner (`runloop ab`): N runs × setup variants, scored by tests | Later |
| 7 | OTLP/HTTP ingest bridge; OpenAI Agents SDK adapter | Later, on demand |

## Explicitly deferred

- Hosted cloud, accounts, billing, team workspaces.
- Production alerting and team analytics.
- LLM-judge eval frameworks; tests are the grader first.
- Re-run from a step (Laminar already does this for your own agent code **[V]**).
- New worlds and art packs, and features specific to Agent Teams (experimental, not available headless **[V]**).

## What would change this strategy

| If we see this | Then |
|---|---|
| Anthropic ships session compare, or extends skill-creator to whole setups | Lead with cross-harness comparison and local-first privacy |
| Fewer than ~10% of installers use compare after 2 weeks, but 3D clips get shared | Optimise for delight and distribution; accept weak monetisation |
| Demand is mostly team cost or adoption dashboards | Do not follow it; that market is served |
| Hook formats keep breaking | Make OTLP ingest the primary path |

## Monetisation hypothesis [H]

Everything local stays free and open source (Apache-2.0).

Paid features would be the ones where work becomes shared and ongoing:
- hosted, redacted replay links;
- team baselines and regression history;
- a CI check that fails a PR when a setup change makes agent outcomes worse.

Do not build billing yet. Test willingness to pay with a "share this replay" waitlist and a manual CI pilot with 3–5 teams.

## Top risks

1. **Platform absorption:** Anthropic ships native traces and analytics **[V]**.
2. **Hook payload churn** across Claude Code versions.
3. **Retention that rests on novelty.**
4. **Scope:** too much for a small team.
5. **Distribution** matters more than features.
6. **Secrets in traces:** redaction is required before anything is shared.
