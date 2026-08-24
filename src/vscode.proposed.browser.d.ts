/**
 * Minimal declarations for VS Code's proposed `browser` API, transcribed from the
 * runtime surface of VS Code 1.129. Only the members this extension uses are declared.
 *
 * The proposal is opt-in: it works when the extension runs from an
 * `--extensionDevelopmentPath`, or when VS Code is started with
 * `--enable-proposed-api local.browser-context-bridge`. Everywhere else, touching
 * `window.browserTabs` throws, which is why every access goes through
 * `nativeBrowserTabs()` in `nativeBrowser.ts`.
 */
declare module 'vscode' {
  /** A raw Chrome DevTools Protocol session, scoped to one browser tab. */
  export interface BrowserTabCDPSession {
    /** Responses (carrying `id`) and events (carrying `method`) share this channel. */
    readonly onDidReceiveMessage: Event<{
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
      sessionId?: string;
    }>;
    readonly onDidClose: Event<void>;
    sendMessage(message: {
      id: number;
      method: string;
      params?: object;
      sessionId?: string;
    }): Thenable<void>;
    close(): Thenable<void>;
  }

  export interface BrowserTab {
    readonly url: string;
    readonly title: string;
    readonly icon: Uri | ThemeIcon;
    startCDPSession(): Thenable<BrowserTabCDPSession>;
    close(): Thenable<void>;
  }

  export namespace window {
    export const browserTabs: readonly BrowserTab[];
    export const activeBrowserTab: BrowserTab | undefined;
    export const onDidOpenBrowserTab: Event<BrowserTab>;
    export const onDidCloseBrowserTab: Event<BrowserTab>;
    export const onDidChangeActiveBrowserTab: Event<BrowserTab | undefined>;
    export const onDidChangeBrowserTabState: Event<BrowserTab>;
    export function openBrowserTab(
      url: string,
      options?: { viewColumn?: ViewColumn; preserveFocus?: boolean; background?: boolean },
    ): Thenable<BrowserTab>;
  }
}
