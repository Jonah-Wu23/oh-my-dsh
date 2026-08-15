# Repository Atlas: oh-my-dsh

## Responsibility

An experimental DeepSeek Harness preset that keeps the main agent on a fixed
Minimal-shaped model surface while routing optional work through durable
plugin messages and a Bash capability CLI.

## System entry points

- `preset/agent.cordis.yml`: installable Harness composition.
- `preset/preset.yml`: preset name, description, and ordering.
- `preset/minimal-surface.mjs`: fixed `bash`, `str_replace_editor`, and
  `web_search` catalog filter with the optional native bundle outlet.
- `preset/zero-tool-bootstrap.mjs`: event-log-derived empty tool surface for
  the first top-level context-only request.
- `preset/anchor/turn-anchor.mjs`: durable multi-turn `We need…` injection.
- `preset/capability-runtime.mjs`: registry/router broker and capability
  message injection.
- `preset/capabilities/surface.mjs`: allowlisted native bundles, per-turn
  monotonic selection, and the execution-side hidden-tool gate.
- `preset/windows-msys2.mjs`: Windows stdio Bash backend.
- `bin/dshx.mjs`: Bash-facing capability bridge.
- `package.json`: zero-runtime-dependency test and CLI metadata.

## Data flow

1. Harness assembles the official Minimal persona and the three fixed tools;
   `zero-tool-bootstrap` strips them from the first top-level context-only
   request.
2. `minimal-surface` filters any accidental extra composition entries.
3. `agent/pre-step` receives claimed inbox messages. `capability-runtime` can
   route the latest real user message through a fresh Flash call and prepend a
   validated capability snapshot. `turn-anchor` inserts the fixed anchor before
   every real top-level user message after the first.
4. Harness appends those messages and request headers to the Session Event Log.
5. The main model calls capabilities through persistent Bash and `dshx`;
   `dshx` records capability-call/result facts when an event-log path is set.

## Directory map

| Directory | Responsibility | Detailed map |
|---|---|---|
| `preset/` | Installable Harness composition, routing, capability registry, and execution providers. | [`preset/codemap.md`](./preset/codemap.md) |
| `zero-anchored-standard/` | Earlier zero-tool comparison preset retained for historical evaluation. | [`zero-anchored-standard/codemap.md`](./zero-anchored-standard/codemap.md) |
| `test/` | Node built-in tests for the fixed surface, event projections, router, registry, and shell primitives. | Tests are named by subsystem. |
| `bin/` | Local Bash-facing capability CLI. | `bin/dshx.mjs` |
| `docs/` | User-owned development plan and supporting documents. | Read `docs/plan.md` before expanding scope. |
