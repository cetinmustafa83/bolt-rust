/**
 * Syntax Highlighting Worker (Comlink)
 *
 * Moves expensive syntax highlighting off the main thread so code
 * highlighting does not block the UI during streaming.
 *
 * The worker bridge is Comlink (https://github.com/GoogleChromeLabs/comlink):
 * the module exposes a typed, promise-returning API object and the main
 * thread consumes it through `Comlink.wrap` — no hand-rolled postMessage
 * protocol, ids or request bookkeeping anymore.
 */

import * as Comlink from 'comlink';
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from 'shiki';

let highlighter: Highlighter | null = null;
let isInitializing = false;
let initQueue: Array<() => void> = [];

// Most commonly used languages - load these by default
const DEFAULT_LANGUAGES: BundledLanguage[] = [
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'html',
  'css',
  'json',
  'markdown',
  'bash',
  'shell',
  'sql',
  'yaml',
];

// Default themes
const DEFAULT_THEMES: BundledTheme[] = ['dark-plus', 'light-plus'];

/**
 * Initialize the highlighter
 */
async function initHighlighter(): Promise<void> {
  if (highlighter) {
    return;
  }

  if (isInitializing) {
    await new Promise<void>((resolve) => {
      initQueue.push(resolve);
    });

    return;
  }

  isInitializing = true;

  try {
    highlighter = await createHighlighter({
      themes: DEFAULT_THEMES,
      langs: DEFAULT_LANGUAGES,
    });

    // Notify all waiting requests
    initQueue.forEach((resolve) => resolve());
    initQueue = [];
  } catch (error) {
    console.error('Failed to initialize highlighter:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
}

/**
 * Escape HTML entities for fallback rendering
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Highlight code with the given language and theme
 */
async function highlightCode(
  code: string,
  language: BundledLanguage,
  theme: BundledTheme = 'dark-plus',
): Promise<string> {
  if (!highlighter) {
    await initHighlighter();
  }

  if (!highlighter) {
    throw new Error('Highlighter not initialized');
  }

  try {
    // Ensure the language is loaded
    const loadedLanguages = highlighter.getLoadedLanguages();

    if (!loadedLanguages.includes(language)) {
      await highlighter.loadLanguage(language);
    }

    // Ensure the theme is loaded
    const loadedThemes = highlighter.getLoadedThemes();

    if (!loadedThemes.includes(theme)) {
      await highlighter.loadTheme(theme);
    }

    return highlighter.codeToHtml(code, {
      lang: language,
      theme,
    });
  } catch (error) {
    console.error('Failed to highlight code:', error);

    // Fallback to plain code
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

export interface SyntaxHighlighterWorkerApi {
  highlight: typeof highlightCode;
  preload: () => Promise<void>;
}

const api: SyntaxHighlighterWorkerApi = {
  highlight: highlightCode,

  async preload() {
    await initHighlighter().catch((error) => console.error('Highlighter preload failed:', error));
  },
};

Comlink.expose(api);

// Warm up the highlighter immediately, same as the previous protocol version.
initHighlighter().catch(console.error);
