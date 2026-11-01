/**
 * dsh-agent-desktop — Cordis plugin entry.
 *
 * Registers `ad_*` tools that drive desktop applications through
 * vercel-labs/agent-desktop: an accessibility-tree snapshot per observation, a
 * ref per actionable element, and one JSON envelope per CLI call. Nothing here
 * re-implements desktop automation — the Rust binary owns that.
 *
 * The CLI is a plain process, so the tools register directly instead of going
 * through an MCP server: one less child process, and DSH's own schemas.
 */

import { resolveCli, run as runCli } from './cli.js';
import { createToolDefs } from './tools.js';

export const name = 'dsh-agent-desktop';

/** Services used by this plugin. */
export const inject = ['tools'];

/**
 * `defineTool` compiles the parameter/output shorthand into JSON Schema. Under
 * DSH the module specifier is mapped by the loader; the identity fallback only
 * exists so the package can be self-tested outside DSH, and `apply()` says so.
 */
let defineTool = (definition) => definition;
let defineToolSource = 'fallback';
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (typeof mod.defineTool === 'function') {
    defineTool = mod.defineTool;
    defineToolSource = 'dsh-tools';
  }
} catch {
  /* outside the DSH loader; apply() warns */
}

const DEFAULTS = {
  cliPath: undefined,
  timeoutMs: 120000,
  snapshotTimeoutMs: 30000,
};

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const cli = resolveCli(settings.cliPath);
  const logger = ctx.logger;

  if (defineToolSource !== 'dsh-tools') {
    try {
      ctx.logger?.warn(
        'dsh-agent-desktop: @deepseek-ai/dsh-tools did not resolve, so ad_* tools are registered without compiled schemas. ' +
          'This only happens outside a DSH boot; install the plugin through the profile plugin manager.',
      );
    } catch {
      /* logging must never break mounting */
    }
  }

  const runtime = {
    cli,
    /** Run one CLI command with the plugin-level defaults applied. */
    run: (command, args, { timeoutMs, headed } = {}) =>
      runCli(cli, [command, ...args], {
        timeoutMs: timeoutMs ?? settings.timeoutMs,
        headed: Boolean(headed),
      }),
    logger,
  };

  const disposers = [];
  ctx.effect(() => {
    const definitions = createToolDefs(defineTool, runtime);
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition));
    }
    logger?.info?.(
      'dsh-agent-desktop: registered %d ad_* tools against %s',
      definitions.length,
      cli,
    );
    return () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose?.();
        } catch {
          /* disposal must not throw during teardown */
        }
      }
    };
  }, 'dsh-agent-desktop: ad_* tools');

  return { cli, runtime };
}

export { resolveCli, createToolDefs, runCli as runAgentDesktop };
