/**
 * Client-side chat runtime (runs inside a Comlink web worker).
 *
 * This is the port of the former `api.chat.ts` + `chat-stream.ts` server
 * pipeline. The backend is now a plain Rust static/API server without a
 * JavaScript runtime, so the LLM orchestration moved to the browser: the
 * worker builds the system prompt, resolves the model through the shared
 * provider registry, runs the AI SDK `streamText` loop (incl. agent mode,
 * context optimization and continuation segments) and forwards UIMessage
 * chunks to the main thread.
 *
 * Wire contract with the UI is unchanged: consumers receive the same
 * UIMessageChunk stream (start / text-delta / data-progress / tool calls /
 * data-usage / finish) that `/api/chat` used to emit.
 *
 * Degradations vs. the server pipeline (documented, intentional):
 * - MCP connector tools and plugin tools are unavailable in the browser and
 *   are omitted; project tools (web_search/web_fetch) and the agent-loop
 *   tools are kept.
 * - The MCP tool-invocation preprocessing step is skipped; messages are used
 *   as provided by the UI.
 */

import {
  createUIMessageStream,
  generateId,
  isStepCount,
  jsonSchema,
  toUIMessageStream,
  type JSONSchema7,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { createAgentLoopTools } from './llm/agent-loop';
import { createAgentStreamRecovery } from './llm/agent-stream';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from './llm/constants';
import {
  AUTO_SUMMARIZE_KEEP_RECENT,
  describeAutoSummarizeLimits,
  evaluateAutoSummarize,
  resolveAutoSummarizeLimits,
  resolveModelContextWindow,
} from './llm/context-limits';
import { shouldOptimizeRequestContext } from './llm/context-optimization';
import { createSummary } from './llm/create-summary';
import { getWebResearchInstructions } from './llm/prompt-web-tools';
import { getFilePaths, selectContext } from './llm/select-context';
import { streamText, type StreamingOptions } from './llm/stream-text';
import { extractPropertiesFromMessage } from './llm/utils';
import { mcpRuntime } from './mcp-runtime';
import { getAgentLoopInstructions, getAgentLoopProgress } from '~/lib/common/agentLoop';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { getStarterBuildProgress } from '~/lib/common/starterBuild';
import { createMessage, getMessageText } from '~/lib/persistence/messageMigration';
import { getPluginToolDescriptions, getPluginTools, type EnabledPluginAdapter } from '~/lib/plugins/adapters';
import { getProjectToolNames, projectToolDefinitions } from '~/lib/runtime/projectMcp.shared';
import type { ContextAnnotation, ProgressAnnotation, ToolCallAnnotation } from '~/types/context';
import type { DesignScheme } from '~/types/design-scheme';
import type { IProviderSetting } from '~/types/model';
import { WORK_DIR } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('chat-runtime');

export interface WorkerSupabaseConnection {
  isConnected: boolean;
  hasSelectedProject: boolean;
  credentials?: {
    anonKey?: string;
    supabaseUrl?: string;
  };
}

export interface WorkerPersona {
  name: string;
  instructions: string;
}

export interface WorkerMemoryEntry {
  chatId?: string;
  timestamp: string;
  summary: string;
}

export interface WorkerChatRequest {
  chatId: string;
  messages: UIMessage[];
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  files?: FileMap;
  promptId?: string;
  contextOptimization?: boolean;
  chatMode?: 'discuss' | 'build';
  agentMode?: boolean;
  designScheme?: DesignScheme;
  maxLLMSteps?: number;
  webSearchEnabled?: boolean;
  supabase?: WorkerSupabaseConnection;

  /**
   * Persona selected for this chat (agentrove-inspired): a named bundle of
   * custom instructions injected into the system prompt.
   */
  persona?: WorkerPersona;

  /**
   * Active-memory entries recalled from previous sessions
   * (mnemo-cortex-inspired), injected as background knowledge.
   */
  memories?: WorkerMemoryEntry[];

  /** MCP/browser-use connector settings (from the mcp store body). */
  connectorEnabled?: Record<string, boolean>;
  toolEnabled?: Record<string, boolean>;

  /** Enabled plugins (id/adapter/tools) as sent by Chat.client. */
  plugins?: Array<{ id: string; adapter: string; tools: string[] }>;
}

export interface WorkerChatHandlers {
  onChunk: (chunk: UIMessageChunk) => void;
}

/**
 * Safe stream error mapping — port of `toSafeStreamErrorMessage`, reduced to
 * the checks that do not depend on server-only machinery.
 */
function toSafeStreamErrorMessage(error: unknown): string {
  const anyError = error as Record<string, unknown> | null;

  let providerMessage = error instanceof Error ? error.message : String(error);

  const normalizedMessage = providerMessage.toLowerCase();

  /*
   * AI SDK APICallError: the HTTP status and the upstream response body carry
   * the actionable copy (e.g. CodeGPT's plain-text refusals) — the message
   * alone is often empty for non-JSON error bodies.
   */
  const statusCode = typeof anyError?.statusCode === 'number' ? (anyError.statusCode as number) : undefined;
  const responseBody = typeof anyError?.responseBody === 'string' ? (anyError.responseBody as string) : undefined;

  if (!providerMessage.trim() && responseBody?.trim()) {
    providerMessage = responseBody.trim();
  }

  logger.error(
    `Streaming provider error (${error instanceof Error ? error.name : 'UnknownError'}, status ${statusCode ?? 'n/a'})`,
  );

  if ((error instanceof Error && error.name === 'TimeoutError') || /timeout|timed\s*out/.test(normalizedMessage)) {
    return 'Custom error: The AI provider stopped responding before the next step completed. Completed file changes and tool results are preserved. Retry to continue, or select a different model.';
  }

  if (providerMessage.includes('model') && providerMessage.includes('not found')) {
    return 'Custom error: Invalid model selected. Please check that the model name is correct and available.';
  }

  if (providerMessage.includes('Invalid JSON response')) {
    return 'Custom error: The AI service returned an invalid response. This may be due to an invalid model name, API rate limiting, or server issues. Try selecting a different model or check your API key.';
  }

  /*
   * CodeGPT unsigned chat: getModelInstance throws before any HTTP call, so
   * there is no status code — point the user at the Login button instead of a
   * generic key error.
   */
  if (/missing codegpt session token/i.test(providerMessage)) {
    return 'Custom error: You are not signed in to CodeGPT. Click "Login with CodeGPT" above the chat box and finish the sign-in window — the session token is captured automatically and models load right after.';
  }

  if (
    providerMessage.includes('API key') ||
    providerMessage.includes('unauthorized') ||
    providerMessage.includes('authentication')
  ) {
    return 'Custom error: Invalid or missing API key. Please check your API key configuration.';
  }

  if (normalizedMessage.includes('rate limit') || providerMessage.includes('429')) {
    return 'Custom error: API rate limit exceeded, or the provider rejected the request for account reasons. Check your provider account and try again.';
  }

  if (providerMessage.includes('quota exceeded')) {
    return `Custom error: ${providerMessage}`;
  }

  if (providerMessage.includes('network') || providerMessage.includes('failed to fetch')) {
    return 'Custom error: Network error. Please check your internet connection and try again.';
  }

  const statusPrefix = statusCode ? ` (HTTP ${statusCode})` : '';

  return `Custom error:${statusPrefix} ${providerMessage || JSON.stringify(error, Object.getOwnPropertyNames((error as object) ?? {}))?.slice(0, 300)}`;
}

/**
 * Run the full chat pipeline and forward every UIMessageChunk to
 * `handlers.onChunk`. Resolves when the UI stream has fully drained.
 */
export async function runChat(
  request: WorkerChatRequest,
  handlers: WorkerChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const {
    promptId,
    contextOptimization,
    supabase,
    chatMode,
    agentMode,
    maxLLMSteps,
    webSearchEnabled = true,
    persona,
    memories,
    connectorEnabled,
    toolEnabled: bodyToolEnabled,
  } = request;

  const messages = request.messages;
  const starterBuild = chatMode === 'build' ? getStarterBuildProgress(messages) : getStarterBuildProgress([]);
  const agentLoopEnabled = chatMode === 'build' && (agentMode || starterBuild.status !== 'inactive');
  const agentProgress = getAgentLoopProgress(messages, agentLoopEnabled);
  const files = request.files;
  const designScheme = request.designScheme;
  const apiKeys = request.apiKeys ?? {};
  const providerSettings = request.providerSettings ?? {};

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };

  let progressCounter: number = 1;
  let responseSegments = 1;

  const observeChunk = ({ chunk }: { chunk: unknown }) => {
    const part = chunk as { type?: string };

    if (part.type === 'error') {
      logger.error('Streaming provider error');
    }
  };

  /*
   * Port of createChatUIMessageStream: continue approved tool calls in the
   * same assistant message and SDK stream state.
   */
  const lastMessage = messages[messages.length - 1];
  const messageId = lastMessage?.role === 'assistant' ? lastMessage.id : generateId();

  const uiStream = createUIMessageStream({
    originalMessages: messages,
    onError: (error: any) => toSafeStreamErrorMessage(error),

    async execute({ writer }) {
      writer.write({ type: 'start', messageId });

      const filePaths = getFilePaths(files || {});

      let filteredFiles: FileMap | undefined = undefined;
      let summary: string | undefined = undefined;
      let messageSliceId = 0;

      const isInitialTemplateRequest = messages.some(
        (message) =>
          message.role === 'assistant' &&
          /<boltArtifact\b[^>]*\bid=["']imported-files["']/i.test(getMessageText(message)),
      );

      /*
       * MCP tool-invocation preprocessing (browser port of
       * MCPService.processToolInvocations): approved tool calls from the last
       * message are executed through the live MCP clients inside this worker
       * and the results are streamed back as tool-output-available chunks.
       */
      const processedMessages = await mcpRuntime.processToolInvocations(messages, writer, {
        browserUseCloudEnabled: connectorEnabled?.browserUseCloud === true,
        disabledTools: Object.entries(bodyToolEnabled ?? {})
          .filter(([, enabled]) => !enabled)
          .map(([toolName]) => toolName),
      });

      if (processedMessages.length > 3) {
        messageSliceId = processedMessages.length - 3;
      }

      if (
        shouldOptimizeRequestContext({
          enabled: contextOptimization,
          agentLoopEnabled,
          isInitialTemplateRequest,
          hasFiles: filePaths.length > 0,
        })
      ) {
        logger.debug('Generating Chat Summary');
        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'summary',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Analysing Request',
          } satisfies ProgressAnnotation,
        });

        summary = await createSummary({
          messages: [...processedMessages],
          env: undefined,
          apiKeys,
          providerSettings,
          promptId,
          contextOptimization,
          onFinish(resp) {
            if (resp.usage) {
              cumulativeUsage.completionTokens += (resp.usage as any)?.outputTokens || 0;
              cumulativeUsage.promptTokens += (resp.usage as any)?.inputTokens || 0;
              cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
            }
          },
        });

        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'summary',
            status: 'complete',
            order: progressCounter++,
            message: 'Analysis Complete',
          } satisfies ProgressAnnotation,
        });

        writer.write({
          type: 'data-chatSummary',
          data: { summary, chatId: processedMessages.slice(-1)?.[0]?.id } as ContextAnnotation,
        });

        logger.debug('Updating Context Buffer');
        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'context',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Determining Files to Read',
          } satisfies ProgressAnnotation,
        });

        filteredFiles = await selectContext({
          messages: [...processedMessages],
          env: undefined,
          apiKeys,
          files: files ?? {},
          providerSettings,
          promptId,
          contextOptimization,
          summary,
          onFinish(resp) {
            if (resp.usage) {
              cumulativeUsage.completionTokens += (resp.usage as any)?.outputTokens || 0;
              cumulativeUsage.promptTokens += (resp.usage as any)?.inputTokens || 0;
              cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
            }
          },
        });

        if (filteredFiles) {
          logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))}`);
        }

        writer.write({
          type: 'data-codeContext',
          data: {
            files: Object.keys(filteredFiles).map((key) => {
              let path = key;

              if (path.startsWith(WORK_DIR)) {
                path = path.replace(WORK_DIR, '');
              }

              return path;
            }),
          } as ContextAnnotation,
        });

        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'context',
            status: 'complete',
            order: progressCounter++,
            message: 'Code Files Selected',
          } satisfies ProgressAnnotation,
        });
      }

      /*
       * Auto-summarize on limit (Awesome-Context-Engineering): when the
       * conversation history crosses the summarize limits (48 turns or ~70%
       * of the model's context window), older turns are folded into a rolling
       * summary before the request is built — in every chat mode, with or
       * without project files, so long sessions never silently degrade.
       * Shares the mechanics (and the Features-tab toggle) with the context
       * optimizer: `contextOptimization`.
       */
      if (contextOptimization && !summary) {
        const contextWindow = await resolveModelContextWindow({
          messages: processedMessages,
          apiKeys,
          providerSettings,
        });

        const decision = evaluateAutoSummarize({
          messages: processedMessages,
          contextWindow,
          alreadyHandledByOptimizer: false,
        });

        if (decision.shouldSummarize) {
          const limits = resolveAutoSummarizeLimits(contextWindow);
          const limitCopy = describeAutoSummarizeLimits(limits);

          logger.info(
            `Auto-summarize triggered (${decision.reason} limit): ${decision.messageCount} messages, ~${decision.estimatedTokens} tokens. ${limitCopy}`,
          );

          writer.write({
            type: 'data-progress',
            data: {
              type: 'progress',
              label: 'summary',
              status: 'in-progress',
              order: progressCounter++,
              message: `Auto-summarizing conversation (${limitCopy})`,
            } satisfies ProgressAnnotation,
          });

          summary = await createSummary({
            messages: [...processedMessages],
            env: undefined,
            apiKeys,
            providerSettings,
            promptId,
            contextOptimization,
            onFinish(resp) {
              if (resp.usage) {
                cumulativeUsage.completionTokens += (resp.usage as any)?.outputTokens || 0;
                cumulativeUsage.promptTokens += (resp.usage as any)?.inputTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          /*
           * The summary covers everything except the newest turns; chatId
           * marks the last summarized message so the next request's
           * extractCurrentContext slices from the right point.
           */
          const summarizedUpTo = Math.max(0, processedMessages.length - AUTO_SUMMARIZE_KEEP_RECENT - 1);

          messageSliceId = Math.max(1, processedMessages.length - AUTO_SUMMARIZE_KEEP_RECENT);

          writer.write({
            type: 'data-progress',
            data: {
              type: 'progress',
              label: 'summary',
              status: 'complete',
              order: progressCounter++,
              message: 'Conversation Summarized',
            } satisfies ProgressAnnotation,
          });

          writer.write({
            type: 'data-chatSummary',
            data: { summary, chatId: processedMessages[summarizedUpTo]?.id } as ContextAnnotation,
          });
        }
      }

      /*
       * MCP tools come from the live worker-side clients (schemas only — the
       * approval loop executes them via processToolInvocations above).
       */
      const mcpTools = mcpRuntime.toolsWithoutExecute;

      const mcpDisabledTools = Object.entries(bodyToolEnabled ?? {})
        .filter(([, enabled]) => !enabled)
        .map(([toolName]) => toolName);

      /*
       * Plugins run in this worker too: their tool metadata comes from the
       * same pure adapters the server pipeline used.
       */
      const enabledPlugins = (request.plugins ?? []) as EnabledPluginAdapter[];
      const pluginTools = getPluginTools(enabledPlugins, mcpDisabledTools);
      const pluginToolDescriptions = getPluginToolDescriptions(enabledPlugins);

      /*
       * Project tools are metadata-only on the wire (no execute); the UI
       * executes them against the WebContainer and posts results back.
       */
      const projectTools =
        chatMode === 'build'
          ? Object.fromEntries(
              getProjectToolNames(webSearchEnabled).map((name) => [
                name,
                {
                  description: projectToolDefinitions[name].description,
                  inputSchema: jsonSchema(projectToolDefinitions[name].inputSchema as JSONSchema7),
                },
              ]),
            )
          : {};

      const agentLoop = createAgentLoopTools(processedMessages, agentLoopEnabled, starterBuild.status !== 'inactive', [
        ...Object.keys(mcpTools),
        ...Object.keys(projectTools),
        ...Object.keys(pluginTools),
      ]);

      const agentTools = agentProgress.status !== 'inactive' ? agentLoop.tools : {};

      const pluginAndProjectToolNames = [
        ...Object.keys(projectTools),
        ...Object.keys(pluginTools),
        ...Object.keys(agentTools),
      ];

      const collisions = pluginAndProjectToolNames.filter(
        (name, index) => name in mcpTools || pluginAndProjectToolNames.indexOf(name) !== index,
      );

      if (collisions.length > 0) {
        throw new Error(`Built-in MCP tool name conflict: ${collisions.join(', ')}`);
      }

      const tools = { ...mcpTools, ...projectTools, ...pluginTools, ...agentTools };
      const hasTools = Object.keys(tools).length > 0;
      const recoveringAgent = agentProgress.status === 'pending';

      const notifyRetry = (reason: 'tool-call' | 'provider') => {
        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'response',
            status: 'in-progress',
            order: progressCounter++,
            message:
              reason === 'tool-call'
                ? 'The model missed a required tool call. Retrying the current step; completed work is preserved.'
                : 'Provider response stalled. Retrying the current step; completed work is preserved.',
          } satisfies ProgressAnnotation,
        });
      };

      const recovery = createAgentStreamRecovery(notifyRetry);

      const mapStreamError = (error: unknown) => {
        logger.error('stream error:', error);

        return toSafeStreamErrorMessage(recoveringAgent ? recovery.getError(error) : error);
      };

      const options: Omit<StreamingOptions, 'messages'> = {
        supabaseConnection: supabase,
        system: [
          getWebResearchInstructions({
            browserUseToolNames:
              connectorEnabled?.browserUseCloud === true ? [] : mcpRuntime.getServerToolNames('browser-use-cloud'),
            webToolNames: Object.keys(projectTools).filter(
              (toolName) => toolName === 'web_search' || toolName === 'web_fetch',
            ),
          }),
          getAgentLoopInstructions(agentProgress),

          /*
           * Persona (agentrove-inspired): named custom instructions for this
           * chat, injected after the base prompt.
           */
          persona?.instructions?.trim()
            ? `<persona name="${persona.name}">
${persona.instructions.trim()}
</persona>`
            : undefined,

          /*
           * Active memory (mnemo-cortex-inspired): background knowledge
           * recalled from previous sessions.
           */
          memories && memories.length > 0
            ? `<project_memory>
The following are memories from previous work sessions with this user. Treat them as background knowledge and prefer the current conversation when they conflict:
${memories
  .slice(0, 10)
  .map((entry) => `- [${entry.timestamp}] ${entry.summary}`)
  .join('\n')}
</project_memory>`
            : undefined,
        ]
          .filter(Boolean)
          .join('\n\n'),

        ...(hasTools
          ? { tools, ...(agentProgress.status !== 'inactive' ? { prepareStep: agentLoop.prepareStep } : {}) }
          : {}),

        stopWhen: isStepCount(agentLoopEnabled ? Math.min(maxLLMSteps ?? 12, 12) : (maxLLMSteps ?? 1)),
        timeout: recoveringAgent ? { stepMs: 660_000, totalMs: 900_000 } : { chunkMs: 45_000 },
        ...(recoveringAgent
          ? { streamRetries: 0, onError: recovery.onError, onToolCallRetry: () => notifyRetry('tool-call') }
          : {}),

        abortSignal: signal,
        telemetry: { functionId: 'bolt-chat' },
        onStepEnd: ({ toolCalls, finishReason }) => {
          if (finishReason !== 'error') {
            recovery.stepSucceeded();
          }

          toolCalls.forEach((toolCall) => {
            const toolName = toolCall.toolName;
            const mcpServerName = mcpRuntime.getToolServerName(toolName);

            if (mcpServerName) {
              writer.write({
                type: 'data-toolCall',
                data: {
                  type: 'toolCall',
                  toolCallId: toolCall.toolCallId,
                  serverName: mcpServerName === 'browser-use-cloud' ? 'Browser Use Cloud' : mcpServerName,
                  toolName,
                  toolDescription: `MCP tool from server "${mcpServerName}"`,
                } satisfies ToolCallAnnotation,
              });
            } else if (toolName in pluginToolDescriptions) {
              const pluginTool = pluginToolDescriptions[toolName];

              writer.write({
                type: 'data-toolCall',
                data: {
                  type: 'toolCall',
                  toolCallId: toolCall.toolCallId,
                  serverName: pluginTool.pluginId,
                  toolName,
                  toolDescription: pluginTool.description,
                } satisfies ToolCallAnnotation,
              });
            } else if (toolName in projectTools) {
              writer.write({
                type: 'data-toolCall',
                data: {
                  type: 'toolCall',
                  toolCallId: toolCall.toolCallId,
                  serverName: toolName.startsWith('web_') ? 'Web MCP' : 'Project MCP',
                  toolName,
                  toolDescription: projectToolDefinitions[toolName as keyof typeof projectToolDefinitions].description,
                } satisfies ToolCallAnnotation,
              });
            } else if (toolName in agentTools) {
              writer.write({
                type: 'data-toolCall',
                data: {
                  type: 'toolCall',
                  toolCallId: toolCall.toolCallId,
                  serverName: 'Agent',
                  toolName,
                  toolDescription: String(agentLoop.tools[toolName as keyof typeof agentLoop.tools].description),
                } satisfies ToolCallAnnotation,
              });
            }
          });
        },
        onEnd: async ({ text: content, finishReason, usage }) => {
          logger.debug('usage', JSON.stringify(usage));

          if (usage) {
            cumulativeUsage.completionTokens += usage.outputTokens || 0;
            cumulativeUsage.promptTokens += usage.inputTokens || 0;
            cumulativeUsage.totalTokens += usage.totalTokens || 0;
          }

          if (finishReason === 'error') {
            return;
          }

          if (finishReason !== 'length') {
            writer.write({
              type: 'data-usage',
              data: {
                completionTokens: cumulativeUsage.completionTokens,
                promptTokens: cumulativeUsage.promptTokens,
                totalTokens: cumulativeUsage.totalTokens,
              },
            });
            writer.write({
              type: 'data-progress',
              data: {
                type: 'progress',
                label: 'response',
                status: 'complete',
                order: progressCounter++,
                message: 'Response Generated',
              } satisfies ProgressAnnotation,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));

            return;
          }

          if (responseSegments >= MAX_RESPONSE_SEGMENTS) {
            throw Error('Cannot continue message: Maximum segments reached');
          }

          responseSegments += 1;

          const switchesLeft = MAX_RESPONSE_SEGMENTS - responseSegments;

          logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left)`);

          const lastUserMessage = processedMessages.filter((x) => x.role == 'user').slice(-1)[0];
          const { model, provider } = extractPropertiesFromMessage(lastUserMessage);
          processedMessages.push(createMessage({ id: generateId(), role: 'assistant', text: content }) as UIMessage);
          processedMessages.push(
            createMessage({
              id: generateId(),
              role: 'user',
              text: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
            }) as UIMessage,
          );

          const result = await streamText({
            messages: [...processedMessages],
            env: undefined,
            options,
            apiKeys,
            files,
            providerSettings,
            promptId,
            contextOptimization,
            contextFiles: filteredFiles,
            chatMode,
            agentMode,
            designScheme,
            summary,
            messageSliceId,
            onChunk: observeChunk,
          });

          writer.merge(
            toUIMessageStream({
              stream: result.stream,
              sendStart: false,
              sendFinish: false,
              onError: mapStreamError,
            }),
          );

          return;
        },
      };

      writer.write({
        type: 'data-progress',
        data: {
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation,
      });

      const result = await streamText({
        messages: [...processedMessages],
        env: undefined,
        options,
        apiKeys,
        files,
        providerSettings,
        promptId,
        contextOptimization,
        contextFiles: filteredFiles,
        chatMode,
        agentMode,
        designScheme,
        summary,
        messageSliceId,
        onChunk: observeChunk,
      });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          sendStart: false,
          sendFinish: true,
          onError: mapStreamError,
        }),
      );
    },
  });

  // Forward the UI stream to the main thread, chunk by chunk.
  const reader = (uiStream as unknown as ReadableStream<UIMessageChunk>).getReader();

  /*
   * Chunk delivery is fire-and-forget over Comlink (the proxy call returns a
   * promise nobody awaits). When the main-thread stream is closed or
   * cancelled while deliveries are still queued, the rejected proxy calls
   * would surface as worker unhandled rejections — track them and stop
   * pumping a stream the consumer has already closed.
   */
  let consumerGone = false;

  const deliver = (value: UIMessageChunk) => {
    try {
      const delivered = handlers.onChunk(value) as unknown;

      if (delivered && typeof (delivered as Promise<void>).catch === 'function') {
        (delivered as Promise<void>).catch(() => {
          consumerGone = true;
        });
      }
    } catch {
      consumerGone = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done || consumerGone) {
        break;
      }

      if (value) {
        deliver(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface EnhancerRequest {
  message: string;
  model: string;
  provider: string;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
}

export interface EnhancerHandlers {
  onDelta: (delta: string) => void;
}

/**
 * Prompt enhancer — port of `api.enhancer.ts` running in the worker so every
 * provider keeps working without a server-side LLM runtime.
 */
export async function runEnhancer(
  request: EnhancerRequest,
  handlers: EnhancerHandlers,
  signal: AbortSignal,
): Promise<void> {
  const { message, model, provider } = request;

  const result = await streamText({
    messages: [
      createMessage({
        role: 'user',
        text:
          `[Model: ${model}]\n\n[Provider: ${provider}]\n\n` +
          `You are a professional prompt engineer specializing in crafting precise, effective prompts.\n` +
          `Your task is to enhance prompts by making them more specific, actionable, and effective.\n\n` +
          `I want you to improve the user prompt that is wrapped in \`<original_prompt>\` tags.\n\n` +
          `For valid prompts:\n` +
          `- Make instructions explicit and unambiguous\n` +
          `- Add relevant context and constraints\n` +
          `- Remove redundant information\n` +
          `- Maintain the core intent\n` +
          `- Ensure the prompt is self-contained\n` +
          `- Use professional language\n\n` +
          `For invalid or unclear prompts:\n` +
          `- Respond with clear, professional guidance\n` +
          `- Keep responses concise and actionable\n` +
          `- Maintain a helpful, constructive tone\n` +
          `- Focus on what the user should provide\n` +
          `- Use a standard template for consistency\n\n` +
          `IMPORTANT: Your response must ONLY contain the enhanced prompt text.\n` +
          `Do not include any explanations, metadata, or wrapper tags.\n\n` +
          `<original_prompt>\n  ${message}\n</original_prompt>\n`,
      }) as unknown as Omit<UIMessage, 'id'>,
    ],
    env: undefined,
    apiKeys: request.apiKeys,
    providerSettings: request.providerSettings,
    options: {
      system:
        'You are a senior software principal architect, you should help the user analyse the user query and enrich it with the necessary context and constraints to make it more specific, actionable, and effective. You should also ensure that the prompt is self-contained and uses professional language. Your response should ONLY contain the enhanced prompt text. Do not include any explanations, metadata, or wrapper tags.',
      abortSignal: signal,
    },
  });

  const reader = result.textStream.getReader();

  /*
   * Same fire-and-forget delivery guard as runChat: a closed main-thread
   * stream surfaces as a rejected Comlink proxy call — swallow it and stop
   * instead of logging an unhandled rejection.
   */
  let consumerGone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done || consumerGone) {
        break;
      }

      if (value) {
        try {
          const delivered = handlers.onDelta(value) as unknown;

          if (delivered && typeof (delivered as Promise<void>).catch === 'function') {
            (delivered as Promise<void>).catch(() => {
              consumerGone = true;
            });
          }
        } catch {
          consumerGone = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
