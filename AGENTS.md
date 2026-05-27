# AGENTS.md

Working notes for agentic agents (and humans) contributing to **fleet-state-mgr**.

## What this repo is

A Model Context Protocol (MCP) server, written in TypeScript and distributed via `npx`. It exposes 13 tools that let an Orchestrator agent and its Sub-Agents share state — caches, decisions, results, artifacts, summaries — through an on-disk directory tree (`.ai-fleet-state/` by default).

The user-facing description and tool catalogue live in `README.md`. The original internal design doc (`DESIGN.md`) is the spec of record; it lives in the working tree but is **gitignored** and not shipped — treat it as the source of truth when in doubt, but never commit it.

## Tech stack & conventions

- **Runtime**: Node ≥ 18, ESM (`"type": "module"`).
- **Language**: TypeScript with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- **Module system**: `NodeNext`. **Always use `.js` extensions in relative imports** (e.g. `import { StateManager } from './state.js'`), even when importing from `.ts` files — that's how `NodeNext` resolution works.
- **Dependencies**: only `@modelcontextprotocol/sdk`. Avoid adding new runtime deps without a strong reason; this package is meant to be small and `npx`-friendly.
- **Tests**: Vitest. No mocking framework — tests work against real temp directories via `fs.mkdtemp`.

## Layout

```
src/
├── index.ts     # bin entry: wires StdioServerTransport to the MCP server
├── server.ts    # MCP server: tool catalog + dispatch()
└── state.ts     # StateManager: all on-disk operations + path safety + gitignore handling

tests/
├── state.test.ts        # unit tests against StateManager
├── server.test.ts       # tests dispatch() directly + tool-catalog assertions
└── integration.test.ts  # spawns dist/index.js as a subprocess and drives it with a real MCP Client over stdio

dist/                    # tsc output; never edit by hand
```

## Build / test / run

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest run (unit + dispatch + stdio integration)
npm run test:watch     # vitest in watch mode

node dist/index.js     # launch the server (talks MCP over stdio)
```

Integration tests **require a built `dist/`** — they spawn `dist/index.js` as a subprocess. If you change source, run `npm run build` before `npm test` or the integration suite will tell you to.

`npm run prepublishOnly` runs `clean → build → test` and is what gates `npm publish`.

## Architectural decisions worth knowing

1. **Permissions are a deployment convention, not server-enforced.** The MCP server exposes every tool to every client; the README documents which roles should be allowed which tools, but enforcement is each MCP client's responsibility (via its allowlist).

2. **"self" defaults come from `init_run`.** After a client calls `init_run`, the server remembers `(agent_name, run_id)` and uses them when `write_*` / `read_*` calls omit those fields. This is in-memory state on the `StateManager` instance — it does **not** persist across server restarts. One server process per agent is the assumed deployment.

3. **`decisions/` has no per-run subdirectory.** Decisions are recorded exclusively in the shared append-only `decisions/decision.log` (JSONL). `init_run` only carves out per-`(agent_name, run_id)` subdirectories under `cache/`, `results/`, `artifacts/`, and `summaries/` — see `PER_RUN_TARGETS` in `src/state.ts`.

4. **State directory is configurable** via (in priority order): `init_state` argument → constructor argument → `FLEET_STATE_DIRECTORY` env var → `.ai-fleet-state` relative to cwd.

5. **`init_state` writes to `.gitignore`** when the state directory's parent walks up into a git repo. The lookup starts at `path.dirname(stateDirectory)`, not `process.cwd()`. If the state dir is outside the enclosing repo (`path.relative` starts with `..`), we don't touch `.gitignore`.

6. **Path safety.** `StateManager.safeFilePath` rejects absolute paths, traversal, and anything resolving outside the run directory. `assertValidComponent` validates `agent_name` and `run_id` (no separators, no `.`/`..`, no NUL bytes). Tests cover both.

7. **MCP error contract.** When a tool throws, the server returns `{ content: [{type:'text', text: JSON.stringify({success:false, error}) }], isError: true }`. On success, content is `JSON.stringify(result)` and `isError` is omitted. Mirror this shape if you add tools.

8. **stdout is reserved for the MCP transport.** Never `console.log` from `src/` — use `console.error` for diagnostics. `src/index.ts` already follows this rule.

## Adding a new tool

1. Add the `Tool` entry to the `TOOLS` array in `src/server.ts` (name, description, JSON-schema `inputSchema` with `type: 'object'`).
2. Add the case (or extend an existing `read_*` / `write_*` regex branch) in `dispatch()` in the same file.
3. Add the corresponding operation to `StateManager` in `src/state.ts`. Reuse `safeFilePath` and `assertValidComponent`; don't reinvent path validation.
4. Add tests in **all three** suites where applicable:
   - `tests/state.test.ts` — direct StateManager coverage including error paths.
   - `tests/server.test.ts` — dispatch + tool-catalog membership (update the expected-names list).
   - `tests/integration.test.ts` — at least one happy-path call over the real stdio transport if the tool affects an end-to-end flow.
5. Document the tool in `README.md`'s tool table and (if relevant) the permission section.

## Things to avoid

- Don't depend on `process.cwd()` from inside `StateManager` methods — use the resolved `stateDirectory` so behaviour is testable without `chdir`.
- Don't pass raw user-supplied `agent_name` / `run_id` / `file_name` to `path.join` without going through `assertValidComponent` / `safeFilePath` — that's how this server stays safe to expose to multiple agents.
- Don't commit `DESIGN.md`, `dist/`, `.ai-fleet-state/`, or `node_modules/` — all are gitignored.
- Don't use `--no-verify` or `--no-edit` on `git rebase`. Amend only when explicitly asked.

## Memory & state notes for orchestrators

The blanket permission for autonomous edits inside this directory is recorded in `~/.claude/projects/-home-adamh-dev-github-com-HammoTime-fleet-state-mgr/memory/`. If a future agent needs different permission boundaries, update that memory rather than working around it inline.
