/**
 * Main-thread Comlink client helpers for the browser MCP runtime.
 *
 * The MCP settings UI (`McpTab`, `BrowserUseCloudTab`, the `mcp` store) used
 * to POST the config to the server routes /api/mcp-update-config and
 * /api/mcp-check. The backend is a Rust server without a JS runtime now, so
 * these calls go straight into the Comlink chat worker where the MCP clients
 * actually live.
 *
 * IMPORTANT: this intentionally reuses the shared chat worker singleton (see
 * `chat-client.ts`) so MCP connections live in the same worker that runs the
 * chat — the approval flow in `processToolInvocations` operates on exactly
 * those connections.
 */

import { getChatWorker } from './chat-client';
import type { MCPServerStatus } from './mcp-runtime';

export async function updateMcpConfigViaWorker(config: unknown): Promise<MCPServerStatus[]> {
  return getChatWorker().updateMcpConfig(config);
}

export async function checkMcpServersViaWorker(): Promise<MCPServerStatus[]> {
  return getChatWorker().checkMcpServers();
}
