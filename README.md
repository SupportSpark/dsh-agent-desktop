# dsh-agent-desktop

DeepSeek Harness plugin that drives desktop applications through the OS
accessibility tree, powered by [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)
(forked at [SupportSpark/agent-desktop](https://github.com/SupportSpark/agent-desktop), Apache-2.0).

One snapshot per observation, one ref per actionable element, one JSON envelope
per call. Nothing here re-implements desktop automation: the Rust binary owns
the platform work, this plugin only maps DSH tools onto its CLI.

## Why this instead of pixel matching

Every action names an element from a snapshot instead of a coordinate, so:

- **Refs are snapshot-scoped.** After the UI changes, a stale ref fails with
  `STALE_REF` instead of silently clicking whatever moved into that position.
- **Ambiguity is refused.** Several matching windows return `AMBIGUOUS_TARGET`
  with the candidate ids, rather than acting on a guess.
- **Actions report how they were delivered.** `delivered_verified` means the CLI
  read the result back; `delivered_unverified` means it acted but could not
  confirm; `ACTION_FAILED` / `POLICY_DENIED` explain themselves, with a
  `recovery` hint and a `disposition.retry` verdict.
- **Headless by default.** Ref actions go through the accessibility API without
  moving the pointer or stealing focus; `headed: true` opts into physical input.

## Requirements

- `agent-desktop` CLI: `npm install -g agent-desktop` (prebuilt binaries for
  macOS, Windows and Linux, x64 and arm64).
- Windows 10 1809+ in the interactive session of the signed-in user. No
  permission grant is required for apps at your terminal's integrity level;
  elevated (UIPI) targets refuse input.

The plugin resolves the binary in this order: `cliPath` config →
`AGENT_DESKTOP_BIN` → the npm global install for this platform → `agent-desktop`
on PATH.

## Install

```bash
dsh plugin --profile desktop add github:SupportSpark/dsh-agent-desktop
```

## Tools

| Tool | Purpose |
|---|---|
| `ad_status` | version, permissions, and what this platform refuses; call first |
| `ad_list_apps` | running GUI apps with pids |
| `ad_list_windows` | visible windows with ids and titles |
| `ad_snapshot` | accessibility tree with `@ref` ids for actionable elements |
| `ad_find` | search by role / name / value / text without a full snapshot |
| `ad_get` | read one property: text, value, title, bounds, role, states |
| `ad_click` | activate via the accessibility press action |
| `ad_set_value` | write an element value directly (preferred over typing) |
| `ad_type` | synthesize keystrokes (needs `headed`) |
| `ad_press` | key combo (`ctrl+s`, `return`) |
| `ad_scroll` | scroll or scroll-into-view |
| `ad_screenshot` | PNG of a window or a whole display |
| `ad_launch` | start an app, optionally waiting for its window |
| `ad_close_app` | quit gracefully, or force |
| `ad_wait` | wait for a duration, element, window, text or lifecycle event |
| `ad_clipboard` | get / set / clear the clipboard |
| `ad_run` | escape hatch: any CLI subcommand, verbatim |

`ad_run` exists on purpose: upstream adds commands faster than a plugin can
grow tools, so `ad_run({ command: "list-surfaces", args: "--app chrome.exe" })`
keeps the whole surface reachable without a new release here.

## The loop

```
ad_snapshot { app: "chrome.exe", interactive: true, compact: true }
  → 233 refs, each with available_actions
ad_click { ref: "@s1froqjbwkx2l6:e42" }        → delivered_verified
ad_snapshot { app: "chrome.exe" }               → confirm the result
```

Guidance that comes from the CLI's own skills, worth repeating:

- **Dense apps**: `skeleton: true` first, then `ad_snapshot` with `root: "@ref"`
  on the region you care about.
- **Slow apps** (Electron, Chromium before it settles): raise `timeoutMs`.
  The default snapshot deadline is 3 s and it will return `TIMEOUT`.
- **Prefer `ad_set_value` over `ad_type`**: no keystroke synthesis, no focus.
- **Scroll failures are real answers**: `ACTION_FAILED — the vertical axis is
  not scrollable` means the element genuinely does not scroll.

## Config

| Key | Default | Meaning |
|---|---|---|
| `cliPath` | auto | Path to the `agent-desktop` binary. |
| `timeoutMs` | `120000` | Default per-call deadline. |
| `snapshotTimeoutMs` | `30000` | Default snapshot deadline. |

## Notes

- Windows has no browser CDP lane here. For page-level browser work use the
  `browser-skill` plugin (`bsk_*` tools); this plugin is for native desktop
  windows.
- Snapshots, screenshots and clipboard reads can contain private desktop
  content — do not paste them into public logs.
