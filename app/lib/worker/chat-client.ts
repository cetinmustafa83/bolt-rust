/**
 * Main-thread client for the chat worker.
 *
 * Exposes:
 * - a lazily created, app-lifetime Comlink proxy to `app/workers/chat.worker.ts`
 * - `WorkerChatTransport`, a drop-in ai-sdk `ChatTransport` that replaces the
 *   former HTTP transport to `/api/chat`: instead of POSTing to the server it
 *   forwards the request into the Comlink worker and re-emits the UIMessage
 *   chunks the worker streams back.
 */

import { type ChatTransport, type UIMessage, type UIMessageChunk } from 'ai';
import * as Comlink from 'comlink';

import type { WorkerChatRequest } from './chat-runtime';
import type { ChatWorkerApi } from '~/workers/chat.worker';

let worker: Worker | null = null;
let workerApi: Comlink.Remote<ChatWorkerApi> | null = null;

/**
 * App-lifetime singleton proxy to the chat worker. ALL main-thread consumers
 * (chat transport, MCP settings, enhancer) share this one instance so the
 * worker-side MCP connections and runtime state stay consistent.
 */
export function getChatWorker(): Comlink.Remote<ChatWorkerApi> {
  if (workerApi) {
    return workerApi;
  }

  worker = new Worker(new URL('~/workers/chat.worker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('error', (event) => {
    console.error('[chat-worker] worker error:', event.message ?? event);
  });

  workerApi = Comlink.wrap<ChatWorkerApi>(worker);

  return workerApi;
}

/** Abort any in-flight run inside the worker. */
export async function abortChatRun(runId: string): Promise<void> {
  try {
    await getChatWorker().abort(runId);
  } catch {
    /* worker may already be gone */
  }
}

/** Request payload the UI assembles per send (mirrors the old /api/chat body). */
export interface ChatRequestBody extends Partial<Omit<WorkerChatRequest, 'chatId' | 'messages'>> {
  [key: string]: unknown;
}

/**
 * ai-sdk ChatTransport backed by the Comlink chat worker.
 *
 * The protocol is identical to the old HTTP wire format (UIMessageChunk
 * stream), so the useChat consumer in Chat.client.tsx is unchanged apart from
 * the transport instance.
 */
export class WorkerChatTransport implements ChatTransport<UIMessage> {
  private _bodyProvider?: () => Record<string, unknown> | undefined;

  /**
   * Accepts either the per-request body provider function itself or the
   * `{ body: () => ... }` option object, mirroring DefaultChatTransport's
   * `body: () => ...` option.
   */
  constructor(
    options?:
      | (() => Record<string, unknown> | undefined)
      | { body?: (() => Record<string, unknown> | Record<string, unknown>) | Record<string, unknown> },
  ) {
    if (typeof options === 'function') {
      this._bodyProvider = options;
    } else if (options && typeof options.body === 'function') {
      this._bodyProvider = options.body as () => Record<string, unknown> | undefined;
    }
  }

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;

    /*
     * The ai-sdk ChatTransport contract types body as `object` (ChatRequestOptions);
     * keep the same width so the class satisfies the interface under strict
     * function-type checking. Values are still treated as JSON records below.
     */
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const api = getChatWorker();
    const runId = options.chatId;

    /*
     * DefaultChatTransport accepted per-request body functions; resolve them
     * the same way so the UI keeps passing `body: () => bodyRef.current`.
     */
    const rawBody = options.body ?? this._bodyProvider?.();
    const resolvedBody = typeof rawBody === 'function' ? (rawBody as () => Record<string, unknown>)() : rawBody;

    const request: WorkerChatRequest = {
      chatId: options.chatId,
      messages: options.messages,
      ...(resolvedBody as ChatRequestBody),
    };

    let onAbort: (() => void) | undefined;

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        /*
         * The worker forwards chunks via fire-and-forget Comlink proxy calls,
         * so deliveries can still be in flight when the consumer closes or
         * cancels the stream (useChat stops reading after an error chunk, the
         * UI unmounts…). Enqueueing into a closed controller throws a
         * TypeError that would race back into the worker as an unhandled
         * rejection — drop late chunks instead.
         */
        const safeEnqueue = (chunk: UIMessageChunk) => {
          try {
            controller.enqueue(chunk);
          } catch {
            /* stream already closed or cancel requested — late chunk dropped */
          }
        };

        const safeClose = () => {
          try {
            controller.close();
          } catch {
            /* stream already closed */
          }
        };

        try {
          onAbort = () => {
            safeEnqueue({ type: 'error', errorText: 'aborted' } as unknown as UIMessageChunk);
            void abortChatRun(runId);
          };

          options.abortSignal?.addEventListener('abort', onAbort, { once: true });

          /*
           * Handler callbacks are passed through Comlink.proxy() and typed as
           * the plain WorkerChatHandlers/EnhancerHandlers objects (see
           * chat.worker.ts WorkerApi) — fire-and-forget chunk delivery.
           */
          await api.runChat(
            request,
            Comlink.proxy({
              onChunk: (chunk: UIMessageChunk) => {
                safeEnqueue(chunk);
              },
            }),
            runId,
          );

          safeClose();
        } catch (error) {
          /*
           * Abortions surface as DOMException AbortError; useChat handles the
           * error chunk type for everything else.
           */
          if (options.abortSignal?.aborted) {
            safeClose();

            return;
          }

          const message =
            error instanceof Error && error.message
              ? error.message
              : typeof (error as any)?.message === 'string' && (error as any).message
                ? (error as any).message
                : String(error);

          safeEnqueue({
            type: 'error',
            errorText: message,
          } as unknown as UIMessageChunk);
          safeClose();
        } finally {
          if (onAbort) {
            options.abortSignal?.removeEventListener('abort', onAbort);
          }
        }
      },
      cancel() {
        void abortChatRun(runId);
      },
    });
  }

  /**
   * Stream resumption requires a server-side session store; the worker keeps
   * no such state, so there is nothing to reconnect to.
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

/**
 * Prompt enhancer client — streams text deltas from the worker, mirroring the
 * old `/api/enhancer` text stream.
 */
export async function streamEnhancedPrompt(
  request: {
    message: string;
    model: string;
    provider: string;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, unknown>;
  },
  onDelta: (delta: string) => void,
  runId: string,
): Promise<void> {
  const api = getChatWorker();

  await api.runEnhancer(request as Parameters<ChatWorkerApi['runEnhancer']>[0], Comlink.proxy({ onDelta }), runId);
}
