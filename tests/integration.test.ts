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
  it('lists every declared tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'clean_state',
        'init_run',
        'init_state',
        'read_artifact',
        'read_cache',
        'read_decisions',
        'read_result',
        'read_summary',
        'write_artifact',
        'write_cache',
        'write_decision',
        'write_result',
        'write_summary',
      ].sort(),
    );
  });

  it('drives a full orchestrator -> sub-agent flow over the wire', async () => {
    // Orchestrator boots.
    const initResult = parseToolResult<{ success: boolean }>(
      await client.callTool({ name: 'init_state', arguments: {} }),
    );
    expect(initResult.success).toBe(true);

    // Sub-agent registers.
    const runResult = parseToolResult<{ run_id: string }>(
      await client.callTool({
        name: 'init_run',
        arguments: { agent_name: 'scout' },
      }),
    );
    expect(runResult.run_id).toMatch(/^[0-9a-f-]{36}$/i);

    // Sub-agent writes an artifact, then a structured decision, then a summary.
    parseToolResult(
      await client.callTool({
        name: 'write_artifact',
        arguments: { file_name: 'plan.md', content: '# Plan\n- find unused exports' },
      }),
    );
    parseToolResult(
      await client.callTool({
        name: 'write_decision',
        arguments: {
          content: JSON.stringify({ ruled_out: ['globals'], next: 'check imports' }),
        },
      }),
    );
    parseToolResult(
      await client.callTool({
        name: 'write_summary',
        arguments: { file_name: 'summary.md', content: 'Found 3 unused exports.' },
      }),
    );

    // Orchestrator reads everything back.
    const artifact = parseToolResult<{ content: string }>(
      await client.callTool({
        name: 'read_artifact',
        arguments: {
          agent_name: 'scout',
          run_id: runResult.run_id,
          file_name: 'plan.md',
        },
      }),
    );
    expect(artifact.content).toContain('unused exports');

    const decisions = parseToolResult<{ decisions: string[] }>(
      await client.callTool({ name: 'read_decisions', arguments: { agent_name: 'scout' } }),
    );
    expect(decisions.decisions).toHaveLength(1);
    const decisionRecord = JSON.parse(decisions.decisions[0]!) as { content: unknown };
    expect(decisionRecord.content).toEqual({
      ruled_out: ['globals'],
      next: 'check imports',
    });

    const summary = parseToolResult<{ content: string }>(
      await client.callTool({
        name: 'read_summary',
        arguments: {
          agent_name: 'scout',
          run_id: runResult.run_id,
          file_name: 'summary.md',
        },
      }),
    );
    expect(summary.content).toBe('Found 3 unused exports.');
  });

  it('surfaces tool errors as isError responses', async () => {
    await client.callTool({ name: 'init_state', arguments: {} });
    await client.callTool({ name: 'init_run', arguments: { agent_name: 'scout' } });

    const result = await client.callTool({
      name: 'read_cache',
      arguments: { file_name: 'does-not-exist.txt' },
    });
    expect(result.isError).toBe(true);
    const parsed = parseToolResult<{ success: boolean; error: string }>(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTypeOf('string');
  });
});
