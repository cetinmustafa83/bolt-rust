/**
 * Chat web worker (Comlink-exposed).
 *
 * Hosts the LLM orchestration that used to live in the Cloudflare worker:
 * system prompt building, provider model resolution, AI SDK streaming, agent
 * mode, context optimization — plus the MCP runtime (SSE / streamable-http
 * servers, approval flow preserved). The main thread talks to it exclusively
 * via Comlink (`app/lib/worker/chat-client.ts`).
 */

import * as Comlink from 'comlink';

import {
  runChat,
  runEnhancer,
  type EnhancerHandlers,
  type EnhancerRequest,
  type WorkerChatHandlers,
  type WorkerChatRequest,
} from '~/lib/worker/chat-runtime';
import { mcpConfigSchema, mcpRuntime, type MCPServerStatus } from '~/lib/worker/mcp-runtime';
import type { MCPConfig } from '~/lib/worker/mcp-runtime';

const abortControllers = new Map<string, AbortController>();

/*
 * Surface worker-level failures with full detail: uncaught exceptions inside
 * the worker otherwise surface on the main thread as message-less error
 * events, which makes the chat error alert useless.
 */
self.addEventListener('error', (event: ErrorEvent) => {
  console.error(
    '[chat-worker] uncaught exception:',
    event.message,
    event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
    event.error?.stack ?? '',
  );
});

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason: any = event.reason;

  console.error('[chat-worker] unhandled rejection:', reason?.message ?? String(reason), reason?.stack ?? '');
});

export interface WorkerApi {
  /*
   * Callback params are typed as the PLAIN handler objects (not Comlink.Remote<…>):
   * the client passes them through Comlink.proxy(), whose return type `T & ProxyMarked`
   * is assignable to `T`. Comlink.Remote<…> is an intersection with ProxyMethods that
   * neither a raw nor an async-ified callback object can satisfy.
   */
  runChat: (request: WorkerChatRequest, handlers: WorkerChatHandlers, chatId: string) => Promise<void>;

  runEnhancer: (request: EnhancerRequest, handlers: EnhancerHandlers, requestId: string) => Promise<void>;

  /** Apply a new MCP server config and (re)connect. */
  updateMcpConfig: (config: unknown) => Promise<MCPServerStatus[]>;

  /** Re-check availability of the configured MCP servers. */
  checkMcpServers: () => Promise<MCPServerStatus[]>;

  /** Abort an in-flight chat/enhancer run started with the same id. */
  abort: (runId: string) => void;
}

const api: WorkerApi = {
  async runChat(request, handlers, chatId) {
    const controller = new AbortController();

    abortControllers.set(chatId, controller);

    try {
      await runChat(
        request,
        {
          onChunk: (chunk) => handlers.onChunk(chunk),
        },
        controller.signal,
      );
    } finally {
      abortControllers.delete(chatId);
    }
  },

  async runEnhancer(request, handlers, requestId) {
    const controller = new AbortController();

    abortControllers.set(requestId, controller);

    try {
      await runEnhancer(
        request,
        {
          onDelta: (delta) => handlers.onDelta(delta),
        },
        controller.signal,
      );
    } finally {
      abortControllers.delete(requestId);
    }
  },

  async updateMcpConfig(config) {
    const parsed = mcpConfigSchema.parse(config);

    return mcpRuntime.updateConfig(parsed as MCPConfig);
  },

  async checkMcpServers() {
    return mcpRuntime.checkServersAvailabilities();
  },

  abort(runId) {
    abortControllers.get(runId)?.abort();
    abortControllers.delete(runId);
  },
};

export type ChatWorkerApi = WorkerApi;

Comlink.expose(api);
