/**
 * Browser MCP runtime (runs inside the Comlink chat worker).
 *
 * Port of `app/lib/services/mcpService.ts` for the Rust-backend architecture:
 * the MCP clients live in the worker instead of the server. The full
 * human-in-the-loop flow is preserved:
 *
 * 1. connected servers expose their tools WITHOUT execute to the model,
 * 2. the UI shows the approval prompt and answers with
 *    TOOL_EXECUTION_APPROVAL.APPROVE / REJECT as tool output,
 * 3. `processToolInvocations` (this module) executes approved calls through
 *    the live MCP clients on the next request and feeds results back.
 *
 * Browser limitation: stdio transports require a local process runtime and
 * are reported as unavailable with an explanatory error. SSE and
 * streamable-http servers work directly from the browser; cross-origin
 * streamable-http connections transparently fall back to the Rust
 * /api/llm-relay when the server does not send CORS headers.
 */

import { createMCPClient } from '@ai-sdk/mcp';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { convertToModelMessages, type ToolSet, type UIMessage, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';

import {
  getToolCallId,
  getToolInput,
  getToolName,
  getToolOutput,
  getToolState,
  isToolPart,
  migrateLegacyMessages,
} from '~/lib/persistence/messageMigration';
import {
  TOOL_EXECUTION_APPROVAL,
  TOOL_EXECUTION_DENIED,
  TOOL_EXECUTION_ERROR,
  TOOL_NO_EXECUTE_FUNCTION,
} from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-runtime');

/*
 * =============================================================================
 * Configuration schemas (mirrors mcpService.ts)
 * =============================================================================
 */

const stdioServerConfigSchema = z
  .object({
    type: z.enum(['stdio']).optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .transform((data) => ({ ...data, type: 'stdio' as const }));

const sseServerConfigSchema = z
  .object({
    type: z.enum(['sse']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .transform((data) => ({ ...data, type: 'sse' as const }));

const streamableHTTPServerConfigSchema = z
  .object({
    type: z.enum(['streamable-http']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .transform((data) => ({ ...data, type: 'streamable-http' as const }));

const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  sseServerConfigSchema,
  streamableHTTPServerConfigSchema,
]);

export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});

export type MCPConfig = z.infer<typeof mcpConfigSchema>;

type MCPClient = {
  tools: () => Promise<ToolSet>;
  close: () => Promise<void>;
} & { serverName: string };

type MCPServerAvailable = {
  status: 'available';
  tools: ToolSet;
  client: MCPClient;
  config: MCPServerConfig;
};

type MCPServerUnavailable = {
  status: 'unavailable';
  error: string;
  client: MCPClient | null;
  config: MCPServerConfig;
};

type MCPServer = MCPServerAvailable | MCPServerUnavailable;

/** Serializable per-server summary for the main thread / settings UI. */
export interface MCPServerStatus {
  name: string;
  status: 'available' | 'unavailable';
  error?: string;
  toolNames: string[];
  config: MCPServerConfig;
}

/*
 * =============================================================================
 * Runtime
 * =============================================================================
 */

class McpRuntime {
  private _tools: ToolSet = {};
  private _toolsWithoutExecute: ToolSet = {};
  private _mcpToolsPerServer: Record<string, MCPServer> = {};
  private _toolNamesToServerNames = new Map<string, string>();
  private _config: MCPConfig = { mcpServers: {} };

  private _validateServerConfig(serverName: string, config: any): MCPServerConfig {
    const hasStdioField = config.command !== undefined;
    const hasUrlField = config.url !== undefined;

    if (hasStdioField && hasUrlField) {
      throw new Error(`cannot have "command" and "url" defined for the same server.`);
    }

    if (!config.type && hasStdioField) {
      config.type = 'stdio';
    }

    if (hasUrlField && !config.type) {
      throw new Error(`missing "type" field, only "sse" and "streamable-http" are valid options.`);
    }

    if (!['stdio', 'sse', 'streamable-http'].includes(config.type)) {
      throw new Error(`provided "type" is invalid, only "stdio", "sse" or "streamable-http" are valid options.`);
    }

    if (config.type === 'stdio' && !hasStdioField) {
      throw new Error(`missing "command" field.`);
    }

    if (['sse', 'streamable-http'].includes(config.type) && !hasUrlField) {
      throw new Error(`missing "url" field.`);
    }

    try {
      return mcpServerConfigSchema.parse(config);
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        const errorMessages = validationError.issues.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ');
        throw new Error(`Invalid configuration for server "${serverName}": ${errorMessages}`);
      }

      throw validationError;
    }
  }

  private async _createStreamableHTTPClient(
    serverName: string,
    config: { type: 'streamable-http'; url: string; headers?: Record<string, string> },
  ): Promise<MCPClient> {
    logger.debug(`Creating Streamable-HTTP client for ${serverName} with URL: ${config.url}`);

    /*
     * corsAwareFetch falls back to the Rust relay when the MCP server does
     * not send CORS headers.
     */
    const { corsAwareFetch } = await import('./cors-relay');
    const { relayFetch } = await import('./cors-relay');

    const wrappedFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      // Only relay absolute cross-origin URLs; same-origin stays direct.
      if (/^https?:\/\//i.test(url)) {
        return relayFetch(url, init);
      }

      return corsAwareFetch(url, init);
    };

    const client = await createMCPClient({
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
        fetch: wrappedFetch,
      } as StreamableHTTPClientTransportOptions),
    });

    return Object.assign(client, { serverName });
  }

  private async _createSSEClient(
    serverName: string,
    config: { type: 'sse'; url: string; headers?: Record<string, string> },
  ): Promise<MCPClient> {
    logger.debug(`Creating SSE client for ${serverName} with URL: ${config.url}`);

    const client = await createMCPClient({
      transport: config,
    });

    return Object.assign(client, { serverName });
  }

  private _registerTools(serverName: string, tools: ToolSet) {
    for (const [toolName, tool] of Object.entries(tools)) {
      if (this._tools[toolName]) {
        const existingServerName = this._toolNamesToServerNames.get(toolName);

        if (existingServerName && existingServerName !== serverName) {
          logger.warn(`Tool conflict: "${toolName}" from "${serverName}" overrides tool from "${existingServerName}"`);
        }
      }

      this._tools[toolName] = tool;
      this._toolsWithoutExecute[toolName] = { ...tool, execute: undefined };
      this._toolNamesToServerNames.set(toolName, serverName);
    }
  }

  private async _createMCPClient(serverName: string, serverConfig: MCPServerConfig): Promise<MCPClient> {
    const validatedConfig = this._validateServerConfig(serverName, serverConfig);

    if (validatedConfig.type === 'stdio') {
      throw new Error(
        'stdio MCP servers require a local process runtime and are not available in the browser. Use "sse" or "streamable-http" server URLs instead.',
      );
    }

    if (validatedConfig.type === 'sse') {
      return this._createSSEClient(serverName, serverConfig as { type: 'sse'; url: string });
    }

    return this._createStreamableHTTPClient(serverName, serverConfig as { type: 'streamable-http'; url: string });
  }

  private async _createClients() {
    await this._closeClients();

    const createClientPromises = Object.entries(this._config?.mcpServers || []).map(async ([serverName, config]) => {
      let client: MCPClient | null = null;

      try {
        client = await this._createMCPClient(serverName, config);

        try {
          const tools = await client.tools();

          this._registerTools(serverName, tools);

          this._mcpToolsPerServer[serverName] = { status: 'available', client, tools, config };
        } catch (error) {
          logger.error(`Failed to get tools from server ${serverName}:`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: 'could not retrieve tools from server',
            client,
            config,
          };
        }
      } catch (error) {
        logger.error(`Failed to initialize MCP client for server: ${serverName}`, error);
        this._mcpToolsPerServer[serverName] = {
          status: 'unavailable',
          error: (error as Error).message,
          client,
          config,
        };
      }
    });

    await Promise.allSettled(createClientPromises);
  }

  private async _closeClients() {
    await Promise.allSettled(
      Object.values(this._mcpToolsPerServer)
        .filter((server) => server.client)
        .map(async (server) => {
          try {
            await server.client?.close();
          } catch {
            /* ignore close errors */
          }
        }),
    );

    this._tools = {};
    this._toolsWithoutExecute = {};
    this._toolNamesToServerNames.clear();
    this._mcpToolsPerServer = {};
  }

  /** Apply a new config and (re)connect all servers. */
  async updateConfig(config: MCPConfig): Promise<MCPServerStatus[]> {
    logger.debug('updating config', JSON.stringify(config));
    this._config = config;
    await this._createClients();

    return this.getStatus();
  }

  /** Re-check availability of every configured server. */
  async checkServersAvailabilities(): Promise<MCPServerStatus[]> {
    this._tools = {};
    this._toolsWithoutExecute = {};
    this._toolNamesToServerNames.clear();

    const checkPromises = Object.entries(this._mcpToolsPerServer).map(async ([serverName, server]) => {
      let client = server.client;

      try {
        if (!client) {
          client = await this._createMCPClient(serverName, this._config?.mcpServers[serverName]);
        }

        try {
          const tools = await client.tools();

          this._registerTools(serverName, tools);
          this._mcpToolsPerServer[serverName] = { status: 'available', client, tools, config: server.config };
        } catch (error) {
          logger.error(`Failed to get tools from server ${serverName}:`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: 'could not retrieve tools from server',
            client,
            config: server.config,
          };
        }
      } catch (error) {
        logger.error(`Error checking availability for server ${serverName}:`, error);
        this._mcpToolsPerServer[serverName] = {
          status: 'unavailable',
          error: (error as Error).message,
          client: server.client,
          config: server.config,
        };
      }
    });

    await Promise.allSettled(checkPromises);

    return this.getStatus();
  }

  getStatus(): MCPServerStatus[] {
    return Object.entries(this._mcpToolsPerServer).map(([name, server]) => ({
      name,
      status: server.status,
      error: server.status === 'unavailable' ? server.error : undefined,
      toolNames: server.status === 'available' ? Object.keys(server.tools) : [],
      config: server.config,
    }));
  }

  get toolsWithoutExecute(): ToolSet {
    return this._toolsWithoutExecute;
  }

  isValidToolName(toolName: string): boolean {
    return this._toolNamesToServerNames.has(toolName);
  }

  /** Server name for a tool, if the tool belongs to a connected server. */
  getToolServerName(toolName: string): string | undefined {
    return this._toolNamesToServerNames.get(toolName);
  }

  /** Tool names that belong to a given server (e.g. 'browser-use-cloud'). */
  getServerToolNames(serverName: string): string[] {
    return [...this._toolNamesToServerNames.entries()]
      .filter(([, server]) => server === serverName)
      .map(([toolName]) => toolName);
  }

  /**
   * Port of MCPService.processToolInvocations: execute approved MCP tool
   * calls from the last message through the live clients and stream the
   * results back to the UI.
   */
  async processToolInvocations(
    messages: UIMessage[],
    dataStream: UIMessageStreamWriter,
    options: { browserUseCloudEnabled?: boolean; disabledTools?: string[] } = {},
  ): Promise<UIMessage[]> {
    const lastMessage = messages[messages.length - 1];
    const parts = lastMessage?.parts;

    if (!parts) {
      return messages;
    }

    const processedParts = await Promise.all(
      parts.map(async (part) => {
        if (!isToolPart(part)) {
          return part;
        }

        const toolName = getToolName(part);
        const toolCallId = getToolCallId(part) as string;
        const toolState = getToolState(part);

        if (!toolName || !this.isValidToolName(toolName) || toolState !== 'output-available') {
          return part;
        }

        let result;

        const isDisabledTool = options.disabledTools?.includes(toolName) === true;

        if (isDisabledTool) {
          result = TOOL_EXECUTION_DENIED;
        } else if (getToolOutput(part) === TOOL_EXECUTION_APPROVAL.APPROVE) {
          const toolInstance = this._tools[toolName];

          if (toolInstance && typeof toolInstance.execute === 'function') {
            const toolInput = getToolInput(part);
            logger.debug(`calling tool "${toolName}" with args: ${JSON.stringify(toolInput)}`);

            try {
              result = await toolInstance.execute(
                toolInput as any,
                {
                  messages: await convertToModelMessages(migrateLegacyMessages(messages) as any),
                  toolCallId,
                } as any,
              );
            } catch (error) {
              logger.error(`error while calling tool "${toolName}":`, error);
              result = TOOL_EXECUTION_ERROR;
            }
          } else {
            result = TOOL_NO_EXECUTE_FUNCTION;
          }
        } else if (getToolOutput(part) === TOOL_EXECUTION_APPROVAL.REJECT) {
          result = TOOL_EXECUTION_DENIED;
        } else {
          return part;
        }

        dataStream.write({
          type: 'tool-output-available',
          toolCallId,
          output: result,
        });

        return {
          ...part,
          output: result,
          state: 'output-available',
        };
      }),
    );

    return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }] as UIMessage[];
  }
}

export const mcpRuntime = new McpRuntime();
