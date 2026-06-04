/**
 * Integration test: spawns the built `dist/index.js` over stdio and drives it
 * with the real MCP client. Verifies the wire protocol and a real round-trip
 * tool invocation, not just the dispatch function.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

let tmpDir: string;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  await fs.access(SERVER_ENTRY).catch(() => {
    throw new Error(
      `Built server entry not found at ${SERVER_ENTRY}. Run \`npm run build\` before tests.`,
    );
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-int-'));

  transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      FLEET_STATE_DIRECTORY: path.join(tmpDir, '.ai-fleet-state'),
    },
    cwd: tmpDir,
  });
  client = new Client({ name: 'fleet-state-mgr-int-test', version: '0.0.0' }, {});
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function parseToolResult<T = unknown>(result: { content: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text) as T;
}

describe('MCP stdio integration', () => {
  it('lists all five simplified tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['clean_sessions', 'get', 'get_session', 'new_session', 'put'].sort());
  });

  it('drives a full agent session over the wire', async () => {
    // Agent creates a new session.
    const sessionResult = parseToolResult<{ id: string }>(
      await client.callTool({ name: 'new_session', arguments: { name: 'agent-session' } }),
    );
    expect(sessionResult.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Agent verifies current session.
    const getSessionResult = parseToolResult<{ id: string; name: string }>(
      await client.callTool({ name: 'get_session', arguments: {} }),
    );
    expect(getSessionResult.id).toBe(sessionResult.id);
    expect(getSessionResult.name).toBe('agent-session');

    // Agent stores multiple files.
    const noteId = parseToolResult<{ id: string }>(
      await client.callTool({
        name: 'put',
        arguments: {
          agent_name: 'scout',
          file_name: 'findings.md',
          content: '# Analysis\n- Found 3 issues',
        },
      }),
    );
    expect(noteId.id).toMatch(/^fsm::file::[0-9a-f-]{36}::scout::findings\.md$/i);

    const codeId = parseToolResult<{ id: string }>(
      await client.callTool({
        name: 'put',
        arguments: {
          agent_name: 'engineer',
          file_name: 'fix.ts',
          content: 'const fix = () => { /* solution */ };',
        },
      }),
    );

    // Agent retrieves files by id.
    const retrievedNote = parseToolResult<{ content: string }>(
      await client.callTool({ name: 'get', arguments: { id: noteId.id } }),
    );
    expect(retrievedNote.content).toContain('Found 3 issues');

    const retrievedCode = parseToolResult<{ content: string }>(
      await client.callTool({ name: 'get', arguments: { id: codeId.id } }),
    );
    expect(retrievedCode.content).toContain('solution');
  });

  it('clean_sessions wipes all stored data', async () => {
    const sessionId = parseToolResult<{ id: string }>(
      await client.callTool({ name: 'new_session', arguments: { name: 'test' } }),
    ).id;

    const fileId = parseToolResult<{ id: string }>(
      await client.callTool({
        name: 'put',
        arguments: {
          agent_name: 'agent',
          file_name: 'data.txt',
          content: 'important data',
        },
      }),
    ).id;

    // Clean sessions.
    parseToolResult(await client.callTool({ name: 'clean_sessions', arguments: {} }));

    // Data is gone.
    const result = await client.callTool({ name: 'get', arguments: { id: fileId } });
    expect(result.isError).toBe(true);

    // Can create a new session after cleaning.
    const newSessionId = parseToolResult<{ id: string }>(
      await client.callTool({ name: 'new_session', arguments: { name: 'new-session' } }),
    ).id;
    expect(newSessionId).not.toBe(sessionId);
  });

  it('surfaces errors as isError responses', async () => {
    const result = await client.callTool({
      name: 'get',
      arguments: { id: 'fsm::file::00000000-0000-0000-0000-000000000000::agent::file.txt' },
    });
    expect(result.isError).toBe(true);
    const parsed = parseToolResult<{ success: boolean; error: string }>(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTypeOf('string');
  });

  it('put with overwrite=true overwrites files', async () => {
    parseToolResult(await client.callTool({ name: 'new_session', arguments: { name: 'test' } }));

    const fileId = parseToolResult<{ id: string }>(
      await client.callTool({
        name: 'put',
        arguments: {
          agent_name: 'agent',
          file_name: 'file.txt',
          content: 'first version',
        },
      }),
    ).id;

    parseToolResult(
      await client.callTool({
        name: 'put',
        arguments: {
          agent_name: 'agent',
          file_name: 'file.txt',
          content: 'second version',
          overwrite: true,
        },
      }),
    );

    const content = parseToolResult<{ content: string }>(
      await client.callTool({ name: 'get', arguments: { id: fileId } }),
    ).content;
    expect(content).toBe('second version');
  });
});
