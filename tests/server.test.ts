import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../src/state.js';
import { TOOLS_FOR_TEST, TOOL_NAMES, createServer, dispatch } from '../src/server.js';

let tmpDir: string;
let stateDir: string;
let state: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-server-test-'));
  stateDir = path.join(tmpDir, '.ai-fleet-state');
  state = new StateManager(stateDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('tool catalog', () => {
  it('exposes every tool listed in DESIGN.md', () => {
    const expected = [
      'init_state',
      'init_run',
      'write_cache',
      'read_cache',
      'write_decision',
      'read_decisions',
      'write_result',
      'read_result',
      'write_artifact',
      'read_artifact',
      'write_summary',
      'read_summary',
      'clean_state',
    ];
    for (const name of expected) {
      expect(TOOL_NAMES).toContain(name);
    }
    expect(TOOLS_FOR_TEST).toHaveLength(expected.length);
  });

  it('declares an input schema for every tool', () => {
    for (const tool of TOOLS_FOR_TEST) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('createServer', () => {
  it('returns a server and state manager', () => {
    const { server, state: managed } = createServer({ stateDirectory: stateDir });
    expect(server).toBeDefined();
    expect(managed.getStateDirectory()).toBe(path.resolve(stateDir));
  });
});

describe('dispatch', () => {
  it('runs init_state end-to-end', async () => {
    const result = (await dispatch(state, 'init_state', {})) as { success: boolean };
    expect(result.success).toBe(true);
    const cacheDir = await fs.stat(path.join(stateDir, 'cache'));
    expect(cacheDir.isDirectory()).toBe(true);
  });

  it('runs init_run and returns the new run_id', async () => {
    await dispatch(state, 'init_state', {});
    const result = (await dispatch(state, 'init_run', { agent_name: 'scout' })) as {
      run_id: string;
    };
    expect(result.run_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('uses init_run as the "self" default for subsequent calls', async () => {
    await dispatch(state, 'init_state', {});
    const { run_id } = (await dispatch(state, 'init_run', { agent_name: 'scout' })) as {
      run_id: string;
    };

    await dispatch(state, 'write_cache', { file_name: 'note.md', content: 'hello' });
    const read = (await dispatch(state, 'read_cache', { file_name: 'note.md' })) as {
      content: string;
    };
    expect(read.content).toBe('hello');

    // And explicit overrides still work.
    const cross = (await dispatch(state, 'read_cache', {
      agent_name: 'scout',
      run_id,
      file_name: 'note.md',
    })) as { content: string };
    expect(cross.content).toBe('hello');
  });

  it('round-trips each file bucket via dispatch', async () => {
    await dispatch(state, 'init_state', {});
    await dispatch(state, 'init_run', { agent_name: 'engineer', run_id: 'r1' });
    for (const bucket of ['cache', 'result', 'artifact', 'summary'] as const) {
      const writeName = `write_${bucket}`;
      const readName = `read_${bucket}`;
      await dispatch(state, writeName, { file_name: `${bucket}.txt`, content: `hi-${bucket}` });
      const got = (await dispatch(state, readName, { file_name: `${bucket}.txt` })) as {
        content: string;
      };
      expect(got.content).toBe(`hi-${bucket}`);
    }
  });

  it('writes and reads decisions through dispatch', async () => {
    await dispatch(state, 'init_state', {});
    await dispatch(state, 'init_run', { agent_name: 'scout', run_id: 'r1' });

    await dispatch(state, 'write_decision', { content: 'looked at the repo' });
    await dispatch(state, 'write_decision', {
      content: JSON.stringify({ choice: 'B' }),
    });

    const result = (await dispatch(state, 'read_decisions', {})) as { decisions: string[] };
    expect(result.decisions).toHaveLength(2);
    const second = JSON.parse(result.decisions[1]!);
    expect(second.content).toEqual({ choice: 'B' });
  });

  it('clean_state wipes prior writes', async () => {
    await dispatch(state, 'init_state', {});
    await dispatch(state, 'init_run', { agent_name: 'scout', run_id: 'r1' });
    await dispatch(state, 'write_cache', { file_name: 'a.txt', content: 'hello' });

    await dispatch(state, 'clean_state', {});

    await dispatch(state, 'init_run', { agent_name: 'scout', run_id: 'r1' });
    await expect(
      dispatch(state, 'read_cache', { file_name: 'a.txt' }),
    ).rejects.toThrow();
  });

  it('errors on unknown tool', async () => {
    await expect(dispatch(state, 'nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('requires content for write_decision', async () => {
    await dispatch(state, 'init_state', {});
    await dispatch(state, 'init_run', { agent_name: 'scout' });
    await expect(dispatch(state, 'write_decision', {})).rejects.toThrow(
      /content/,
    );
  });

  it('requires agent_name for init_run', async () => {
    await dispatch(state, 'init_state', {});
    await expect(dispatch(state, 'init_run', {})).rejects.toThrow(/agent_name/);
  });

  it('rejects empty agent_name strings', async () => {
    await dispatch(state, 'init_state', {});
    await expect(dispatch(state, 'init_run', { agent_name: '' })).rejects.toThrow(
      /non-empty/,
    );
  });
});
