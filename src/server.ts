import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { StateManager } from './state.js';

const NAME = 'fleet-state-mgr';
const VERSION = '0.1.0';

const TOOLS: Tool[] = [
  {
    name: 'new_session',
    description: 'Create a new session and return the session id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the session.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_session',
    description: 'Get the current session id and name.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'clean_sessions',
    description: 'Remove all sessions and reinitialize the state directory.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get',
    description: 'Retrieve file content by id. Id format: fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The file id in format fsm::file::SESSION_ID::AGENT_NAME::FILE_NAME',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'put',
    description: 'Store a file and return its id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: {
          type: 'string',
          description: 'The agent name.',
        },
        file_name: {
          type: 'string',
          description: 'The file name.',
        },
        content: {
          type: 'string',
          description: 'The file content.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite an existing file. Defaults to false.',
        },
      },
      required: ['agent_name', 'file_name', 'content'],
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

export async function dispatch(
  state: StateManager,
  name: string,
  args: ToolArgs,
): Promise<unknown> {
  switch (name) {
    case 'new_session': {
      const sessionName = requireString(args, 'name');
      const sessionId = await state.newSession(sessionName);
      return { id: sessionId };
    }

    case 'get_session': {
      const session = await state.getSession();
      return { id: session.id, name: session.name };
    }

    case 'clean_sessions': {
      await state.cleanSessions();
      return { success: true };
    }

    case 'get': {
      const id = requireString(args, 'id');
      const content = await state.get(id);
      return { content };
    }

    case 'put': {
      const agentName = requireString(args, 'agent_name');
      const fileName = requireString(args, 'file_name');
      const content = requireString(args, 'content', true);
      const overwrite = args.overwrite === true;
      const fileId = await state.put(agentName, fileName, content, overwrite);
      return { id: fileId };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
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
  return typeof v === 'object' && v !== null && Array.isArray(v) === false;
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

export const TOOLS_FOR_TEST = TOOLS;
