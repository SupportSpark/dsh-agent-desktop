/**
 * Thin process wrapper around the `agent-desktop` CLI.
 *
 * The CLI prints exactly one JSON envelope per invocation and uses the exit code
 * only as a coarse signal, so this module parses stdout regardless of exit status
 * and surfaces `ok:false` envelopes as ordinary results — an agent reads the
 * error code, recovery hint and disposition from the same shape as a success.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Names used by the npm package for its per-platform prebuilt binaries. */
const BINARY_NAMES = {
  'win32-x64': 'agent-desktop-win32-x64.exe',
  'win32-arm64': 'agent-desktop-win32-arm64.exe',
  'darwin-x64': 'agent-desktop-darwin-x64',
  'darwin-arm64': 'agent-desktop-darwin-arm64',
  'linux-x64': 'agent-desktop-linux-x64',
  'linux-arm64': 'agent-desktop-linux-arm64',
};

export class AgentDesktopError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AgentDesktopError';
    this.code = details.code;
    this.argv = details.argv;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.durationMs = details.durationMs;
  }
}

/**
 * Locate the CLI.
 *
 * Order: explicit config → AGENT_DESKTOP_BIN → the npm global install for this
 * platform → `agent-desktop` on PATH. The npm path is tried before PATH because
 * spawning a `.cmd` shim requires a shell, while the prebuilt binary does not.
 */
export function resolveCli(explicit) {
  const key = `${process.platform}-${process.arch}`;
  const binary = BINARY_NAMES[key];
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.AGENT_DESKTOP_BIN) candidates.push(process.env.AGENT_DESKTOP_BIN);
  if (binary) {
    const npmRoots = [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
      process.env.PREFIX && path.join(process.env.PREFIX, 'lib', 'node_modules'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
    ].filter(Boolean);
    for (const root of npmRoots) {
      candidates.push(path.join(root, 'agent-desktop', 'bin', binary));
    }
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  // Last resort: a PATH hit (may be a shell shim; run() falls back to a shell).
  return binary ? 'agent-desktop' : 'agent-desktop';
}

/**
 * Run one CLI command.
 *
 * @param {string} cli resolved binary (or `agent-desktop` on PATH)
 * @param {string[]} args argv passed verbatim
 * @param {{timeoutMs?: number, headed?: boolean, session?: string}} options
 * @returns {Promise<{envelope: object|null, stdout: string, stderr: string, code: number, durationMs: number}>}
 */
export function run(cli, args, { timeoutMs = 120000, headed = false, session } = {}) {
  // The CLI prints one JSON envelope by default — there is no `--json` flag.
  const argv = [];
  if (headed) argv.push('--headed');
  if (session) argv.push('--session', String(session));
  argv.push(...args);

  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      argv,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        // A `.cmd` shim needs a shell on Windows; the prebuilt binary does not.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli),
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

        let envelope = null;
        const trimmed = out.trim();
        if (trimmed) {
          try {
            envelope = JSON.parse(trimmed);
          } catch {
            // Some commands can emit a leading banner; try the last JSON line.
            const lastBrace = trimmed.lastIndexOf('{"version"');
            if (lastBrace >= 0) {
              try {
                envelope = JSON.parse(trimmed.slice(lastBrace));
              } catch {
                envelope = null;
              }
            }
          }
        }

        if (!envelope && error && error.killed) {
          reject(
            new AgentDesktopError(`agent-desktop ${args[0]} timed out after ${timeoutMs} ms`, {
              code: 'ETIMEDOUT',
              argv: [cli, ...argv],
              stdout: out,
              stderr: err,
              durationMs,
            }),
          );
          return;
        }
        if (!envelope && code !== 0) {
          reject(
            new AgentDesktopError(
              `agent-desktop ${args[0]} failed: ${(err || out || 'no output').trim().split(/\r?\n/)[0]}`,
              { code, argv: [cli, ...argv], stdout: out, stderr: err, durationMs },
            ),
          );
          return;
        }
        resolve({ envelope, stdout: out, stderr: err, code, durationMs });
      },
    );
  });
}
