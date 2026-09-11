import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createXdocsServer } from './tools.js';

/*
 * stdout belongs to the protocol; diagnostics go to stderr.
 *
 * This SDK's stdio transport skips lines it cannot parse, so a stray write is
 * survivable here — but it is not a property to rely on. Other clients and
 * transports are stricter, and a log line interleaved with a JSON-RPC message
 * is a genuinely confusing failure. Nothing in this process logs the API key.
 */
const baseUrl = process.env.XDOCS_API_URL ?? 'http://localhost:3001';
const token = process.env.XDOCS_API_KEY;

if (!token) {
  console.error(
    'XDOCS_API_KEY is not set. Create a key in xDocs under “API keys” and pass it in the environment.',
  );
  process.exit(1);
}

/*
 * No health check at startup, on purpose.
 *
 * Clients spawn this process eagerly — often long before the API is up — so
 * exiting because the server is not reachable yet would make a working setup
 * look broken. Connection failures surface per tool call instead, with a
 * message that names the URL.
 */
const server = createXdocsServer({ baseUrl, token });
await server.connect(new StdioServerTransport());
console.error(`[xdocs-mcp] ready, talking to ${baseUrl}`);
