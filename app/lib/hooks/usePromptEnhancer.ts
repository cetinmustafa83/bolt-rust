import { useState } from 'react';
import { streamEnhancedPrompt } from '~/lib/worker/chat-client';
import type { ProviderInfo } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('usePromptEnhancement');

export function usePromptEnhancer() {
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [promptEnhanced, setPromptEnhanced] = useState(false);

  const resetEnhancer = () => {
    setEnhancingPrompt(false);
    setPromptEnhanced(false);
  };

  const enhancePrompt = async (
    input: string,
    setInput: (value: string) => void,
    model: string,
    provider: ProviderInfo,
    apiKeys?: Record<string, string>,
  ) => {
    setEnhancingPrompt(true);
    setPromptEnhanced(false);

    const originalInput = input;

    let _input = '';
    let _error: unknown;

    try {
      setInput('');

      /*
       * The enhancer used to POST to the server's /api/enhancer route and read
       * the plain-text stream. The backend is a Rust static/API server now, so
       * the request runs through the Comlink chat worker instead — same UX,
       * same prompt, same streaming behaviour.
       */
      await streamEnhancedPrompt(
        {
          message: input,
          model,
          provider: provider.name,
          apiKeys,
        },
        (delta) => {
          _input += delta;

          logger.trace('Set input', _input);

          setInput(_input);
        },
        `enhancer-${Date.now()}`,
      );
    } catch (error) {
      _error = error;
      setInput(originalInput);
    } finally {
      if (_error) {
        logger.error(_error);
      }

      setEnhancingPrompt(false);
      setPromptEnhanced(true);

      setTimeout(() => {
        setInput(_input);
      });
    }
  };

  return { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer };
}
