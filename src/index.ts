#!/usr/bin/env node
/**
 * Entry point for the MyArchitectAI MCP server.
 *
 * Loads configuration, registers the tools, and serves the Model Context
 * Protocol over stdio. All diagnostics go to stderr — stdout is reserved for
 * the JSON-RPC channel and must never be written to directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MyArchitectAIClient } from './client.js';
import { loadConfig, SERVER_NAME, SERVER_VERSION } from './config.js';
import { ConfigError } from './errors.js';
import { MediaService } from './media.js';
import { SessionStore } from './session.js';
import { registerTools } from './tools.js';

function log(message: string): void {
  console.error(`[${SERVER_NAME}] ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new MyArchitectAIClient(config);
  const media = new MediaService({ timeoutMs: config.timeoutMs, maxBytes: config.maxPreviewBytes });
  const session = new SessionStore(config.stateFile);
  await session.init();

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = registerTools(server, { client, session, media, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${SERVER_VERSION} ready on stdio — ${tools.length} tools: ${tools.join(', ')}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log(`configuration error: ${err.message}`);
  } else {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`fatal error: ${message}`);
  }
  process.exit(1);
});
