import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { cleanStackTrace } from '~/utils/stacktrace';

interface WebContainerContext {
  loaded: boolean;

  /**
   * Whether the current document could be cross-origin isolated. Embedded
   * views (preview panels, iframes) usually cannot, which prevents the
   * WebContainer runtime from booting in current browsers — see the boot
   * logic below.
   */
  isolationLimited: boolean;
}

const ISOLATION_HINT =
  'This embedded view cannot be cross-origin isolated, so the in-browser dev ' +
  'sandbox (WebContainer) cannot boot — file writes, the terminal and the live ' +
  'preview are unavailable here. Chat still works. For the full build ' +
  'experience, open bolt.diy in a standalone browser tab.';

const NON_ISOLATED_BOOT_TIMEOUT_MS = 20_000;

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
  isolationLimited: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

if (!import.meta.env.SSR) {
  webcontainer =
    import.meta.hot?.data.webcontainer ??
    Promise.resolve()
      .then(() => {
        /*
         * SharedArrayBuffer transfer is only allowed when the document is
         * cross-origin isolated. When bolt.diy is embedded (preview panels,
         * iframes) the ancestors usually are NOT isolated, so
         * `self.crossOriginIsolated` is false and booting with
         * `coep: 'credentialless'` crashes the boot with:
         *   "Failed to execute 'postMessage' on 'Worker': SharedArrayBuffer
         *    transfer requires self.crossOriginIsolated."
         *
         * In that case boot with `coep: 'require-corp'`: the WebContainer
         * runtime iframe is loaded with its own isolation headers plus
         * `allow="cross-origin-isolated"` (set by the API), so the runtime
         * can stay cross-origin isolated in browsers that support the
         * permission delegation. (`coep: 'none'` is NOT a working fallback:
         * it relies on a long-expired Chromium Origin Trial and the runtime
         * still posts a SharedArrayBuffer internally.)
         *
         * If the runtime still cannot boot (current stable Chromium does not
         * implement the `cross-origin-isolated` permission policy), the boot
         * promise would hang forever and freeze every pending file action.
         * Race it against a timeout that rejects with the actionable hint
         * above, so the UI degrades gracefully instead.
         */
        const isolated =
          typeof self !== 'undefined' && 'crossOriginIsolated' in self
            ? Boolean((self as { crossOriginIsolated?: boolean }).crossOriginIsolated)
            : true;

        webcontainerContext.isolationLimited = !isolated;

        const bootPromise = WebContainer.boot({
          coep: isolated ? 'credentialless' : 'require-corp',
          workdirName: WORK_DIR_NAME,
          forwardPreviewErrors: true, // Enable error forwarding from iframes
        });

        if (isolated) {
          return bootPromise;
        }

        return Promise.race([
          bootPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(ISOLATION_HINT)), NON_ISOLATED_BOOT_TIMEOUT_MS);
          }),
        ]);
      })
      .then(async (webcontainer) => {
        webcontainerContext.loaded = true;

        const { workbenchStore } = await import('~/lib/stores/workbench');

        const response = await fetch('/inspector-script.js');
        const inspectorScript = await response.text();
        await webcontainer.setPreviewScript(inspectorScript);

        // Listen for preview errors
        webcontainer.on('preview-message', (message) => {
          console.log('WebContainer preview message:', message);

          // Handle both uncaught exceptions and unhandled promise rejections
          if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
            const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
            const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
            workbenchStore.actionAlert.set({
              type: 'preview',
              title,
              description: 'message' in message ? message.message : 'Unknown error',
              content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
              source: 'preview',
            });
          }
        });

        return webcontainer;
      })
      .catch((error) => {
        /*
         * Surface the failure once, readably, instead of leaving the workbench
         * hanging on "Creating initial files" forever.
         */
        console.error('[webcontainer] boot failed:', error instanceof Error ? error.message : error);

        import('~/lib/stores/workbench')
          .then(({ workbenchStore }) => {
            workbenchStore.actionAlert.set({
              type: 'setup',
              title: 'WebContainer unavailable',
              description: ISOLATION_HINT,
              content: error instanceof Error ? error.message : String(error),
              source: 'terminal',
            });
          })
          .catch(() => undefined);

        throw error;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}
