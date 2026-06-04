# fleet-state-mgr

A simple MCP server for storing and retrieving files organized by session and agent. Provides a minimal, stateless API for sharing context between agents.

## Concepts

**Sessions** group related work together. Each session has a unique ID and a name. Within a session, agents store and retrieve files using a simple key-value interface.

Files are identified by a 4-part ID:
- Session ID (UUID)
- Agent name (who wrote it)
- File name (relative path)

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

## MCP tools

| Tool             | Inputs                                               | Outputs                 |
| ---------------- | ---------------------------------------------------- | ----------------------- |
| `new_session`    | `name`                                               | `id`, `error?`          |
| `get_session`    | —                                                    | `id`, `name`, `error?`  |
| `clean_sessions` | —                                                    | `success`, `error?`     |
| `put`            | `agent_name`, `file_name`, `content`, `overwrite?`  | `id`, `error?`          |
| `get`            | `id`                                                 | `content`, `error?`     |

### Tool Details

#### `new_session(name: string)`

Creates a new session and returns its UUID. The session name is stored for reference. If a previous session exists, it is archived to a log.

**Response:**
```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

#### `get_session()`

Returns the currently active session's ID and name.

**Response:**
```json
{ "id": "550e8400-e29b-41d4-a716-446655440000", "name": "my-session" }
```

#### `clean_sessions()`

Removes all sessions and stored files. Reinitializes the state directory.

**Response:**
```json
{ "success": true }
```

#### `put(agent_name, file_name, content, overwrite?)`

Stores a file in the current session under the given agent name. Fails with `ERR_FILE_EXISTS` if the file already exists and `overwrite` is not `true`.

**Parameters:**
- `agent_name` (string): Identifies the agent writing the file
- `file_name` (string): Relative path within the agent's directory (e.g., `notes.md`, `nested/dir/code.ts`)
- `content` (string): File contents
- `overwrite` (boolean, default: false): If `true`, overwrites existing files

**Response:**
```json
{ "id": "fsm::file::550e8400-e29b-41d4-a716-446655440000::scout::notes.md" }
```

#### `get(id)`

Retrieves file content by its full ID. Returns error codes for missing sessions, agents, or files.

**Parameters:**
- `id` (string): Full file ID in format `fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME`

**Response:**
```json
{ "content": "file contents here" }
```

**Error codes:**
- `ERR_CAN_ONLY_RETRIEVE_FILES` — ID does not match the file format
- `ERR_SESSION_NOT_VALID` — Session does not exist
- `ERR_AGENT_NOT_VALID` — Agent directory does not exist in the session
- `ERR_FILE_NOT_FOUND` — File does not exist in the agent directory

## On-disk layout

```
.ai-fleet-state/
├── current_run.txt                          ← active session: "UUID:::NAME"
├── previous_run_log.txt                     ← archive of previous sessions
└── <session-id>/
    ├── <agent_name>/
    │   ├── file1.txt
    │   └── nested/dir/
    │       └── file2.md
    └── <other-agent>/
        └── ...
```

Sessions are created lazily — the session directory only exists after files are stored with `put()`.

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
