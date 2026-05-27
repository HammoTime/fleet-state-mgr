import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { StateManager, type FileTarget } from './state.js';

const NAME = 'fleet-state-mgr';
const VERSION = '0.1.0';

const fileBucketAgentProps = {
  agent_name: {
    type: 'string',
    description: 'Target agent. Defaults to the agent that last called init_run on this server.',
  },
  run_id: {
    type: 'string',
    description: 'Target run id. Defaults to the run id from the last init_run call.',
  },
} as const;

function fileReadSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      ...fileBucketAgentProps,
      file_name: { type: 'string', description: 'Relative path of the file within the run directory.' },
    },
    required: ['file_name'],
    additionalProperties: false,
  };
}

function fileWriteSchema(): Tool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      ...fileBucketAgentProps,
      file_name: { type: 'string', description: 'Relative path of the file within the run directory.' },
      content: { type: 'string', description: 'File contents to write (replaces any existing file).' },
    },
    required: ['file_name', 'content'],
    additionalProperties: false,
  };
}

const TOOLS: Tool[] = [
  {
    name: 'init_state',
    description:
      'Create the fleet state directory tree (cache/decisions/results/artifacts/summaries). Adds the directory to .gitignore when run inside a git repository. Should be the first call from the orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        state_directory: {
          type: 'string',
          description: 'Where the state directory should live. Defaults to .ai-fleet-state in the server cwd.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'init_run',
    description:
      'Create per-agent / per-run subdirectories under each state bucket. Returns the run_id (auto-generated UUID if not supplied) and remembers (agent_name, run_id) as the "self" defaults for subsequent calls.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: "The agent's type, classification, or persona." },
        run_id: { type: 'string', description: 'Optional caller-supplied run identifier. If absent, a UUID is generated.' },
      },
      required: ['agent_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'clean_state',
    description: 'Wipe the entire state directory and reinitialize it. Use when work is complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  {
    name: 'write_cache',
    description: "Write to the calling agent's cache bucket (or another agent's, if agent_name/run_id are provided).",
    inputSchema: fileWriteSchema(),
  },
  {
    name: 'read_cache',
    description: 'Read a file from a cache bucket.',
    inputSchema: fileReadSchema(),
  },

  {
    name: 'write_result',
    description: "Write to a sub-agent's results bucket. The orchestrator reads these to evaluate runs.",
    inputSchema: fileWriteSchema(),
  },
  {
    name: 'read_result',
    description: 'Read a file from a sub-agent results bucket (orchestrator).',
    inputSchema: fileReadSchema(),
  },

  {
    name: 'write_artifact',
    description: 'Write a transient artifact intended for consumption by another sub-agent.',
    inputSchema: fileWriteSchema(),
  },
  {
    name: 'read_artifact',
    description: 'Read a transient artifact produced by another sub-agent.',
    inputSchema: fileReadSchema(),
  },

  {
    name: 'write_summary',
    description: 'Write a concise summary intended for the orchestrator / user.',
    inputSchema: fileWriteSchema(),
  },
  {
    name: 'read_summary',
    description: 'Read a sub-agent summary (orchestrator).',
    inputSchema: fileReadSchema(),
  },

  {
    name: 'write_decision',
    description:
      'Append a decision record to the shared decision log. Content may be plain text or a JSON object; structured JSON is stored as parsed structure inside the record.',
    inputSchema: {
      type: 'object',
      properties: {
        ...fileBucketAgentProps,
        content: { type: 'string', description: 'Decision content. Text or JSON-encoded structured data.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_decisions',
    description:
      'Read the shared decision log. Returns an array of JSONL records (as strings) filtered by agent_name and/or time range.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: {
          type: 'string',
          description: 'Limit to decisions written by this agent. Default: include all agents.',
        },
        start_time: {
          type: 'string',
          description: 'Only include decisions with datetime >= start_time (ISO 8601).',
        },
        end_time: {
          type: 'string',
          description: 'Only include decisions with datetime <= end_time (ISO 8601).',
        },
      },
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Args passed to a tool call — always an object after JSON-RPC decoding. */
export type ToolArgs = Record<string, unknown>;

/** Result returned to MCP for a successful tool call. */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const FILE_BUCKETS: Record<string, FileTarget> = {
  cache: 'cache',
  result: 'results',
  artifact: 'artifacts',
  summary: 'summaries',
};

export async function dispatch(
  state: StateManager,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (name) {
    case 'init_state': {
      const stateDirectory = optionalString(args, 'state_directory');
      await state.initState(stateDirectory);
      return { success: true };
    }

    case 'init_run': {
      const agentName = requireString(args, 'agent_name');
      const runId = optionalString(args, 'run_id');
      const finalRunId = await state.initRun(agentName, runId);
      return { run_id: finalRunId };
    }

    case 'clean_state': {
      await state.cleanState();
      return { success: true };
    }

    case 'write_decision': {
      const { agent_name, run_id } = state.resolveAgent(
        optionalString(args, 'agent_name'),
        optionalString(args, 'run_id'),
      );
      const content = requireString(args, 'content', true);
      await state.writeDecision(agent_name, run_id, content);
      return { success: true };
    }

    case 'read_decisions': {
      const agentName = optionalString(args, 'agent_name');
      const startTime = optionalString(args, 'start_time');
      const endTime = optionalString(args, 'end_time');
      const decisions = await state.readDecisions({
        agent_name: agentName,
        start_time: startTime,
        end_time: endTime,
      });
      return { decisions };
    }

    default: {
      const writeMatch = /^write_(cache|result|artifact|summary)$/.exec(name);
      if (writeMatch) {
        const bucket = FILE_BUCKETS[writeMatch[1]!]!;
        const { agent_name, run_id } = state.resolveAgent(
          optionalString(args, 'agent_name'),
          optionalString(args, 'run_id'),
        );
        const fileName = requireString(args, 'file_name');
        const content = requireString(args, 'content', true);
        await state.writeFile(bucket, agent_name, run_id, fileName, content);
        return { success: true };
      }

      const readMatch = /^read_(cache|result|artifact|summary)$/.exec(name);
      if (readMatch) {
        const bucket = FILE_BUCKETS[readMatch[1]!]!;
        const { agent_name, run_id } = state.resolveAgent(
          optionalString(args, 'agent_name'),
          optionalString(args, 'run_id'),
        );
        const fileName = requireString(args, 'file_name');
        const content = await state.readFile(bucket, agent_name, run_id, fileName);
        return { content };
      }

      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

export function createServer(
  options: { stateDirectory?: string } = {},
): { server: Server; state: StateManager } {
  const state = new StateManager(options.stateDirectory);
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<ToolResult> => {
    const { name, arguments: rawArgs } = req.params;
    const args: ToolArgs = isPlainObject(rawArgs) ? (rawArgs as ToolArgs) : {};
    try {
      const result = await dispatch(state, name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: false, error: message }) },
        ],
        isError: true,
      };
    }
  });

  return { server, state };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(args: ToolArgs, key: string, allowEmpty = false): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new Error(`Argument '${key}' must be a string`);
  }
  if (!allowEmpty && v.length === 0) {
    throw new Error(`Argument '${key}' must be a non-empty string`);
  }
  return v;
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`Argument '${key}' must be a string when provided`);
  }
  return v;
}

export const TOOLS_FOR_TEST = TOOLS;
