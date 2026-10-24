/**
 * Summarize limits (Awesome-Context-Engineering): the chat is auto-summarized
 * as soon as the conversation history crosses one of the configured limits,
 * so long-running sessions never blow through the model's context window and
 * start silently degrading.
 *
 * Limits (first match wins):
 *   1. Message count  — AUTO_SUMMARIZE_MESSAGE_LIMIT turns in the history.
 *   2. Token estimate — AUTO_SUMMARIZE_CONTEXT_RATIO of the selected model's
 *      context window (chars/4 heuristic, the same approximation the usage
 *      readouts use).
 *
 * When a limit trips, the chat worker summarizes everything except the most
 * recent turns into a rolling summary (create-summary.ts) and streams the
 * request with `summary` + `messageSliceId`, which replaces the older
 * history in the system prompt — identical mechanics to the context
 * optimizer, just triggered automatically.
 */

import type { UIMessage } from 'ai';

import { extractPropertiesFromMessage } from './utils';
import { LLMManager } from '~/lib/modules/llm/manager';
import { getMessageText } from '~/lib/persistence/messageMigration';
import type { IProviderSetting } from '~/types/model';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST } from '~/utils/constants';

/** Hard cap on conversation turns before a summary is forced. */
export const AUTO_SUMMARIZE_MESSAGE_LIMIT = 48;

/**
 * Fraction of the model's context window at which the estimated conversation
 * size forces a summary (headroom for files, tools and the response itself).
 */
export const AUTO_SUMMARIZE_CONTEXT_RATIO = 0.7;

/** Never summarize tiny conversations — the summary would cost more than it saves. */
export const AUTO_SUMMARIZE_MIN_MESSAGES = 8;

/** Keep this many of the newest turns verbatim when a summary is forced. */
export const AUTO_SUMMARIZE_KEEP_RECENT = 2;

/**
 * Rough token estimate for a string (chars/4). Deliberately the same
 * chars-per-token heuristic the usage synthesis uses — cheap, dependency-free
 * and accurate enough for a threshold.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimated token footprint of a UIMessage history: text of every part plus a
 * small per-message overhead that approximates role/structure framing.
 */
export function estimateConversationTokens(messages: UIMessage[]): number {
  const PER_MESSAGE_OVERHEAD = 8;

  return messages.reduce((total, message) => {
    const text = getMessageText(message);

    return total + estimateTextTokens(text) + PER_MESSAGE_OVERHEAD;
  }, 0);
}

export interface AutoSummarizeLimits {
  messageLimit: number;
  tokenLimit: number;
}

/**
 * Resolve the effective limits for a model context window. A missing window
 * (unknown model) falls back to a conservative 128k default, matching the
 * DEFAULT_RETRIEVAL token budget used elsewhere in the pipeline.
 */
export function resolveAutoSummarizeLimits(contextWindow?: number): AutoSummarizeLimits {
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : 128_000;

  return {
    messageLimit: AUTO_SUMMARIZE_MESSAGE_LIMIT,
    tokenLimit: Math.floor(window * AUTO_SUMMARIZE_CONTEXT_RATIO),
  };
}

export interface AutoSummarizeDecision {
  shouldSummarize: boolean;

  /** Which limit tripped (for progress copy / logging). */
  reason: 'messages' | 'tokens' | null;
  estimatedTokens: number;
  messageCount: number;
  limits: AutoSummarizeLimits;
}

export function evaluateAutoSummarize(options: {
  messages: UIMessage[];
  contextWindow?: number;

  /** Context optimization already summarizes on every request when enabled. */
  alreadyHandledByOptimizer: boolean;
}): AutoSummarizeDecision {
  const { messages, contextWindow, alreadyHandledByOptimizer } = options;
  const limits = resolveAutoSummarizeLimits(contextWindow);
  const messageCount = messages.length;
  const estimatedTokens = estimateConversationTokens(messages);

  if (alreadyHandledByOptimizer || messageCount < AUTO_SUMMARIZE_MIN_MESSAGES) {
    return { shouldSummarize: false, reason: null, estimatedTokens, messageCount, limits };
  }

  if (messageCount > limits.messageLimit) {
    return { shouldSummarize: true, reason: 'messages', estimatedTokens, messageCount, limits };
  }

  if (estimatedTokens > limits.tokenLimit) {
    return { shouldSummarize: true, reason: 'tokens', estimatedTokens, messageCount, limits };
  }

  return { shouldSummarize: false, reason: null, estimatedTokens, messageCount, limits };
}

/** Human-readable limit line for progress copy and the features tab. */
export function describeAutoSummarizeLimits(limits: AutoSummarizeLimits): string {
  return `auto-summary at ${limits.messageLimit} messages or ~${Math.round(limits.tokenLimit / 1000)}k tokens`;
}

/**
 * Resolve the context window of the model the chat currently targets (last
 * user message wins — the same resolution create-summary.ts uses). Unknown
 * models resolve to undefined and the caller falls back to the 128k default.
 */
export async function resolveModelContextWindow(props: {
  messages: UIMessage[];
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  serverEnv?: Record<string, string>;
}): Promise<number | undefined> {
  const { messages, apiKeys, providerSettings, serverEnv } = props;

  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;

  for (const message of messages) {
    if (message.role === 'user') {
      const { model, provider } = extractPropertiesFromMessage(message);

      currentModel = model;
      currentProvider = provider;
    }
  }

  try {
    const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
    const llmManager = LLMManager.getInstance();

    const modelsList = [
      ...(llmManager.getStaticModelListFromProvider(provider) ?? []),
      ...(await llmManager.getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: serverEnv as any,
      })),
    ];

    return modelsList.find((m) => m.name === currentModel)?.maxTokenAllowed;
  } catch {
    return undefined;
  }
}
