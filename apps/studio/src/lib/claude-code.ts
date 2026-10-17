import { DEFAULT_RUNTIME_HOST, DEFAULT_RUNTIME_PORT } from '@runloop-world/events';
import { normalizeApiBase, startRuntimeCommand } from './config';

/** Plugin location inside the Runloop repository (commands run from the repo root). */
export const PLUGIN_DIR = './integrations/claude-code-plugin';

/** Where the plugin posts when nothing overrides it (its `runtime_url` default). */
export const PLUGIN_DEFAULT_URL = `http://${DEFAULT_RUNTIME_HOST}:${DEFAULT_RUNTIME_PORT}`;

/** Commands from integrations/claude-code-plugin/README.md. */
export const CC = {
  pluginDir: `claude --plugin-dir ${PLUGIN_DIR}`,
  marketplaceAdd: '/plugin marketplace add argahv/runloop',
  marketplaceInstall: '/plugin install runloop-tracer@runloop',
  shellInstall: 'claude plugin install runloop-tracer@runloop --scope user',
  doctor: `node ${PLUGIN_DIR}/scripts/runloop-hook.mjs --doctor`,
  offForShell: 'RUNLOOP_TRACE=0 claude',
  disable: 'claude plugin disable runloop-tracer',
  uninstall: 'claude plugin uninstall runloop-tracer',
} as const;

/**
 * `RUNLOOP_URL=<url> ` when this Studio's runtime is not where the plugin posts
 * by default, so the plugin reaches the same runtime; '' otherwise.
 */
export function pluginUrlPrefix(apiBase: string): string {
  return normalizeApiBase(apiBase) === PLUGIN_DEFAULT_URL ? '' : `RUNLOOP_URL=${normalizeApiBase(apiBase)} `;
}

/** Start the runtime, then Claude Code with the plugin, both aimed at `apiBase`. */
export function connectCommands(apiBase: string): { serve: string; claude: string; doctor: string } {
  const prefix = pluginUrlPrefix(apiBase);
  return { serve: startRuntimeCommand(apiBase), claude: `${prefix}${CC.pluginDir}`, doctor: `${prefix}${CC.doctor}` };
}
