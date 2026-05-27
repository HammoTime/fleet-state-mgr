import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TARGETS = ['cache', 'decisions', 'results', 'artifacts', 'summaries'] as const;
export type Target = (typeof TARGETS)[number];

export type FileTarget = Exclude<Target, 'decisions'>;

/**
 * Buckets that get a per-(agent_name, run_id) subdirectory carved out by
 * init_run. The decision log is a single shared file under `decisions/`, so
 * decisions are deliberately excluded here.
 */
export const PER_RUN_TARGETS: readonly FileTarget[] = [
  'cache',
  'results',
  'artifacts',
  'summaries',
];

export const DEFAULT_STATE_DIRECTORY = '.ai-fleet-state';
export const DECISION_LOG_FILENAME = 'decision.log';

export interface DecisionRecord {
  datetime: string;
  agent_name: string;
  run_id: string;
  content: string | object;
}

export interface ReadDecisionsOptions {
  agent_name?: string | undefined;
  start_time?: string | undefined;
  end_time?: string | undefined;
}

export interface CurrentAgent {
  agent_name: string;
  run_id: string;
}

/**
 * StateManager owns the on-disk fleet state directory and all read/write
 * operations against it. A single instance is created per MCP server process
 * and is shared across all tool invocations.
 */
export class StateManager {
  private stateDirectory: string;
  private currentAgent: CurrentAgent | null = null;

  constructor(stateDirectory?: string) {
    const initial =
      stateDirectory ?? process.env.FLEET_STATE_DIRECTORY ?? DEFAULT_STATE_DIRECTORY;
    this.stateDirectory = path.resolve(initial);
  }

  getStateDirectory(): string {
    return this.stateDirectory;
  }

  setStateDirectory(dir: string): void {
    this.stateDirectory = path.resolve(dir);
  }

  getCurrentAgent(): CurrentAgent | null {
    return this.currentAgent;
  }

  /**
   * Creates the full state directory tree and (if inside a git repo) makes
   * sure the state directory is gitignored. Idempotent.
   */
  async initState(stateDirectory?: string): Promise<void> {
    if (stateDirectory !== undefined) {
      this.setStateDirectory(stateDirectory);
    }
    for (const t of TARGETS) {
      await fs.mkdir(path.join(this.stateDirectory, t), { recursive: true });
    }
    await this.ensureGitignore();
  }

  /**
   * Creates per-agent/per-run subdirectories under each bucket. Generates a
   * UUID run_id if the caller didn't supply one. Remembers the (agent_name,
   * run_id) pair as the "self" defaults for subsequent calls.
   */
  async initRun(agentName: string, runId?: string): Promise<string> {
    StateManager.assertValidComponent(agentName, 'agent_name');
    const finalRunId = runId ?? randomUUID();
    StateManager.assertValidComponent(finalRunId, 'run_id');

    for (const t of PER_RUN_TARGETS) {
      await fs.mkdir(path.join(this.stateDirectory, t, agentName, finalRunId), {
        recursive: true,
      });
    }
    this.currentAgent = { agent_name: agentName, run_id: finalRunId };
    return finalRunId;
  }

  /**
   * Wipes the entire state directory and re-initializes it from scratch.
   */
  async cleanState(): Promise<void> {
    await fs.rm(this.stateDirectory, { recursive: true, force: true });
    this.currentAgent = null;
    await this.initState();
  }

  /**
   * Resolves "self" defaults against the last init_run call. Throws if a
   * required component cannot be determined.
   */
  resolveAgent(agentName?: string, runId?: string): CurrentAgent {
    const resolved: CurrentAgent = {
      agent_name: agentName ?? this.currentAgent?.agent_name ?? '',
      run_id: runId ?? this.currentAgent?.run_id ?? '',
    };
    if (!resolved.agent_name) {
      throw new Error('agent_name is required (call init_run first, or pass it explicitly)');
    }
    if (!resolved.run_id) {
      throw new Error('run_id is required (call init_run first, or pass it explicitly)');
    }
    StateManager.assertValidComponent(resolved.agent_name, 'agent_name');
    StateManager.assertValidComponent(resolved.run_id, 'run_id');
    return resolved;
  }

  // ---------------------------------------------------------------------------
  // File-bucket operations (cache, results, artifacts, summaries)
  // ---------------------------------------------------------------------------

  async writeFile(
    target: FileTarget,
    agentName: string,
    runId: string,
    fileName: string,
    content: string,
  ): Promise<void> {
    StateManager.assertValidComponent(agentName, 'agent_name');
    StateManager.assertValidComponent(runId, 'run_id');
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }
    const filePath = this.safeFilePath(target, agentName, runId, fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  async readFile(
    target: FileTarget,
    agentName: string,
    runId: string,
    fileName: string,
  ): Promise<string> {
    StateManager.assertValidComponent(agentName, 'agent_name');
    StateManager.assertValidComponent(runId, 'run_id');
    const filePath = this.safeFilePath(target, agentName, runId, fileName);
    return await fs.readFile(filePath, 'utf8');
  }

  // ---------------------------------------------------------------------------
  // Decision log (single shared append-only JSONL)
  // ---------------------------------------------------------------------------

  async writeDecision(agentName: string, runId: string, content: string): Promise<void> {
    StateManager.assertValidComponent(agentName, 'agent_name');
    StateManager.assertValidComponent(runId, 'run_id');
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }

    const decisionsDir = path.join(this.stateDirectory, 'decisions');
    await fs.mkdir(decisionsDir, { recursive: true });

    const record: DecisionRecord = {
      datetime: new Date().toISOString(),
      agent_name: agentName,
      run_id: runId,
      content: tryParseJsonObject(content) ?? content,
    };

    const logPath = path.join(decisionsDir, DECISION_LOG_FILENAME);
    await fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
  }

  async readDecisions(options: ReadDecisionsOptions = {}): Promise<string[]> {
    const logPath = path.join(this.stateDirectory, 'decisions', DECISION_LOG_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const start = options.start_time ? Date.parse(options.start_time) : Number.NEGATIVE_INFINITY;
    const end = options.end_time ? Date.parse(options.end_time) : Number.POSITIVE_INFINITY;
    if (options.start_time && Number.isNaN(start)) {
      throw new Error(`start_time is not a valid datetime: ${options.start_time}`);
    }
    if (options.end_time && Number.isNaN(end)) {
      throw new Error(`end_time is not a valid datetime: ${options.end_time}`);
    }

    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let record: DecisionRecord;
      try {
        record = JSON.parse(trimmed) as DecisionRecord;
      } catch {
        // Skip malformed lines.
        continue;
      }

      if (options.agent_name && record.agent_name !== options.agent_name) continue;

      const ts = Date.parse(record.datetime);
      if (!Number.isNaN(ts)) {
        if (ts < start || ts > end) continue;
      }

      out.push(trimmed);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private safeFilePath(
    target: FileTarget,
    agentName: string,
    runId: string,
    fileName: string,
  ): string {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      throw new Error('file_name must be a non-empty string');
    }
    if (path.isAbsolute(fileName)) {
      throw new Error('file_name must be a relative path');
    }
    const base = path.resolve(this.stateDirectory, target, agentName, runId);
    const resolved = path.resolve(base, fileName);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('file_name resolves outside the run directory');
    }
    if (resolved === base) {
      throw new Error('file_name must reference a file, not the run directory itself');
    }
    return resolved;
  }

  static assertValidComponent(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    if (value.includes('/') || value.includes('\\')) {
      throw new Error(`${label} must not contain path separators`);
    }
    if (value === '.' || value === '..') {
      throw new Error(`${label} must not be a traversal token`);
    }
    if (value.includes('\0')) {
      throw new Error(`${label} must not contain null bytes`);
    }
  }

  private async findGitRoot(startDir: string): Promise<string | null> {
    let dir = path.resolve(startDir);
    // Walk upward looking for a .git entry (directory or worktree pointer file).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.access(path.join(dir, '.git'));
        return dir;
      } catch {
        /* not found at this level */
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private async ensureGitignore(): Promise<void> {
    const startDir = path.dirname(this.stateDirectory);
    const gitRoot = await this.findGitRoot(startDir);
    if (!gitRoot) return;

    const gitignorePath = path.join(gitRoot, '.gitignore');
    const rel = path.relative(gitRoot, this.stateDirectory);
    // If the state dir is outside the repo (relative path starts with ..), don't touch .gitignore.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;

    const entry = rel.split(path.sep).join('/');
    const variants = new Set([entry, `${entry}/`, `/${entry}`, `/${entry}/`]);

    let existing = '';
    try {
      existing = await fs.readFile(gitignorePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const alreadyPresent = existing
      .split('\n')
      .map((line) => line.trim())
      .some((line) => variants.has(line));
    if (alreadyPresent) return;

    const separator =
      existing.length === 0 ? '' : existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(gitignorePath, `${existing}${separator}${entry}/\n`, 'utf8');
  }
}

function tryParseJsonObject(raw: string): object | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
