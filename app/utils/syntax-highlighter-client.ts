/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Syntax Highlighter Client
 *
 * Interface for the Comlink-based syntax highlighting web worker. The public
 * API (highlight / preload / clearCache / getCacheStats / dispose) is
 * unchanged; internally the hand-rolled postMessage protocol was replaced by
 * Comlink.wrap, which provides a typed, promise-returning proxy of the
 * worker's API.
 */

import * as Comlink from 'comlink';
import type { BundledLanguage, BundledTheme } from 'shiki';

import type { SyntaxHighlighterWorkerApi } from '~/workers/syntax-highlighter.worker';

export class SyntaxHighlighterClient {
  private worker: Worker | null = null;
  private remote: Comlink.Remote<SyntaxHighlighterWorkerApi> | null = null;
  private cache = new Map<string, string>();
  private readonly MAX_CACHE_SIZE = 500;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('../workers/syntax-highlighter.worker.ts', import.meta.url), { type: 'module' });

      this.worker.addEventListener('error', (error) => {
        console.error('Worker error:', error);
      });

      this.remote = Comlink.wrap<SyntaxHighlighterWorkerApi>(this.worker);
    } catch (error) {
      console.error('Failed to initialize syntax highlighter worker:', error);
    }
  }

  /**
   * Highlight code with caching
   */
  async highlight(code: string, language: BundledLanguage, theme: BundledTheme = 'dark-plus'): Promise<string> {
    // Check cache first
    const cacheKey = `${language}:${theme}:${code}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    // If worker is not available, return plain text
    if (!this.remote) {
      return this.fallbackHighlight(code);
    }

    try {
      const html = await this.remote.highlight(code, language, theme);

      // Cache the result
      this.cache.set(cacheKey, html);

      // Limit cache size (LRU-like)
      if (this.cache.size > this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;

        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }

      return html;
    } catch (error) {
      console.error('Highlight error:', error);

      return this.fallbackHighlight(code);
    }
  }

  /**
   * Fallback to plain text rendering
   */
  private fallbackHighlight(code: string): string {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    return `<pre><code>${escaped}</code></pre>`;
  }

  /**
   * Preload commonly used languages
   */
  async preload(): Promise<void> {
    await this.remote?.preload();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
    };
  }

  /**
   * Terminate the worker
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.remote = null;
    }

    this.cache.clear();
  }
}

// Singleton instance
let instance: SyntaxHighlighterClient | null = null;

/**
 * Get the singleton syntax highlighter instance
 */
export function getSyntaxHighlighter(): SyntaxHighlighterClient {
  if (!instance) {
    instance = new SyntaxHighlighterClient();
  }

  return instance;
}

/**
 * Convenience function for highlighting code
 */
export async function highlightCode(
  code: string,
  language: BundledLanguage,
  theme: BundledTheme = 'dark-plus',
): Promise<string> {
  const highlighter = getSyntaxHighlighter();
  return highlighter.highlight(code, language, theme);
}
