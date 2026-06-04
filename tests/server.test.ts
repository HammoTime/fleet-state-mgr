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
  it('exposes the new simplified tools', () => {
    const expected = ['new_session', 'get_session', 'clean_sessions', 'get', 'put'];
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
  it('new_session creates a session and returns an id', async () => {
    const result = (await dispatch(state, 'new_session', { name: 'test' })) as {
      id: string;
    };
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('get_session returns current session id and name', async () => {
    await dispatch(state, 'new_session', { name: 'my-session' });
    const result = (await dispatch(state, 'get_session', {})) as {
      id: string;
      name: string;
    };
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.name).toBe('my-session');
  });

  it('clean_sessions wipes all sessions', async () => {
    await dispatch(state, 'new_session', { name: 'session-1' });
    const fileId = (await dispatch(state, 'put', {
      agent_name: 'agent',
      file_name: 'file.txt',
      content: 'content',
    })) as { id: string };

    await dispatch(state, 'clean_sessions', {});

    await expect(dispatch(state, 'get', { id: fileId.id })).rejects.toThrow();
  });

  it('put stores a file and returns the file id', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    const result = (await dispatch(state, 'put', {
      agent_name: 'scout',
      file_name: 'notes.md',
      content: 'hello world',
    })) as { id: string };

    expect(result.id).toMatch(/^fsm::file::[0-9a-f-]{36}::scout::notes\.md$/i);
  });

  it('get retrieves file content by id', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    const putResult = (await dispatch(state, 'put', {
      agent_name: 'engineer',
      file_name: 'code.ts',
      content: 'const x = 1;',
    })) as { id: string };

    const getResult = (await dispatch(state, 'get', { id: putResult.id })) as {
      content: string;
    };
    expect(getResult.content).toBe('const x = 1;');
  });

  it('put with overwrite=true overwrites existing files', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    const id1 = (await dispatch(state, 'put', {
      agent_name: 'agent',
      file_name: 'file.txt',
      content: 'first',
    })) as { id: string };

    await dispatch(state, 'put', {
      agent_name: 'agent',
      file_name: 'file.txt',
      content: 'second',
      overwrite: true,
    });

    const result = (await dispatch(state, 'get', { id: id1.id })) as {
      content: string;
    };
    expect(result.content).toBe('second');
  });

  it('put without overwrite throws ERR_FILE_EXISTS', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await dispatch(state, 'put', {
      agent_name: 'agent',
      file_name: 'file.txt',
      content: 'first',
    });

    await expect(
      dispatch(state, 'put', {
        agent_name: 'agent',
        file_name: 'file.txt',
        content: 'second',
        overwrite: false,
      }),
    ).rejects.toThrow('ERR_FILE_EXISTS');
  });

  it('put without overwrite defaults to false', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await dispatch(state, 'put', {
      agent_name: 'agent',
      file_name: 'file.txt',
      content: 'first',
    });

    await expect(
      dispatch(state, 'put', {
        agent_name: 'agent',
        file_name: 'file.txt',
        content: 'second',
      }),
    ).rejects.toThrow('ERR_FILE_EXISTS');
  });

  it('errors on unknown tool', async () => {
    await expect(dispatch(state, 'nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('requires name for new_session', async () => {
    await expect(dispatch(state, 'new_session', {})).rejects.toThrow(/name/);
  });

  it('requires agent_name for put', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await expect(
      dispatch(state, 'put', { file_name: 'file.txt', content: 'x' }),
    ).rejects.toThrow(/agent_name/);
  });

  it('requires file_name for put', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await expect(
      dispatch(state, 'put', { agent_name: 'agent', content: 'x' }),
    ).rejects.toThrow(/file_name/);
  });

  it('requires content for put', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await expect(
      dispatch(state, 'put', { agent_name: 'agent', file_name: 'file.txt' }),
    ).rejects.toThrow(/content/);
  });

  it('requires id for get', async () => {
    await dispatch(state, 'new_session', { name: 'test' });
    await expect(dispatch(state, 'get', {})).rejects.toThrow(/id/);
  });
});
