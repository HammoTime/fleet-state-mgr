#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr — stdout is reserved for the MCP transport.
  // eslint-disable-next-line no-console
  console.error('fleet-state-mgr fatal error:', err);
  process.exit(1);
});
