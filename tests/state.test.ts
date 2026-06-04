import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../src/state.js';

let tmpDir: string;
let stateDir: string;
let state: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-state-test-'));
  stateDir = path.join(tmpDir, '.ai-fleet-state');
  state = new StateManager(stateDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// new_session
// =============================================================================

describe('newSession', () => {
  it('creates a new session and returns a UUID', async () => {
    const sessionId = await state.newSession('my-session');
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('stores session info as UUID:::NAME in current_run.txt', async () => {
    const sessionId = await state.newSession('test-session');
    const content = await fs.readFile(path.join(stateDir, 'current_run.txt'), 'utf8');
    expect(content).toBe(`${sessionId}:::test-session`);
  });

  it('appends previous session to previous_run_log.txt if current_run.txt exists', async () => {
    const id1 = await state.newSession('session-1');
    const id2 = await state.newSession('session-2');

    const logContent = await fs.readFile(
      path.join(stateDir, 'previous_run_log.txt'),
      'utf8',
    );
    expect(logContent).toContain(`${id1}:::session-1`);

    const currentContent = await fs.readFile(
      path.join(stateDir, 'current_run.txt'),
      'utf8',
    );
    expect(currentContent).toBe(`${id2}:::session-2`);
  });

  it('creates state directory if it does not exist', async () => {
    const freshState = new StateManager(path.join(tmpDir, 'fresh'));
    await freshState.newSession('test');
    expect(await pathExists(path.join(tmpDir, 'fresh'))).toBe(true);
  });
});

// =============================================================================
// get_session
// =============================================================================

describe('getSession', () => {
  it('returns the current session id and name', async () => {
    const sessionId = await state.newSession('my-session');
    const session = await state.getSession();
    expect(session.id).toBe(sessionId);
    expect(session.name).toBe('my-session');
  });

  it('throws ERR_NO_ACTIVE_SESSION when no session exists', async () => {
    await expect(state.getSession()).rejects.toThrow('ERR_NO_ACTIVE_SESSION');
  });

  it('returns the most recent session after multiple creates', async () => {
    await state.newSession('first');
    const secondId = await state.newSession('second');
    const session = await state.getSession();
    expect(session.id).toBe(secondId);
    expect(session.name).toBe('second');
  });
});

// =============================================================================
// put
// =============================================================================

describe('put', () => {
  beforeEach(async () => {
    await state.newSession('test-session');
  });

  it('stores a file and returns the file id', async () => {
    const fileId = await state.put('scout', 'notes.md', 'hello world');
    const session = await state.getSession();
    expect(fileId).toBe(`fsm::file::${session.id}::scout::notes.md`);
  });

  it('round-trips content through put and get', async () => {
    const content = 'test content\nwith newlines';
    const fileId = await state.put('engineer', 'file.txt', content);
    const retrieved = await state.get(fileId);
    expect(retrieved).toBe(content);
  });

  it('creates nested directories', async () => {
    const fileId = await state.put('agent', 'nested/dir/file.txt', 'content');
    const retrieved = await state.get(fileId);
    expect(retrieved).toBe('content');
  });

  it('throws ERR_FILE_EXISTS when overwrite is false and file exists', async () => {
    await state.put('agent', 'file.txt', 'first');
    await expect(state.put('agent', 'file.txt', 'second', false)).rejects.toThrow(
      'ERR_FILE_EXISTS',
    );
  });

  it('overwrites file when overwrite is true', async () => {
    const fileId = await state.put('agent', 'file.txt', 'first');
    const newFileId = await state.put('agent', 'file.txt', 'second', true);
    const retrieved = await state.get(newFileId);
    expect(retrieved).toBe('second');
  });

  it('throws ERR_NO_ACTIVE_SESSION when no session is active', async () => {
    const freshState = new StateManager(path.join(tmpDir, 'fresh'));
    await expect(freshState.put('agent', 'file.txt', 'content')).rejects.toThrow(
      'ERR_NO_ACTIVE_SESSION',
    );
  });

  it('allows empty string content', async () => {
    const fileId = await state.put('agent', 'empty.txt', '');
    const retrieved = await state.get(fileId);
    expect(retrieved).toBe('');
  });

  it('allows multiple agents to store files', async () => {
    const id1 = await state.put('scout', 'notes.md', 'scout notes');
    const id2 = await state.put('engineer', 'code.ts', 'engineer code');

    expect(await state.get(id1)).toBe('scout notes');
    expect(await state.get(id2)).toBe('engineer code');
  });
});

// =============================================================================
// get
// =============================================================================

describe('get', () => {
  beforeEach(async () => {
    await state.newSession('test-session');
  });

  it('retrieves files from the correct session and agent', async () => {
    const id1 = await state.put('scout', 'a.txt', 'content-a');
    const id2 = await state.put('engineer', 'b.txt', 'content-b');

    expect(await state.get(id1)).toBe('content-a');
    expect(await state.get(id2)).toBe('content-b');
  });

  it('throws ERR_CAN_ONLY_RETRIEVE_FILES for invalid id format', async () => {
    await expect(state.get('fsm::run::some-run-id')).rejects.toThrow(
      'ERR_CAN_ONLY_RETRIEVE_FILES',
    );
  });

  it('throws ERR_CAN_ONLY_RETRIEVE_FILES for malformed id', async () => {
    await expect(state.get('invalid-id')).rejects.toThrow(
      'ERR_CAN_ONLY_RETRIEVE_FILES',
    );
  });

  it('throws ERR_SESSION_NOT_VALID when session does not exist', async () => {
    const fakeId = 'fsm::file::00000000-0000-0000-0000-000000000000::agent::file.txt';
    await expect(state.get(fakeId)).rejects.toThrow('ERR_SESSION_NOT_VALID');
  });

  it('throws ERR_SESSION_NOT_VALID for a session that never had files stored', async () => {
    const fakeSessionId = '00000000-0000-0000-0000-000000000000';
    const fakeId = `fsm::file::${fakeSessionId}::agent::file.txt`;
    await expect(state.get(fakeId)).rejects.toThrow('ERR_SESSION_NOT_VALID');
  });

  it('throws ERR_AGENT_NOT_VALID when agent directory does not exist but session does', async () => {
    const session = await state.getSession();
    // Put a file for one agent to create the session directory
    await state.put('existing-agent', 'file.txt', 'content');
    // Try to access a file from a different agent
    const fakeId = `fsm::file::${session.id}::nonexistent-agent::file.txt`;
    await expect(state.get(fakeId)).rejects.toThrow('ERR_AGENT_NOT_VALID');
  });

  it('throws ERR_FILE_NOT_FOUND when file does not exist but agent does', async () => {
    const session = await state.getSession();
    // Put a file to create the agent directory
    await state.put('agent', 'existing.txt', 'content');
    // Try to access a different file in the same agent directory
    const fileId = `fsm::file::${session.id}::agent::nonexistent.txt`;
    await expect(state.get(fileId)).rejects.toThrow('ERR_FILE_NOT_FOUND');
  });
});

// =============================================================================
// clean_sessions
// =============================================================================

describe('cleanSessions', () => {
  it('removes all sessions and reinitializes the state directory', async () => {
    await state.newSession('session-1');
    const fileId = await state.put('agent', 'file.txt', 'content');

    await state.cleanSessions();

    await expect(state.get(fileId)).rejects.toThrow();
    expect(
      await pathExists(path.join(stateDir, 'current_run.txt')),
    ).toBe(false);
  });

  it('allows creating a new session after cleaning', async () => {
    await state.newSession('first');
    await state.cleanSessions();

    const sessionId = await state.newSession('second');
    const session = await state.getSession();
    expect(session.id).toBe(sessionId);
    expect(session.name).toBe('second');
  });
});
