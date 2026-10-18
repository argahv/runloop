import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactKind, TestMetrics, ToolFailureType } from '@runloop-world/events';
import { abortError, isAbortError, type ToolCall, type ToolResult } from './adapter';
import type { Recorder } from './recorder';
import { runCommand } from './sandbox/command';
import { ToolReportedError, listFiles, readWorkspaceFile, writeWorkspaceFile } from './sandbox/fs-tools';
import { SandboxError } from './sandbox/paths';
import { formatTestSummary, parseTap } from './sandbox/tap';

export interface ToolInvokerOptions {
  recorder: Recorder;
  runId: string;
  workspaceDir: string;
  signal: AbortSignal;
  commandTimeoutMs?: number;
}

interface ArtifactOut {
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  content: string;
  path?: string;
  summary: string;
}

/** What actually happened when the tool ran (becomes tool.call_completed). */
interface Executed {
  status: 'success' | 'error';
  outputSummary: string;
  exitCode?: number;
  metrics?: TestMetrics;
  failingTests?: string[];
  errorType?: string;
  artifacts?: ArtifactOut[];
  output?: string;
}

class ToolFailure extends Error {
  constructor(
    readonly errorType: ToolFailureType,
    message: string,
  ) {
    super(message);
  }
}

const MEDIA_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

export function describeInput(call: ToolCall): string {
  switch (call.tool) {
    case 'list_files':
      return call.path ?? '.';
    case 'read_file':
    case 'write_file':
      return call.path;
    case 'run_command':
      return call.argv.join(' ');
  }
}

/**
 * What a call acts on (tool.call_started `target`): the workspace-relative
 * path for the file tools, the program's base name for run_command.
 */
export function targetOf(call: ToolCall): string {
  switch (call.tool) {
    case 'list_files':
      return path.posix.normalize((call.path ?? '.').split(path.sep).join('/'));
    case 'read_file':
    case 'write_file':
      return path.posix.normalize(call.path.split(path.sep).join('/'));
    case 'run_command':
      return path.basename(call.argv[0] ?? '') || 'command';
  }
}

/**
 * Runs tools inside one run's workspace and records them. Every
 * tool.call_started gets exactly one terminal event (completed or failed),
 * linked to it by parentEventId, with any artifact.created events in between.
 * Call ids (call-N) and artifact ids (art-N) are numbered per run.
 */
export class ToolInvoker {
  private callN = 0;
  private artifactN = 0;
  private readonly workspaceReal: string;

  constructor(private readonly opts: ToolInvokerOptions) {
    this.workspaceReal = realpathSync(opts.workspaceDir);
  }

  async invoke(agentId: string, taskId: string, call: ToolCall): Promise<ToolResult> {
    const { recorder, runId, signal } = this.opts;
    if (signal.aborted) throw abortError();
    const callId = `call-${++this.callN}`;
    const started = recorder.append(runId, {
      type: 'tool.call_started',
      payload: { callId, agentId, taskId, tool: call.tool, inputSummary: this.scrubPaths(describeInput(call)), target: this.scrubPaths(targetOf(call)).slice(0, 300) },
    });
    const link = { actorId: agentId, taskId, parentEventId: started.eventId };
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);

    const fail = (errorType: ToolFailureType, message: string): ToolResult => {
      const durationMs = elapsed();
      const msg = this.scrubPaths(message);
      recorder.append(runId, { type: 'tool.call_failed', payload: { callId, errorType, message: msg, durationMs }, ...link });
      return { callId, status: 'failed', durationMs, outputSummary: msg, errorType, artifactIds: [] };
    };

    let result: Executed;
    try {
      result = await this.execute(call);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        fail('aborted', 'The run was stopped while the tool was running');
        throw abortError();
      }
      const [errorType, message] = classify(err);
      return fail(errorType, message);
    }

    // Persist outputs, then the completion. If storing fails, the call still ends (as failed).
    const artifactIds: string[] = [];
    try {
      for (const a of result.artifacts ?? []) {
        const artifactId = `art-${++this.artifactN}`;
        const { bytes, sha256 } = recorder.putArtifactContent(runId, artifactId, a.content);
        recorder.append(runId, {
          type: 'artifact.created',
          payload: {
            artifactId,
            kind: a.kind,
            name: a.name,
            mediaType: a.mediaType,
            bytes,
            sha256,
            ...(a.path ? { path: a.path } : {}),
            producedByCallId: callId,
            summary: a.summary,
          },
          ...link,
        });
        artifactIds.push(artifactId);
      }
    } catch (err) {
      return fail('exception', `Could not store the tool output: ${err instanceof Error ? err.message : String(err)}`);
    }
    const durationMs = elapsed();
    const outputSummary = this.scrubPaths(result.outputSummary);
    recorder.append(runId, {
      type: 'tool.call_completed',
      payload: {
        callId,
        status: result.status,
        durationMs,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        outputSummary,
        ...(result.metrics ? { metrics: result.metrics } : {}),
        ...(result.failingTests?.length ? { failingTests: result.failingTests } : {}),
        ...(artifactIds.length ? { outputArtifactIds: artifactIds } : {}),
        ...(result.errorType ? { errorType: result.errorType } : {}),
      },
      ...link,
    });
    return {
      callId,
      status: result.status,
      durationMs,
      outputSummary,
      ...(result.errorType ? { errorType: result.errorType } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.metrics ? { metrics: result.metrics } : {}),
      ...(result.failingTests ? { failingTests: result.failingTests } : {}),
      artifactIds,
      ...(result.output !== undefined ? { output: result.output } : {}),
    };
  }

  private async execute(call: ToolCall): Promise<Executed> {
    const ws = this.opts.workspaceDir;
    try {
      switch (call.tool) {
        case 'list_files': {
          const { entries, truncated } = listFiles(ws, call.path ?? '.');
          return {
            status: 'success',
            outputSummary: `${entries.length} entries${truncated ? ' (truncated)' : ''}`,
            output: entries.join('\n'),
          };
        }
        case 'read_file': {
          const { content, bytes } = readWorkspaceFile(ws, call.path);
          return { status: 'success', outputSummary: `read ${bytes} bytes`, output: content };
        }
        case 'write_file': {
          const { bytes } = writeWorkspaceFile(ws, call.path, call.content);
          const rel = path.posix.normalize(call.path.split(path.sep).join('/'));
          return {
            status: 'success',
            outputSummary: `wrote ${bytes} bytes`,
            artifacts: [
              {
                kind: 'file',
                name: path.posix.basename(rel),
                mediaType: MEDIA_TYPES[path.extname(rel)] ?? 'text/plain',
                content: call.content,
                path: rel,
                summary: call.summary ?? `${rel} (${bytes} bytes)`,
              },
            ],
          };
        }
        case 'run_command':
          return await this.runCommand(call.argv);
      }
    } catch (err) {
      if (err instanceof ToolReportedError) {
        return { status: 'error', outputSummary: err.message, errorType: err.errorType };
      }
      throw err;
    }
  }

  private async runCommand(argv: string[]): Promise<Executed> {
    let r;
    try {
      r = await runCommand(argv, {
        cwd: this.opts.workspaceDir,
        signal: this.opts.signal,
        ...(this.opts.commandTimeoutMs !== undefined ? { timeoutMs: this.opts.commandTimeoutMs } : {}),
      });
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throw new ToolFailure('spawn_error', err instanceof Error ? err.message : String(err));
    }
    if (r.aborted) throw abortError();
    if (r.timedOut) throw new ToolFailure('timeout', `Timed out after ${r.durationMs} ms; the process was killed`);

    const output = this.scrubPaths(r.stderr ? `${r.stdout}\n# stderr:\n${r.stderr}` : r.stdout);
    const tap = parseTap(r.stdout);
    const ok = r.exitCode === 0;
    const exitText = r.exitCode !== null ? `exit ${r.exitCode}` : `killed by ${r.signal ?? 'signal'}`;
    const errorType = ok ? undefined : tap.metrics && tap.metrics.failed > 0 ? 'tests_failed' : 'exit_nonzero';
    return {
      status: ok ? 'success' : 'error',
      ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}),
      outputSummary: tap.metrics ? formatTestSummary(tap.metrics) : exitText,
      ...(tap.metrics ? { metrics: tap.metrics } : {}),
      ...(tap.failingTests.length ? { failingTests: tap.failingTests } : {}),
      ...(errorType ? { errorType } : {}),
      output,
      artifacts: [
        {
          kind: tap.metrics ? 'test_report' : 'log',
          name: tap.metrics ? 'test-output.tap' : 'command-output.log',
          mediaType: 'text/plain',
          content: r.truncated ? `${output}\n# [output truncated]\n` : output,
          summary: `${argv[0] === 'node' && argv[1] === '--test' ? 'node --test' : argv[0]} output (${exitText})`,
        },
      ],
    };
  }

  /** Replace the absolute workspace path (it appears in stack traces) with "<workspace>". */
  private scrubPaths(text: string): string {
    let out = text;
    for (const p of new Set([this.workspaceReal, path.resolve(this.opts.workspaceDir)])) out = out.split(p).join('<workspace>');
    return out;
  }
}

function classify(err: unknown): [ToolFailureType, string] {
  if (err instanceof ToolFailure) return [err.errorType, err.message];
  if (err instanceof SandboxError) return ['denied', err.message];
  return ['exception', err instanceof Error ? err.message : String(err)];
}
