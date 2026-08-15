# preset/

## Responsibility

Contains the installable Harness preset and the runtime seams behind its fixed
Minimal model surface.

## Design

- `agent.cordis.yml` composes the official Minimal persona, persistent Bash,
  `str_replace_editor`, resident `web_search`, the fixed-surface filter, the
  turn anchor, and the hidden capability runtime.
- `minimal-surface.mjs` is a deny-by-default catalog projection ordered by the
  explicit Minimal contract.
- `zero-tool-bootstrap.mjs` removes the top-level tool schemas for the first
  context-only request and restores them after a durable `assistant/message`.
- `anchor/turn-anchor.mjs` and `events/projections.mjs` derive turn state from
  durable events instead of process-local counters.
- `router/` validates a Flash classifier result, caches equal snapshots, and
  falls back to the last validated choice.
- `capabilities/` owns manifest validation, lifecycle registration, and the
  compact model-facing capability descriptions. `capabilities/surface.mjs`
  owns the opt-in native bundle allowlist, per-turn monotonic selection, and
  execution-side denial for hidden tools.
- `windows-msys2.mjs` implements the `ctx.terminals` backend contract with a
  persistent stdio Bash process; `shell/path-map.mjs` hides host paths behind
  `/workspace` in command output.

## Integration points

- Harness `system-prompt/assemble` receives the fixed catalog filter.
- Harness `agent/pre-step` receives queued and steering messages before they
  are appended to the session log.
- Harness `ctx.llm` is optional for the fresh V4 Flash router call.
- Harness `ctx.get('tools')` receives the native surface execution guard when
  the tool runtime is available.
- Harness `ctx.terminals` receives the Linux or Windows `shell` backend.
- `bin/dshx.mjs` consumes the static capability manifests and external provider
  bridge.
