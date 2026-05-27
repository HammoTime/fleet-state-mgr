# fleet-state-mgr

An MCP server that lets an **Orchestrator** and its **Sub-Agents** share context, decisions, results, artifacts, and summaries through a structured on-disk state directory.

## Concepts

| Bucket       | Purpose                                                                                | Typical writers | Typical readers |
| ------------ | -------------------------------------------------------------------------------------- | --------------- | --------------- |
| `cache`      | An agent's in-process scratchpad — used to offload context that's not currently active | self            | self            |
| `decisions`  | Append-only audit log of decisions made by any sub-agent                               | sub-agents      | orchestrator    |
| `results`    | Sub-agent run outputs                                                                  | sub-agents      | orchestrator    |
| `artifacts`  | Transient inter-agent payloads (plans, code drafts, file listings, etc.)               | sub-agents      | sub-agents      |
| `summaries`  | Concise human/orchestrator-facing summaries written by sub-agents                      | sub-agents      | orchestrator    |

Artifacts are **transient** carriers between agents — ultimate, user-facing artifacts (production code, published docs) go into the work tree itself, not here.

## Install / Run

Once published to npm:

```bash
npx fleet-state-mgr
```

The server speaks MCP over stdio. Wire it into your client's MCP config — for example, Claude Desktop:

```json
{
  "mcpServers": {
    "fleet-state-mgr": {
      "command": "npx",
      "args": ["-y", "fleet-state-mgr"]
    }
  }
}
```

### Environment

| Variable                  | Effect                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `FLEET_STATE_DIRECTORY`   | Override the default state directory (`.ai-fleet-state` relative to the server's cwd). |

`init_state` may also override the directory at runtime.

## MCP tools

| Tool             | Inputs                                                       | Outputs                    |
| ---------------- | ------------------------------------------------------------ | -------------------------- |
| `init_state`     | `state_directory?`                                           | `success`, `error?`        |
| `init_run`       | `agent_name`, `run_id?`                                      | `run_id`, `error?`         |
| `clean_state`    | —                                                            | `success`, `error?`        |
| `write_cache`    | `agent_name?`, `run_id?`, `file_name`, `content`             | `success`, `error?`        |
| `read_cache`     | `agent_name?`, `run_id?`, `file_name`                        | `content`, `error?`        |
| `write_result`   | `agent_name?`, `run_id?`, `file_name`, `content`             | `success`, `error?`        |
| `read_result`    | `agent_name?`, `run_id?`, `file_name`                        | `content`, `error?`        |
| `write_artifact` | `agent_name?`, `run_id?`, `file_name`, `content`             | `success`, `error?`        |
| `read_artifact`  | `agent_name?`, `run_id?`, `file_name`                        | `content`, `error?`        |
| `write_summary`  | `agent_name?`, `run_id?`, `file_name`, `content`             | `success`, `error?`        |
| `read_summary`   | `agent_name?`, `run_id?`, `file_name`                        | `content`, `error?`        |
| `write_decision` | `agent_name?`, `run_id?`, `content`                          | `success`, `error?`        |
| `read_decisions` | `agent_name?`, `start_time?`, `end_time?`                    | `decisions[]`, `error?`    |

`agent_name` / `run_id` default to **self** — i.e. the values most recently passed to `init_run` on the same server instance. Provide them explicitly to read from or write to another agent's bucket.

## Permission model

The MCP server exposes every tool to every client; **permissions are a deployment convention**, enforced by configuring each MCP client to only call the tools it should:

- **All agents** — `write_cache`, `read_cache`, `init_run`
- **Orchestrator only** — `read_decisions`, `read_result`, `read_summary`, `init_state`, `clean_state`
- **Sub-agents only** — `write_decision`, `write_result`, `read_artifact`, `write_artifact`, `write_summary`

Configure each client's `disabledTools` (or equivalent allowlist) to match the role.

## On-disk layout

```
.ai-fleet-state/
├── cache/<agent_name>/<run_id>/...
├── decisions/
│   └── decision.log                     ← shared append-only JSONL audit log
├── results/<agent_name>/<run_id>/...
├── artifacts/<agent_name>/<run_id>/...
└── summaries/<agent_name>/<run_id>/...
```

Only the four file buckets (`cache`, `results`, `artifacts`, `summaries`) get per-`(agent_name, run_id)` subdirectories. Decisions are recorded exclusively in the shared `decisions/decision.log`.

The decision log is a single shared JSONL file. Each line is one record:

```json
{"datetime":"2026-05-27T13:39:00.000Z","agent_name":"scout","run_id":"…","content":"…"}
```

If `content` parses as JSON, it is stored as a structured object; otherwise it is stored as a string.

`init_state` will add the state directory to `.gitignore` when it detects an enclosing git repository, so transient state is never committed.

## Development

```bash
npm install
npm run build
npm test
```

- Source: `src/`
- Tests: `tests/` (Vitest)
- Compiled output: `dist/`

To run the server locally against a built copy:

```bash
node dist/index.js
```
