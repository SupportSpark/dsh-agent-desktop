/**
 * Model-facing tools.
 *
 * Two layers on purpose:
 *  - typed tools for the observe → act → observe loop an agent actually runs,
 *    each returning the CLI's JSON envelope plus a compact text summary;
 *  - `ad_run`, which forwards any CLI command verbatim, so an upstream release
 *    that adds commands stays reachable without shipping a new plugin version.
 */

const MAX_OUTPUT_CHARS = 12000;

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: value && value.summary ? value.summary : JSON.stringify(value, null, 2) },
  ],
};

/** Flatten one accessibility node into `role name @ref` lines. */
function renderTree(node, depth, lines, maxNodes) {
  if (!node || lines.length >= maxNodes) return;
  const indent = '  '.repeat(depth);
  const label = node.name ? ` "${node.name}"` : '';
  const ref = node.ref_id ? ` ${node.ref_id}` : '';
  const value = node.value !== undefined && node.value !== null && node.value !== '' ? ` = ${JSON.stringify(node.value)}` : '';
  const actions = Array.isArray(node.available_actions) && node.available_actions.length
    ? ` [${node.available_actions.join(',')}]`
    : '';
  lines.push(`${indent}${node.role ?? '?'}${label}${value}${ref}${actions}`);
  for (const child of node.children ?? []) renderTree(child, depth + 1, lines, maxNodes);
}

/** Turn an envelope into a compact, decision-ready summary. */
function summarize(command, envelope, args = {}) {
  if (!envelope) return `${command}: no JSON envelope returned`;
  if (envelope.ok === false) {
    const e = envelope.error ?? {};
    const recovery = e.recovery ? ` | recovery=${e.recovery.strategy}${e.recovery.retryable ? ' (retryable)' : ''}` : '';
    const disposition = e.disposition?.delivery ? ` | delivery=${e.disposition.delivery}` : '';
    return `${command} FAILED: ${e.code ?? 'ERROR'} — ${e.message ?? ''}${recovery}${disposition}` +
      (e.suggestion ? `\nhint: ${e.suggestion}` : '');
  }
  const d = envelope.data ?? {};

  switch (command) {
    case 'version':
      return `agent-desktop ${d.version} (protocol ${envelope.version}, ${d.os}/${d.target})`;
    case 'status':
    case 'permissions':
      return `${command}: ${truncate(JSON.stringify(d, null, 2))}`;
    case 'list-apps': {
      const apps = d.apps ?? [];
      return apps.length
        ? `apps (${apps.length}):\n${apps.map((a) => `  ${a.name}  pid=${a.pid}${a.presentation ? ` (${a.presentation})` : ''}`).join('\n')}`
        : 'no GUI applications running';
    }
    case 'list-windows': {
      const rows = Array.isArray(d) ? d : d.windows ?? [];
      return rows.length
        ? `windows (${rows.length}):\n${rows.map((w) => `  ${w.id ?? '?'}  "${w.title ?? ''}"${w.app_name ? `  [${w.app_name}]` : ''}${w.minimized ? '  (minimized)' : ''}${w.is_focused ? '  *focused' : ''}`).join('\n')}`
        : 'no visible windows';
    }
    case 'list-displays': {
      const rows = Array.isArray(d) ? d : d.displays ?? [];
      return rows.length
        ? `displays (${rows.length}):\n${rows.map((x) => {
            const b = x.bounds ?? {};
            return `  ${x.id ?? '?'}  ${b.width ?? '?'}x${b.height ?? '?'} at (${b.x ?? 0},${b.y ?? 0})  scale=${x.scale ?? 1}${x.is_primary ? '  (primary)' : ''}`;
          }).join('\n')}`
        : 'no displays reported';
    }
    case 'list-surfaces': {
      const rows = d.surfaces ?? [];
      return rows.length
        ? `surfaces (${rows.length}):\n${rows.map((s) => `  ${s.type ?? '?'}  ${s.id ?? ''}  "${s.title ?? ''}"${s.item_count !== undefined ? `  items=${s.item_count}` : ''}`).join('\n')}`
        : 'no surfaces';
    }
    case 'snapshot': {
      const w = d.window ?? {};
      const lines = [
        `snapshot ${d.snapshot_id}  app=${d.app ?? args.app ?? '?'}  window="${w.title ?? ''}"`,
        `refs=${d.ref_count}  complete=${d.complete}`,
      ];
      const treeLines = [];
      renderTree(d.tree, 0, treeLines, 120);
      lines.push(...treeLines);
      if (treeLines.length >= 120) lines.push('… [tree truncated; narrow with --root or --skeleton]');
      return lines.join('\n');
    }
    case 'find': {
      const rows = d.matches ?? d.elements ?? [];
      return Array.isArray(rows) && rows.length
        ? `matches (${rows.length}):\n${rows.map((m) => `  ${m.role ?? '?'}${m.name ? ` "${m.name}"` : ''} ${m.ref_id ?? ''}`).join('\n')}`
        : truncate(JSON.stringify(d, null, 2));
    }
    case 'screenshot':
      return `screenshot ${d.path ?? ''} ${d.width ? `${d.width}x${d.height}` : ''}`.trim();
    default: {
      if (Array.isArray(d)) {
        return `${command} (${d.length}):\n${d.slice(0, 40).map((x) => `  ${JSON.stringify(x)}`).join('\n')}${d.length > 40 ? '\n  …' : ''}`;
      }
      const delivery = d.delivery ?? d.disposition?.delivery;
      const head = delivery ? `${command}: ${delivery}` : `${command}: ok`;
      const extra = Object.keys(d).length ? `\n${truncate(JSON.stringify(d, null, 2), 2000)}` : '';
      return head + extra;
    }
  }
}

/** Build a tool that maps 1:1 onto one CLI command. */
function commandTool({ name, command, description, parameters = {}, fixed = [], argMap, timeoutMs = 120000, render }) {
  return {
    name,
    description,
    parameters,
    timeoutMs,
    output: objectOutput,
    async execute(args, runtime) {
      const argv = [...fixed];
      const extra = argMap ? argMap(args) : [];
      argv.push(...extra);
      const result = await runtime.run(command, argv, {
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : timeoutMs,
        headed: Boolean(args.headed),
      });
      const summary = render
        ? render(result.envelope, args, result)
        : summarize(command, result.envelope, args);
      return {
        command,
        ok: result.envelope?.ok ?? false,
        data: result.envelope?.data ?? null,
        error: result.envelope?.error ?? null,
        durationMs: result.durationMs,
        summary,
      };
    },
  };
}

/**
 * Build tool definitions bound to one runtime (`{ run, cli }`).
 * @param {(def: any) => any} defineToolFactory
 * @param {{run: Function, cli: string}} runtime
 */
export function createToolDefs(defineToolFactory, runtime) {
  const appParam = { type: 'string', description: 'Application name as reported by ad_list_apps (e.g. "chrome.exe", "notepad").' };
  const refParam = { type: 'string', description: 'Element ref from the latest snapshot, e.g. @s8f3k2p9:e8. Refs are snapshot-scoped; a stale ref fails with STALE_REF.' };
  const timeoutParam = { type: 'number', description: 'Operation deadline in milliseconds (default 30000 for snapshots, 120000 for actions).' };
  const headedParam = { type: 'boolean', description: 'Allow physical input and foreground activation. Off by default: ref actions stay semantic and never move the pointer.' };

  return [
    commandTool({
      name: 'ad_status',
      command: 'status',
      description: 'Health of the agent-desktop CLI on this machine: version, OS/permissions, and what the platform refuses. Call this first in a fresh session.',
      parameters: {},
    }),

    commandTool({
      name: 'ad_list_apps',
      command: 'list-apps',
      description: 'Every running GUI application with its pid. Use the reported name for the `app` parameter of other tools.',
      parameters: { app: { type: 'string', description: 'Filter by application name substring.' } },
      argMap: (a) => (a.app ? ['--app', String(a.app)] : []),
    }),

    commandTool({
      name: 'ad_list_windows',
      command: 'list-windows',
      description: 'Visible windows with their window ids and titles. Pass a window id to ad_snapshot when a snapshot is ambiguous.',
      parameters: { app: { type: 'string', description: 'Only windows of this application.' } },
      argMap: (a) => (a.app ? ['--app', String(a.app)] : []),
    }),

    commandTool({
      name: 'ad_snapshot',
      command: 'snapshot',
      description:
        'Capture an app\'s accessibility tree as JSON with a ref for every actionable element, then act on those refs. Refs belong to their snapshot: after the UI changes, take a new snapshot. Dense apps: use skeleton=true first, then snapshot with root=<ref>.',
      parameters: {
        app: appParam,
        windowId: { type: 'string', description: 'Target one window id from ad_list_windows (needed when several windows match).' },
        root: refParam,
        surface: { type: 'string', description: 'Accessibility surface to read: window, focused, menu, sheet.' },
        skeleton: { type: 'boolean', description: 'Map the structure only, without every actionable leaf.' },
        compact: { type: 'boolean', description: 'Compact layout (recommended with skeleton).' },
        interactive: { type: 'boolean', description: 'Only elements an agent can act on (implies -i).' },
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [];
        if (a.app) out.push('--app', String(a.app));
        if (a.windowId) out.push('--window-id', String(a.windowId));
        if (a.root) out.push('--root', String(a.root));
        if (a.surface) out.push('--surface', String(a.surface));
        if (a.skeleton) out.push('--skeleton');
        if (a.compact) out.push('--compact');
        if (a.interactive) out.push('-i');
        return out;
      },
      timeoutMs: 30000,
    }),

    commandTool({
      name: 'ad_find',
      command: 'find',
      description: 'Search elements by role, name, value or text content without a full snapshot. Narrow with root/surface when it times out.',
      parameters: {
        app: appParam,
        role: { type: 'string', description: 'Element role, e.g. button, treeitem, textbox.' },
        name: { type: 'string', description: 'Element name/title substring.' },
        value: { type: 'string', description: 'Element value substring.' },
        text: { type: 'string', description: 'Text content substring.' },
        root: refParam,
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [];
        if (a.app) out.push('--app', String(a.app));
        if (a.role) out.push('--role', String(a.role));
        if (a.name) out.push('--name', String(a.name));
        if (a.value) out.push('--value', String(a.value));
        if (a.text) out.push('--text', String(a.text));
        return out;
      },
      timeoutMs: 30000,
    }),

    commandTool({
      name: 'ad_get',
      command: 'get',
      description: 'Read one property of an element: text, value, title, bounds, role, states.',
      parameters: {
        ref: { ...refParam, required: true },
        property: { type: 'string', description: 'text (default), value, title, bounds, role, states.' },
      },
      argMap: (a) => {
        const out = [String(a.ref)];
        if (a.property) out.push('--property', String(a.property));
        return out;
      },
      timeoutMs: 30000,
    }),

    commandTool({
      name: 'ad_click',
      command: 'click',
      description: 'Activate an element through its accessibility press action. Semantic and headless by default; pass headed=true for a physical click.',
      parameters: {
        ref: { ...refParam, required: true },
        app: appParam,
        timeoutMs: timeoutParam,
        headed: headedParam,
      },
      argMap: (a) => {
        const out = [String(a.ref)];
        if (a.timeoutMs) { out.push('--timeout-ms', String(a.timeoutMs)); delete a.timeoutMs; }
        return out;
      },
    }),

    commandTool({
      name: 'ad_set_value',
      command: 'set-value',
      description: 'Set an element value directly through its accessibility attribute. Preferred over ad_type: it needs no keystroke synthesis and no foreground focus.',
      parameters: {
        ref: { ...refParam, required: true },
        value: { type: 'string', description: 'New value.', required: true },
        app: appParam,
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [String(a.ref), String(a.value)];
        if (a.timeoutMs) { out.push('--timeout-ms', String(a.timeoutMs)); delete a.timeoutMs; }
        return out;
      },
    }),

    commandTool({
      name: 'ad_type',
      command: 'type',
      description: 'Insert text as synthesized keystrokes. Requires headed=true; prefer ad_set_value when the element exposes a value.',
      parameters: {
        ref: { ...refParam, required: true },
        text: { type: 'string', description: 'Text to type.', required: true },
        app: appParam,
        timeoutMs: timeoutParam,
        headed: headedParam,
      },
      argMap: (a) => {
        const out = [String(a.ref), String(a.text)];
        if (a.timeoutMs) { out.push('--timeout-ms', String(a.timeoutMs)); delete a.timeoutMs; }
        return out;
      },
    }),

    commandTool({
      name: 'ad_press',
      command: 'press',
      description: 'Send a key combo (return, escape, ctrl+c, shift+tab). Shell-reserved combos (alt+f4, win+l, …) are refused unless force=true.',
      parameters: {
        keys: { type: 'string', description: 'Key combo, e.g. "ctrl+s" or "return".', required: true },
        windowId: { type: 'string', description: 'Target the application instance that owns this window id (needed when several instances share one name).' },
        force: { type: 'boolean', description: 'Send the combo even if it is a dangerous shell shortcut.' },
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [String(a.keys)];
        if (a.windowId) out.push('--window-id', String(a.windowId));
        if (a.force) out.push('--force');
        return out;
      },
    }),

    commandTool({
      name: 'ad_scroll',
      command: 'scroll',
      description: 'Scroll an element. Pass scrollTo=true to scroll it into view instead.',
      parameters: {
        ref: { ...refParam, required: true },
        direction: { type: 'string', description: 'up, down, left, right (default down).' },
        amount: { type: 'number', description: 'Scroll amount, in pages or units as the app defines.' },
        app: appParam,
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [String(a.ref)];
        if (a.direction) out.push('--direction', String(a.direction));
        if (a.amount !== undefined) out.push('--amount', String(a.amount));
        if (a.timeoutMs) { out.push('--timeout-ms', String(a.timeoutMs)); delete a.timeoutMs; }
        return out;
      },
    }),

    commandTool({
      name: 'ad_screenshot',
      command: 'screenshot',
      description: 'PNG of an application window. Use it only when the accessibility tree is thin (canvas, games, custom-drawn UI); otherwise prefer ad_snapshot.',
      parameters: {
        app: appParam,
        windowId: { type: 'string', description: 'Target one window id.' },
        output: { type: 'string', description: 'Destination path for the PNG.' },
        screen: { type: 'number', description: 'Capture a whole display by index from ad_run list-displays (0 = primary) instead of one window.' },
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [];
        if (a.app) out.push('--app', String(a.app));
        if (a.windowId) out.push('--window-id', String(a.windowId));
        if (a.screen !== undefined) out.push('--screen', String(a.screen));
        if (a.output) out.push(String(a.output));
        return out;
      },
    }),

    commandTool({
      name: 'ad_launch',
      command: 'launch',
      description: 'Start an application. Takes an absolute path or a bare executable name (notepad, notepad.exe) — not a display name.',
      parameters: {
        target: { type: 'string', description: 'Executable path or bare name.', required: true },
        args: { type: 'string', description: 'Command-line arguments for the app.' },
        activate: { type: 'boolean', description: 'Bring the app forward and wait for a window before returning.' },
        cwd: { type: 'string', description: 'Working directory for the launched process.' },
        headed: headedParam,
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [String(a.target)];
        if (a.args) {
          for (const token of String(a.args).match(/"[^"]*"|\S+/g) ?? []) {
            out.push('--arg', token.replace(/^"|"$/g, ''));
          }
        }
        if (a.activate) out.push('--activate');
        if (a.cwd) out.push('--cwd', String(a.cwd));
        return out;
      },
    }),

    commandTool({
      name: 'ad_close_app',
      command: 'close-app',
      description: 'Quit an application gracefully; force=true terminates it.',
      parameters: {
        app: { ...appParam, required: true },
        force: { type: 'boolean', description: 'Terminate instead of asking the app to quit.' },
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [String(a.app)];
        if (a.force) out.push('--force');
        return out;
      },
    }),

    commandTool({
      name: 'ad_wait',
      command: 'wait',
      description: 'Wait for a duration or a condition: element, window, text, menu, menu-closed, event, notification.',
      parameters: {
        ms: { type: 'number', description: 'Milliseconds to wait.' },
        element: { type: 'string', description: 'Wait until this ref exists.' },
        window: { type: 'string', description: 'Wait until a window matching this title exists.' },
        text: { type: 'string', description: 'Wait until this text is present.' },
        event: {
          type: 'string',
          description: 'Wait for a desktop lifecycle signal: window-opened, window-closed, app-launched, app-terminated, focus-changed, surface-appeared, surface-dismissed.',
        },
        timeoutMs: timeoutParam,
      },
      argMap: (a) => {
        const out = [];
        if (a.ms !== undefined) out.push(String(a.ms));
        if (a.element) out.push('--element', String(a.element));
        if (a.window) out.push('--window', String(a.window));
        if (a.text) out.push('--text', String(a.text));
        if (a.event) out.push('--event', String(a.event));
        return out;
      },
    }),

    {
      name: 'ad_clipboard',
      description:
        'Clipboard access: action=get reads it (text by default), set writes text, clear empties it. Reading images needs ad_run with clipboard-get --format image.',
      parameters: {
        action: { type: 'string', description: 'get (default), set or clear.', required: true },
        value: { type: 'string', description: 'Text to write for action=set.' },
        format: { type: 'string', description: 'Read format for action=get: text (default), auto, image, file-urls.' },
        out: { type: 'string', description: 'Destination path when reading image content.' },
        timeoutMs: timeoutParam,
      },
      output: objectOutput,
      timeoutMs: 60000,
      async execute(args, runtime) {
        const action = String(args.action ?? 'get').trim();
        const command = action === 'set' ? 'clipboard-set' : action === 'clear' ? 'clipboard-clear' : 'clipboard-get';
        const argv = [];
        if (command === 'clipboard-set') {
          if (args.value !== undefined) argv.push(String(args.value));
        } else if (command === 'clipboard-get') {
          if (args.format) argv.push('--format', String(args.format));
          if (args.out) argv.push('--out', String(args.out));
        }
        const result = await runtime.run(command, argv, {
          timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 60000,
        });
        const env = result.envelope;
        let summary;
        if (env?.ok === false) summary = summarize(command, env, args);
        else if (command === 'clipboard-get') {
          const text = env?.data?.text ?? env?.data?.content ?? env?.data;
          summary = `clipboard-get: ${typeof text === 'string' ? JSON.stringify(text) : truncate(JSON.stringify(env?.data ?? null), 1500)}`;
        } else {
          summary = `${command}: ${env?.data?.disposition?.delivery ?? 'ok'}`;
        }
        return {
          command,
          ok: env?.ok ?? false,
          data: env?.data ?? null,
          error: env?.error ?? null,
          durationMs: result.durationMs,
          summary,
        };
      },
    },

    {
      name: 'ad_run',
      command: 'run',
      description:
        'Escape hatch: forward any agent-desktop subcommand verbatim and return its JSON envelope. Use it for commands without a typed tool (list-displays, list-surfaces, open-system-surface, list-notifications, resize-window, focus-window, check/uncheck, expand/collapse, drag, hover, mouse-wheel, batch, session, trace …). Run ad_status or pass args ["--help"] to discover flags.',
      parameters: {
        command: { type: 'string', description: 'Subcommand, e.g. list-displays.', required: true },
        args: { type: 'string', description: 'Arguments as one space-separated string; quote values that contain spaces.' },
        headed: headedParam,
        timeoutMs: timeoutParam,
      },
      output: objectOutput,
      timeoutMs: 300000,
      async execute(args, runtime) {
        const argv = [];
        if (args.args) {
          for (const token of String(args.args).match(/"[^"]*"|\S+/g) ?? []) {
            argv.push(token.replace(/^"|"$/g, ''));
          }
        }
        const result = await runtime.run(String(args.command), argv, {
          timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 300000,
          headed: Boolean(args.headed),
        });
        return {
          command: String(args.command),
          ok: result.envelope?.ok ?? false,
          data: result.envelope?.data ?? null,
          error: result.envelope?.error ?? null,
          durationMs: result.durationMs,
          summary: summarize(String(args.command), result.envelope, args),
        };
      },
    },
  ];
}
