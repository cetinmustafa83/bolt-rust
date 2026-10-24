import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';

export class TerminalStore {
  #webcontainer: Promise<WebContainer>;
  #terminals: Array<{ terminal: ITerminal; process: WebContainerProcess }> = [];
  #boltTerminal = newBoltShellProcess();
  #pendingBoltOutput = '';
  #boltOutputReady = false;

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }
  get boltTerminal() {
    return this.#boltTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  writeToBoltTerminal(data: string) {
    const terminal = this.#boltTerminal.terminal;

    if (terminal && this.#boltOutputReady) {
      terminal.write(data);
    } else {
      // Tools can start before the workbench mounts its terminal.
      this.#pendingBoltOutput = (this.#pendingBoltOutput + data).slice(-64_000);
    }
  }

  async attachBoltTerminal(terminal: ITerminal) {
    this.#boltOutputReady = false;

    try {
      const wc = await this.#webcontainer;
      await this.#boltTerminal.init(wc, terminal);

      if (this.#pendingBoltOutput) {
        terminal.write(this.#pendingBoltOutput);
        this.#pendingBoltOutput = '';
      }

      this.#boltOutputReady = true;
    } catch (error: any) {
      /*
       * The raw failure (e.g. "Failed to execute 'postMessage' on 'Worker':
       * SharedArrayBuffer transfer requires self.crossOriginIsolated.") is
       * meaningless to users — translate the known embedded-view case into an
       * actionable hint and keep the raw message for everything else.
       */
      const message = String(error?.message ?? error);

      if (message.includes('crossOriginIsolated') || message.includes('cross-origin isolated')) {
        terminal.write(
          coloredText.red('WebContainer unavailable in this embedded view\n\n') +
            'The in-browser sandbox needs cross-origin isolation, which embedded ' +
            'previews cannot provide. Chat still works. Open bolt.diy in a ' +
            'standalone tab (e.g. "Open in New Tab") for the terminal, file ' +
            'writes and the live preview.\n\n',
        );
      } else {
        terminal.write(coloredText.red('Failed to spawn bolt shell\n\n') + message);
      }

      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    try {
      const shellProcess = await newShellProcess(await this.#webcontainer, terminal);
      this.#terminals.push({ terminal, process: shellProcess });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }
  }

  async detachTerminal(terminal: ITerminal) {
    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      const { process } = this.#terminals[terminalIndex];

      try {
        process.kill();
      } catch (error) {
        console.warn('Failed to kill terminal process:', error);
      }
      this.#terminals.splice(terminalIndex, 1);
    }
  }
}
