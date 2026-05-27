import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DECISION_LOG_FILENAME,
  StateManager,
  TARGETS,
  type DecisionRecord,
} from '../src/state.js';

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

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// init_state
// -----------------------------------------------------------------------------

describe('initState', () => {
  it('creates all five top-level buckets', async () => {
    await state.initState();
    for (const t of TARGETS) {
      expect(await isDir(path.join(stateDir, t))).toBe(true);
    }
  });

  it('is idempotent', async () => {
    await state.initState();
    await state.initState();
    for (const t of TARGETS) {
      expect(await isDir(path.join(stateDir, t))).toBe(true);
    }
  });

  it('honors an override directory passed at call time', async () => {
    const alt = path.join(tmpDir, 'alt-state');
    await state.initState(alt);
    expect(state.getStateDirectory()).toBe(path.resolve(alt));
    expect(await isDir(path.join(alt, 'cache'))).toBe(true);
  });

  it('adds the state directory to .gitignore inside a git repo', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await state.initState();

    const ignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(ignore).toContain('.ai-fleet-state');
  });

  it('does not duplicate an existing gitignore entry', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.ai-fleet-state/\n', 'utf8');

    await state.initState();
    await state.initState();

    const ignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = ignore.match(/\.ai-fleet-state/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('preserves an existing gitignore entry without a trailing slash', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\n.ai-fleet-state\n', 'utf8');

    await state.initState();

    const ignore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = ignore.match(/^\.ai-fleet-state\/?$/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it('skips gitignore work when not in a git repo', async () => {
    await state.initState();
    expect(await pathExists(path.join(tmpDir, '.gitignore'))).toBe(false);
  });

  it('skips gitignore when the state directory is outside the enclosing repo', async () => {
    // Repo is at tmpDir/repo; state lives at tmpDir/outside-state.
    const repo = path.join(tmpDir, 'repo');
    await fs.mkdir(repo);
    await fs.mkdir(path.join(repo, '.git'));
    const outside = path.join(tmpDir, 'outside-state');
    const outsideState = new StateManager(outside);
    await outsideState.initState();

    expect(await pathExists(path.join(repo, '.gitignore'))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// init_run
// -----------------------------------------------------------------------------

describe('initRun', () => {
  beforeEach(async () => {
    await state.initState();
  });

  it('creates the per-agent/per-run directory in every bucket', async () => {
    const runId = await state.initRun('scout', 'run-abc');
    expect(runId).toBe('run-abc');
    for (const t of TARGETS) {
      expect(await isDir(path.join(stateDir, t, 'scout', 'run-abc'))).toBe(true);
    }
  });

  it('generates a UUID when no run_id is supplied', async () => {
    const runId = await state.initRun('scout');
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('remembers (agent_name, run_id) as the "self" default', async () => {
    const runId = await state.initRun('engineer');
    const resolved = state.resolveAgent();
    expect(resolved).toEqual({ agent_name: 'engineer', run_id: runId });
  });

  it('overrides "self" with explicit values when provided', async () => {
    await state.initRun('engineer', 'run-1');
    const resolved = state.resolveAgent('scout', 'run-2');
    expect(resolved).toEqual({ agent_name: 'scout', run_id: 'run-2' });
  });

  it('rejects path separators in agent_name', async () => {
    await expect(state.initRun('bad/name')).rejects.toThrow(/path separators/);
  });

  it('rejects empty agent_name', async () => {
    await expect(state.initRun('')).rejects.toThrow(/non-empty/);
  });

  it('rejects traversal tokens in run_id', async () => {
    await expect(state.initRun('scout', '..')).rejects.toThrow(/traversal/);
  });

  it('works even if initState has not been called yet', async () => {
    const fresh = new StateManager(path.join(tmpDir, 'fresh-state'));
    const runId = await fresh.initRun('scout');
    for (const t of TARGETS) {
      expect(
        await isDir(path.join(tmpDir, 'fresh-state', t, 'scout', runId)),
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// File buckets (cache, results, artifacts, summaries)
// -----------------------------------------------------------------------------

describe('file buckets', () => {
  beforeEach(async () => {
    await state.initState();
    await state.initRun('scout', 'run-1');
  });

  it.each(['cache', 'results', 'artifacts', 'summaries'] as const)(
    'round-trips content for %s',
    async (bucket) => {
      await state.writeFile(bucket, 'scout', 'run-1', 'notes.md', 'hello world');
      const got = await state.readFile(bucket, 'scout', 'run-1', 'notes.md');
      expect(got).toBe('hello world');
    },
  );

  it('creates nested subdirectories on write', async () => {
    await state.writeFile('artifacts', 'scout', 'run-1', 'nested/dir/file.txt', 'x');
    const got = await state.readFile('artifacts', 'scout', 'run-1', 'nested/dir/file.txt');
    expect(got).toBe('x');
  });

  it('overwrites existing files', async () => {
    await state.writeFile('cache', 'scout', 'run-1', 'a.txt', 'first');
    await state.writeFile('cache', 'scout', 'run-1', 'a.txt', 'second');
    expect(await state.readFile('cache', 'scout', 'run-1', 'a.txt')).toBe('second');
  });

  it('rejects path traversal in file_name', async () => {
    await expect(
      state.writeFile('cache', 'scout', 'run-1', '../escape.txt', 'oops'),
    ).rejects.toThrow(/outside the run directory/);
  });

  it('rejects absolute file_name', async () => {
    await expect(
      state.writeFile('cache', 'scout', 'run-1', '/etc/passwd', 'oops'),
    ).rejects.toThrow(/relative path/);
  });

  it('rejects empty file_name', async () => {
    await expect(
      state.writeFile('cache', 'scout', 'run-1', '', 'x'),
    ).rejects.toThrow(/non-empty/);
  });

  it('throws ENOENT-style error on missing read', async () => {
    await expect(
      state.readFile('cache', 'scout', 'run-1', 'nope.txt'),
    ).rejects.toThrow();
  });

  it('allows empty string content', async () => {
    await state.writeFile('cache', 'scout', 'run-1', 'empty.txt', '');
    expect(await state.readFile('cache', 'scout', 'run-1', 'empty.txt')).toBe('');
  });
});

// -----------------------------------------------------------------------------
// Decision log
// -----------------------------------------------------------------------------

describe('decision log', () => {
  beforeEach(async () => {
    await state.initState();
  });

  it('appends a record per write_decision', async () => {
    await state.writeDecision('scout', 'r1', 'first');
    await state.writeDecision('scout', 'r1', 'second');

    const decisions = await state.readDecisions();
    expect(decisions).toHaveLength(2);
    const parsed = decisions.map((line) => JSON.parse(line) as DecisionRecord);
    expect(parsed[0]?.content).toBe('first');
    expect(parsed[1]?.content).toBe('second');
  });

  it('parses structured JSON content', async () => {
    await state.writeDecision('scout', 'r1', JSON.stringify({ choice: 'A', score: 0.9 }));

    const [line] = await state.readDecisions();
    const parsed = JSON.parse(line!) as DecisionRecord;
    expect(parsed.content).toEqual({ choice: 'A', score: 0.9 });
  });

  it('stamps datetime, agent_name, run_id on every record', async () => {
    const before = new Date().toISOString();
    await state.writeDecision('engineer', 'run-7', 'made a thing');
    const after = new Date().toISOString();

    const [line] = await state.readDecisions();
    const parsed = JSON.parse(line!) as DecisionRecord;
    expect(parsed.agent_name).toBe('engineer');
    expect(parsed.run_id).toBe('run-7');
    expect(parsed.datetime >= before).toBe(true);
    expect(parsed.datetime <= after).toBe(true);
  });

  it('filters by agent_name', async () => {
    await state.writeDecision('scout', 'r1', 's1');
    await state.writeDecision('engineer', 'r1', 'e1');
    await state.writeDecision('scout', 'r1', 's2');

    const scoutDecisions = await state.readDecisions({ agent_name: 'scout' });
    expect(scoutDecisions).toHaveLength(2);
    for (const line of scoutDecisions) {
      const parsed = JSON.parse(line) as DecisionRecord;
      expect(parsed.agent_name).toBe('scout');
    }
  });

  it('filters by start_time and end_time', async () => {
    await state.writeDecision('scout', 'r1', 'first');
    await new Promise((r) => setTimeout(r, 25));
    const between = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    await state.writeDecision('scout', 'r1', 'second');

    const after = await state.readDecisions({ start_time: between });
    expect(after).toHaveLength(1);
    expect((JSON.parse(after[0]!) as DecisionRecord).content).toBe('second');

    const before = await state.readDecisions({ end_time: between });
    expect(before).toHaveLength(1);
    expect((JSON.parse(before[0]!) as DecisionRecord).content).toBe('first');
  });

  it('returns an empty array when the log does not exist', async () => {
    const decisions = await state.readDecisions();
    expect(decisions).toEqual([]);
  });

  it('skips malformed log lines without failing', async () => {
    await state.writeDecision('scout', 'r1', 'good');
    const logPath = path.join(stateDir, 'decisions', DECISION_LOG_FILENAME);
    await fs.appendFile(logPath, 'not-json\n', 'utf8');
    await state.writeDecision('scout', 'r1', 'also good');

    const decisions = await state.readDecisions();
    expect(decisions).toHaveLength(2);
  });

  it('rejects malformed time filters', async () => {
    await state.writeDecision('scout', 'r1', 'x');
    await expect(state.readDecisions({ start_time: 'not-a-date' })).rejects.toThrow(
      /valid datetime/,
    );
  });
});

// -----------------------------------------------------------------------------
// resolveAgent
// -----------------------------------------------------------------------------

describe('resolveAgent', () => {
  beforeEach(async () => {
    await state.initState();
  });

  it('throws when no init_run has been called and no overrides are supplied', () => {
    expect(() => state.resolveAgent()).toThrow(/agent_name is required/);
  });

  it('accepts explicit values without init_run', () => {
    const resolved = state.resolveAgent('scout', 'run-x');
    expect(resolved).toEqual({ agent_name: 'scout', run_id: 'run-x' });
  });

  it('validates names', () => {
    expect(() => state.resolveAgent('bad/name', 'run-x')).toThrow(/path separators/);
  });
});

// -----------------------------------------------------------------------------
// clean_state
// -----------------------------------------------------------------------------

describe('cleanState', () => {
  it('wipes everything then re-creates the bucket tree', async () => {
    await state.initState();
    await state.initRun('scout', 'r1');
    await state.writeFile('cache', 'scout', 'r1', 'a.txt', 'hi');
    await state.writeDecision('scout', 'r1', 'decision');

    await state.cleanState();

    for (const t of TARGETS) {
      expect(await isDir(path.join(stateDir, t))).toBe(true);
    }
    expect(await pathExists(path.join(stateDir, 'cache', 'scout', 'r1', 'a.txt'))).toBe(false);
    expect(await pathExists(path.join(stateDir, 'decisions', DECISION_LOG_FILENAME))).toBe(false);
  });

  it('clears the in-memory "self" agent so subsequent calls require an explicit agent', async () => {
    await state.initState();
    await state.initRun('scout', 'r1');
    await state.cleanState();
    expect(() => state.resolveAgent()).toThrow(/agent_name is required/);
  });
});
