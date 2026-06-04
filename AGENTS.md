# AGENTS.md

Working notes for agentic agents (and humans) contributing to **fleet-state-mgr**.

## What this repo is

A Model Context Protocol (MCP) server, written in TypeScript and distributed via `npx`. It exposes 5 simple tools that let agents store and retrieve files organized by session and agent name. State is persisted on disk in `.ai-fleet-state/` by default.

The user-facing description and tool catalogue live in `README.md`.

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
└── state.ts     # StateManager: all on-disk operations + path safety

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
npm run lint           # eslint src tests
npm run prepublishOnly # clean → lint → build → test (full CI pipeline)

node dist/index.js     # launch the server (talks MCP over stdio)
```

Integration tests **require a built `dist/`** — they spawn `dist/index.js` as a subprocess. If you change source, run `npm run build` before `npm test` or the integration suite will tell you to.

`npm run prepublishOnly` runs `lint → clean → build → test` and is what gates `npm publish`.

## CI Checklist

Before submitting code for CI/publishing, ensure:

- [ ] `npm run lint` passes (no eslint errors or warnings)
- [ ] `npm run build` succeeds with no TypeScript errors
- [ ] `npm test` passes (all 46 tests)
- [ ] `npm run prepublishOnly` passes (full pipeline)
- [ ] `CHANGES.md` updated if API changed
- [ ] `README.md` updated if tools or behavior changed
- [ ] `AGENTS.md` updated if architecture or development guidance changed
- [ ] Tests added/updated for any new functionality
- [ ] Version bumped via `npm version` (major/minor/patch as appropriate)

## Architectural decisions worth knowing

1. **Stateless sessions.** Each `new_session()` call creates a new session with a UUID. Only one session is "current" at a time. Sessions are stored as `UUID:::NAME` in `current_run.txt`; when a new session is created, the old one is appended to `previous_run_log.txt` for audit purposes.

2. **Lazy directory creation.** Session and agent directories are created on first `put()` call, not when the session is created. This means `get()` can distinguish between ERR_SESSION_NOT_VALID, ERR_AGENT_NOT_VALID, and ERR_FILE_NOT_FOUND.

3. **File-centric ID scheme.** Files are identified by a 4-part ID: `fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME`. This format is deterministic — given a session, agent, and file name, the ID is always the same, enabling easy cross-referencing.

4. **State directory is configurable** via (in priority order): constructor argument → `FLEET_STATE_DIRECTORY` env var → `.ai-fleet-state` relative to cwd.

5. **Path safety.** `StateManager` validates file paths to prevent directory traversal. `agent_name` and `file_name` are checked for dangerous patterns (path separators, `..`, NUL bytes, etc.). Tests cover both happy and error paths.

6. **MCP error contract.** When a tool throws, the server returns `{ content: [{type:'text', text: JSON.stringify({success:false, error}) }], isError: true }`. On success, content is `JSON.stringify(result)` and `isError` is omitted. Mirror this shape if you add tools.

7. **stdout is reserved for the MCP transport.** Never `console.log` from `src/` — use `console.error` for diagnostics. `src/index.ts` already follows this rule.

## Adding a new tool

1. Add the `Tool` entry to the `TOOLS` array in `src/server.ts` (name, description, JSON-schema `inputSchema` with `type: 'object'`).
2. Add the case in `dispatch()` in the same file.
3. Add the corresponding method to `StateManager` in `src/state.ts`.
4. Add tests in **all three** suites where applicable:
   - `tests/state.test.ts` — direct StateManager coverage including error paths.
   - `tests/server.test.ts` — dispatch + tool-catalog membership (update the expected-names list).
   - `tests/integration.test.ts` — at least one happy-path call over the real stdio transport if the tool affects an end-to-end flow.
5. Document the tool in `README.md`'s tool table.

## Things to avoid

- Don't depend on `process.cwd()` from inside `StateManager` methods — use the resolved `stateDirectory` so behaviour is testable without `chdir`.
- Don't pass raw user-supplied `agent_name` / `file_name` to `path.join` without going through path validation — that's how this server stays safe.
- Don't commit `dist/`, `.ai-fleet-state/`, or `node_modules/` — all are gitignored.
- Don't use `--no-verify` or `--no-edit` on `git rebase`. Amend only when explicitly asked.

## Relevant source sections

**StateManager (src/state.ts):**
- `newSession()` — creates a session, archives old one if present
- `getSession()` — returns current session
- `put()` — stores a file, checks for existing files
- `get()` — retrieves file with detailed error codes
- `cleanSessions()` — wipes all state

**Server (src/server.ts):**
- `TOOLS` array — tool definitions
- `dispatch()` — routes tool calls to StateManager
- `createServer()` — initializes MCP server with transport handler

**Tests:**
- `state.test.ts` — 24 tests covering all StateManager methods and edge cases
- `server.test.ts` — 17 tests covering dispatch, tool catalog, parameter validation
- `integration.test.ts` — 5 tests driving the server over stdio with real MCP client
