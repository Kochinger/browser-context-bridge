import * as vscode from 'vscode';
import { ArtifactStore, clearCaptures, sweepPreviousSessions, type CaptureArtifacts } from './artifacts.js';
import { IntegratedBrowserTools } from './browserTools.js';
import {
  areaContextMarkdown,
  elementContextMarkdown,
  pageContextMarkdown,
  screenshotContextMarkdown,
  targetIndicatorLabel,
  type TargetSetting,
} from './core.js';
import {
  chooseNativeTab,
  nativeBrowserAvailable,
  pickElementNatively,
} from './nativeBrowser.js';
import { chooseTarget, installedAgentTargets, reselectTarget, sendArtifacts } from './targets.js';
import type { Target } from './core.js';

function maxTextLength(): number {
  return vscode.workspace
    .getConfiguration('browserContextBridge')
    .get<number>('maxTextLength', 120000);
}

async function sendAfterCapture(
  artifacts: CaptureArtifacts,
  targetOverride?: Target,
): Promise<void> {
  const target = targetOverride ?? (await chooseTarget());
  if (target) {
    await sendArtifacts(artifacts, target);
  }
}

/**
 * At most one picker runs at a time, and invoking the capture command again while one is
 * running stops it. That gives a cancel path that never touches the page: the overlay
 * handles mouse input before the page does, so a mouse gesture inside the page can be
 * delivered as a pick and as a cancel at once.
 */
let activePick: vscode.CancellationTokenSource | undefined;

async function runPicker<T>(
  title: string,
  task: (token: vscode.CancellationToken) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (activePick) {
    activePick.cancel();
    return undefined;
  }
  const source = new vscode.CancellationTokenSource();
  activePick = source;
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, progressToken) => {
        const link = progressToken.onCancellationRequested(() => source.cancel());
        try {
          return await task(source.token);
        } finally {
          link.dispose();
        }
      },
    );
  } finally {
    activePick = undefined;
    source.dispose();
  }
}

async function reportErrors(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('VS Code browser tools are unavailable')) {
      const enableAction = 'Enable VS Code AI Features';
      const settingsAction = 'Open Browser Settings';
      const selected = await vscode.window.showErrorMessage(
        `Browser Context Bridge: ${message}`,
        enableAction,
        settingsAction,
      );
      if (selected === enableAction) {
        await vscode.commands.executeCommand('workbench.action.chat.triggerSetup');
      } else if (selected === settingsAction) {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@id:workbench.browser.enableChatTools',
        );
      }
      return;
    }
    // Logged as well as shown: a toast is easy to miss, and awaiting one would keep
    // the command pending until it is clicked away.
    console.error('[Browser Context Bridge]', error);
    void vscode.window.showErrorMessage(`Browser Context Bridge: ${message}`);
  }
}

/**
 * VS Code offers no way to ask which agent view is visible in the sidebar, so the
 * target cannot follow the focused chat. The status bar shows where captures go and
 * switches it in one click instead.
 */
function createTargetIndicator(): vscode.StatusBarItem & { refresh: () => void } {
  const item = vscode.window.createStatusBarItem(
    'browserContextBridge.target',
    vscode.StatusBarAlignment.Right,
    1000,
  );
  // A named item is listed in the status bar's right-click menu, so it can be found
  // again — and re-enabled — if it was hidden or pushed into the overflow.
  item.name = 'Browser Context Bridge';
  item.command = 'browserContextBridge.chooseTarget';
  const refresh = () => {
    const setting = vscode.workspace
      .getConfiguration('browserContextBridge')
      .get<TargetSetting>('target', 'auto');
    item.text = `$(inspect) ${targetIndicatorLabel(setting, installedAgentTargets())}`;
    item.tooltip = 'Browser Context Bridge: where captures go. Click to change.';
  };
  refresh();
  item.show();
  return Object.assign(item, { refresh });
}

/**
 * One element capture, optionally pinned to an agent. The two toolbar buttons pass a
 * target so a click lands in that chat directly; the palette command follows the
 * configured target instead.
 */
async function captureElement(
  browser: IntegratedBrowserTools,
  store: ArtifactStore,
  targetOverride?: Target,
): Promise<void> {
  const pickerTitle = 'Click an element in the browser — Esc, or run the command again, to cancel.';

  // Preferred path: the same DevTools inspector VS Code's own "Add Element to Chat"
  // uses. It needs the `browser` API proposal; without it, fall through to the
  // picker built on the public browser tools.
  if (nativeBrowserAvailable()) {
    const tab = await chooseNativeTab();
    if (!tab) {
      return;
    }
    const captured = await runPicker(pickerTitle, (token) => pickElementNatively(tab, token));
    if (!captured) {
      return;
    }
    const artifacts = await store.write(
      'element',
      (imageName) => elementContextMarkdown(captured.element, maxTextLength(), imageName),
      captured.image,
    );
    await sendAfterCapture(artifacts, targetOverride);
    return;
  }

  const page = (await browser.resolvePage())?.page;
  if (!page) {
    return;
  }
  const element = await runPicker(pickerTitle, (token) => browser.pickElement(page.id, token));
  if (!element) {
    return;
  }
  const image = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Capturing selected element…' },
    (_progress, token) => browser.screenshot(
      page.id,
      { selector: element.selector, element: element.displayName },
      token,
    ),
  );
  const artifacts = await store.write(
    'element',
    (imageName) => elementContextMarkdown(element, maxTextLength(), imageName),
    image,
  );
  await sendAfterCapture(artifacts, targetOverride);
}

const SETUP_DISMISSED_KEY = 'proposedApiSetupDismissed';
const ARGV_SNIPPET = '"enable-proposed-api": ["local.browser-context-bridge"]';

/**
 * The native picker needs the `browser` API proposal, which only the user can grant.
 * Rather than leaving that to the README, offer it once: the argv.json VS Code actually
 * reads is opened by its own command — no path guessing across VS Code flavours — and
 * the line to paste is put on the clipboard. The file itself is never rewritten, so a
 * hand-edited argv.json cannot be damaged.
 */
async function offerProposedApiSetup(context: vscode.ExtensionContext): Promise<void> {
  if (nativeBrowserAvailable() || context.globalState.get<boolean>(SETUP_DISMISSED_KEY)) {
    return;
  }
  const setUp = 'Set up';
  const notNow = 'Not now';
  const choice = await vscode.window.showInformationMessage(
    'Browser Context Bridge works, but the DevTools element picker is switched off. Enabling it takes one line in VS Code\u2019s runtime arguments.',
    setUp,
    notNow,
  );
  if (choice === notNow) {
    await context.globalState.update(SETUP_DISMISSED_KEY, true);
    return;
  }
  if (choice !== setUp) {
    return;
  }

  await vscode.env.clipboard.writeText(ARGV_SNIPPET);
  await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
  const quit = 'Quit VS Code';
  const done = await vscode.window.showInformationMessage(
    'Paste the line from your clipboard inside the outermost { } of argv.json, save, then start VS Code again. A window reload is not enough \u2014 the file is read once at startup.',
    quit,
  );
  if (done === quit) {
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const browser = new IntegratedBrowserTools(context.workspaceState);
  const store = new ArtifactStore(context);
  const indicator = createTargetIndicator();

  void offerProposedApiSetup(context).catch((error: unknown) => {
    console.error('[Browser Context Bridge] proposed API setup prompt failed', error);
  });

  // Captures from earlier runs of VS Code go away here, not when it closes: a crash or a
  // force quit would skip a shutdown hook, a startup sweep always runs.
  void sweepPreviousSessions(context).catch((error: unknown) => {
    console.error('[Browser Context Bridge] sweeping old captures failed', error);
  });

  context.subscriptions.push(
    indicator,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('browserContextBridge.target')) {
        indicator.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('browserContextBridge.capturePage', () => reportErrors(async () => {
      const resolved = await browser.resolvePage();
      if (!resolved) {
        return;
      }
      const { page, summary } = resolved;
      const image = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Capturing browser page context…' },
        (_progress, token) => browser.screenshot(page.id, {}, token),
      );
      const artifacts = await store.write(
        'page',
        (imageName) => pageContextMarkdown(page, summary.snapshot, maxTextLength(), imageName),
        image,
      );
      await sendAfterCapture(artifacts);
    })),

    vscode.commands.registerCommand('browserContextBridge.captureScreenshot', () => reportErrors(async () => {
      const page = (await browser.resolvePage())?.page;
      if (!page) {
        return;
      }
      const image = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Capturing browser screenshot…' },
        (_progress, token) => browser.screenshot(page.id, {}, token),
      );
      const artifacts = await store.write(
        'screenshot',
        (imageName) => screenshotContextMarkdown(page, imageName),
        image,
      );
      await sendAfterCapture(artifacts);
    })),

    vscode.commands.registerCommand('browserContextBridge.captureArea', () => reportErrors(async () => {
      const page = (await browser.resolvePage())?.page;
      if (!page) {
        return;
      }
      const area = await runPicker(
        'Drag an area in the browser — Esc, or run the command again, to cancel.',
        (token) => browser.pickArea(page.id, token),
      );
      if (!area) {
        return;
      }
      const image = {
        data: Uint8Array.from(Buffer.from(area.screenshotBase64, 'base64')),
        mimeType: area.mimeType,
      };
      const artifacts = await store.write(
        'screenshot',
        (imageName) => areaContextMarkdown(area, imageName),
        image,
      );
      await sendAfterCapture(artifacts);
    })),

    ...['captureElement', 'captureElementToClaude', 'captureElementToCodex'].map((name) => {
      const targetOverride: Target | undefined =
        name === 'captureElementToClaude' ? 'claude'
        : name === 'captureElementToCodex' ? 'codex'
        : undefined;
      return vscode.commands.registerCommand(`browserContextBridge.${name}`, () => reportErrors(
        () => captureElement(browser, store, targetOverride),
      ));
    }),

    vscode.commands.registerCommand('browserContextBridge.chooseTarget', () => reportErrors(async () => {
      await reselectTarget();
    })),

    vscode.commands.registerCommand('browserContextBridge.clearCaptures', () => reportErrors(async () => {
      const removed = await clearCaptures(context);
      void vscode.window.showInformationMessage(
        removed === 0 ? 'No captured browser context to remove.' : `Removed ${removed} captured context folder(s).`,
      );
    })),

    vscode.commands.registerCommand('browserContextBridge.selectPage', () => reportErrors(async () => {
      await browser.forgetPage();
      const page = (await browser.resolvePage(undefined, { alwaysAsk: true }))?.page;
      if (page) {
        void vscode.window.showInformationMessage(
          `Browser Context Bridge captures from “${page.label}”.`,
        );
      }
    })),

    vscode.commands.registerCommand('browserContextBridge.sendLatest', () => reportErrors(async () => {
      const latest = store.latest();
      if (!latest) {
        void vscode.window.showInformationMessage('No browser context has been captured yet.');
        return;
      }
      const target = await chooseTarget();
      if (target) {
        await sendArtifacts(latest, target);
      }
    })),

    vscode.commands.registerCommand('browserContextBridge.showLatest', () => reportErrors(async () => {
      const latest = store.latest();
      if (!latest) {
        void vscode.window.showInformationMessage('No browser context has been captured yet.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(latest.context);
      await vscode.window.showTextDocument(document, { preview: false });
    })),
  );
}

export function deactivate(): void {}
