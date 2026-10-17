# Coding mission (demo)

The mission `pnpm demo` and the Studio's "Run demo mission" button start.

## Files

| Path | Role |
| --- | --- |
| `mission.json` | Mission metadata: title, world, seed, adapter, and the scripted adapter's settings. |
| `repo/` | The starting repository. Each run copies it to `<data dir>/workspaces/<runId>/`, and every tool works on that copy. |
| `repo/test/task-store.test.js` | 12 `node:test` tests. |
| `repo/src/task-store.js` | A stub that throws `not implemented`. |
| `script/implement.buggy.js` | The Builder's first implementation. `listOpen()` keeps done tasks (`filter(t => t.done)`), which breaks exactly 2 tests. |
| `script/implement.fixed.js` | The Builder's fix: `filter(t => !t.done)`. |

`script/` is the scripted adapter's playbook, not part of the repository. It is never copied into a workspace.

## What happens in a run

The adapter's decisions are scripted: who does what, and which file contents the Builder writes. Every tool result is real.

1. The Coordinator creates T1 (research), T2 (code) and T3 (test).
2. The Researcher lists the repository, reads `README.md` and the test file, and tells the Builder what the suite expects.
3. The Builder writes `script/implement.buggy.js` into `src/task-store.js`.
4. The Tester runs `node --test --test-reporter=tap` in the workspace. It fails for real: **12 tests, 10 passed, 2 failed**.
   - T3 is blocked.
   - The Coordinator creates T4 (fix).
   - The Tester sends the real failing test names to the Builder.
5. The Builder writes the fix, and the Tester reruns the suite: **12 passed**. The run ends `succeeded`.

The branches follow the real results. If the first test run passes, there is no fix task. If the rerun still fails, T3 fails and the run ends `failed`.

## Checking the repository by hand

Run these from this directory:

```sh
tmp=$(mktemp -d) && cp -r repo/. "$tmp"
cp script/implement.buggy.js "$tmp/src/task-store.js" && (cd "$tmp" && node --test --test-reporter=tap)  # 10 pass, 2 fail
cp script/implement.fixed.js "$tmp/src/task-store.js" && (cd "$tmp" && node --test --test-reporter=tap)  # 12 pass
```
