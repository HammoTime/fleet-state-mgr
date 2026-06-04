import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_STATE_DIRECTORY = '.ai-fleet-state';
export const CURRENT_RUN_FILENAME = 'current_run.txt';
export const PREVIOUS_RUN_LOG_FILENAME = 'previous_run_log.txt';

/**
 * StateManager owns the on-disk fleet state directory and all read/write
 * operations against it.
 */
export class StateManager {
  private stateDirectory: string;

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

  /**
   * Creates a new session and returns the session id.
   * Stores session info as "UUID:::SESSION_NAME" in current_run.txt
   */
  async newSession(name: string): Promise<string> {
    await fs.mkdir(this.stateDirectory, { recursive: true });

    const currentRunPath = path.join(this.stateDirectory, CURRENT_RUN_FILENAME);

    // If current_run.txt exists, append it to previous_run_log.txt
    try {
      const existing = await fs.readFile(currentRunPath, 'utf8');
      const logPath = path.join(this.stateDirectory, PREVIOUS_RUN_LOG_FILENAME);
      await fs.appendFile(logPath, existing + '\n', 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const sessionId = randomUUID();
    const content = `${sessionId}:::${name}`;
    await fs.writeFile(currentRunPath, content, 'utf8');

    return sessionId;
  }

  /**
   * Returns the current session id and name from current_run.txt
   */
  async getSession(): Promise<{ id: string; name: string }> {
    const currentRunPath = path.join(this.stateDirectory, CURRENT_RUN_FILENAME);

    try {
      const content = await fs.readFile(currentRunPath, 'utf8');
      const [id, name] = content.trim().split(':::');

      if (!id || !name) {
        throw new Error('ERR_NO_ACTIVE_SESSION');
      }

      return { id, name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('ERR_NO_ACTIVE_SESSION');
      }
      throw err;
    }
  }

  /**
   * Removes all sessions and reinitializes the state directory
   */
  async cleanSessions(): Promise<void> {
    await fs.rm(this.stateDirectory, { recursive: true, force: true });
    await fs.mkdir(this.stateDirectory, { recursive: true });
  }

  /**
   * Retrieves file content by id
   * id format: fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME
   */
  async get(id: string): Promise<string> {
    const parts = id.split('::');

    if (
      parts.length !== 5 ||
      parts[0] !== 'fsm' ||
      parts[1] !== 'file' ||
      !parts[2] ||
      !parts[3] ||
      !parts[4]
    ) {
      throw new Error('ERR_CAN_ONLY_RETRIEVE_FILES');
    }

    const [, , sessionId, agentName, fileName] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    const sessionDir = path.join(this.stateDirectory, sessionId);
    const agentDir = path.join(sessionDir, agentName);
    const filePath = path.join(agentDir, fileName);

    // Check if session exists
    try {
      await fs.access(sessionDir);
    } catch {
      throw new Error('ERR_SESSION_NOT_VALID');
    }

    // Check if agent exists
    try {
      await fs.access(agentDir);
    } catch {
      throw new Error('ERR_AGENT_NOT_VALID');
    }

    // Check if file exists
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('ERR_FILE_NOT_FOUND');
      }
      throw err;
    }
  }

  /**
   * Stores a file and returns its id
   * id format: fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME
   */
  async put(
    agentName: string,
    fileName: string,
    content: string,
    overwrite: boolean = false,
  ): Promise<string> {
    const session = await this.getSession();
    const sessionId = session.id;

    const targetDir = path.join(this.stateDirectory, sessionId, agentName);
    const filePath = path.join(targetDir, fileName);

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Check if file exists and overwrite is false
    if (!overwrite) {
      try {
        await fs.access(filePath);
        throw new Error('ERR_FILE_EXISTS');
      } catch (err) {
        if (err instanceof Error && err.message === 'ERR_FILE_EXISTS') throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // File doesn't exist, proceed
      }
    }

    await fs.writeFile(filePath, content, 'utf8');

    return `fsm::file::${sessionId}::${agentName}::${fileName}`;
  }
}
