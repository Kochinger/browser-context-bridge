import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const bridgeCommands = [
  'browserContextBridge.captureElementToClaude',
  'browserContextBridge.captureElementToCodex',
  'browserContextBridge.capturePage',
  'browserContextBridge.captureScreenshot',
  'browserContextBridge.captureArea',
  'browserContextBridge.captureElement',
  'browserContextBridge.selectPage',
  'browserContextBridge.sendLatest',
  'browserContextBridge.showLatest',
];

// The tools this extension invokes. `open_browser_page` is the only one that hands out a
// page ID: VS Code publishes the list of shared pages as chat workspace context, not as a
// tool, so an extension cannot enumerate pages.
const requiredBrowserTools = [
  'open_browser_page',
  'read_page',
  'screenshot_page',
  'run_playwright_code',
];

function manifestCommands(extension: vscode.Extension<unknown>): Set<string> {
  const commands = extension.packageJSON?.contributes?.commands as Array<{ command?: unknown }> | undefined;
  return new Set(
    (commands ?? [])
      .map((entry) => entry.command)
      .filter((command): command is string => typeof command === 'string'),
  );
}

async function waitForBrowserTools(timeoutMs = 5000): Promise<Set<string>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const names = new Set(vscode.lm.tools.map((tool) => tool.name));
    if (requiredBrowserTools.every((name) => names.has(name)) || Date.now() >= deadline) {
      return names;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function textOf(result: vscode.LanguageModelToolResult): string {
  return result.content
    .flatMap((part) =>
      part && typeof part === 'object' && 'value' in part && typeof part.value === 'string'
        ? [part.value]
        : [],
    )
    .join('\n');
}

function withTimeout<T>(work: Thenable<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms),
    ),
  ]);
}


/** Reads a JPEG's pixel size from its SOF marker, without pulling in a decoder. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset < bytes.length - 9) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return undefined;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += length;
  }
  return undefined;
}

/** Capture folder names of one kind, for before/after comparisons. */
async function capturesNamed(suffix: string): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(root, '.vscode', 'browser-context'),
    );
    return entries.map(([name]) => name).filter((name) => name.endsWith(suffix)).sort();
  } catch {
    return [];
  }
}

/** Minimal CDP driver, used to play the user's mouse for the native element picker. */
async function attachDriver(tab: vscode.BrowserTab) {
  const session = await tab.startCDPSession();
  let nextId = 1;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  session.onDidReceiveMessage((message) => {
    if (typeof message.id === 'number') {
      pending.get(message.id)?.(message as Record<string, unknown>);
      pending.delete(message.id);
    }
  });
  const raw = (method: string, params?: object, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      void session.sendMessage({ id, method, params, sessionId });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15000);
    });

  const targets = await raw('Target.getTargets');
  const infos = (targets.result as { targetInfos: Array<{ targetId: string; type: string }> }).targetInfos;
  const target = infos.find((info) => info.type === 'page');
  assert.ok(target, 'The driver found the tab CDP page target');
  const attached = await raw('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = (attached.result as { sessionId: string }).sessionId;

  const send = async (method: string, params?: object) => {
    const message = await raw(method, params, sessionId);
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return (message.result ?? {}) as Record<string, unknown>;
  };
  return { send, close: () => session.close() };
}

async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.browser-context-bridge');
  assert.ok(extension, 'The development extension is discoverable');

  // The status bar indicator is created in activate(), so the extension has to come up
  // on its own via onStartupFinished — not only once a command is invoked.
  for (let attempt = 0; attempt < 50 && !extension.isActive; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(
    extension.isActive,
    true,
    'The extension activates on startup without a command being run',
  );

  await extension.activate();

  // Two toolbar buttons, one per agent, and every other command on the tab's context
  // menu. This is how the feature is discovered, so pin the shape.
  const contributes = extension.packageJSON?.contributes as {
    menus?: Record<string, Array<{ command?: string; when?: string }>>;
  } | undefined;
  const titleButtons = (contributes?.menus?.['editor/title'] ?? []).map((entry) => entry.command);
  assert.deepEqual(
    titleButtons,
    ['browserContextBridge.captureElementToClaude', 'browserContextBridge.captureElementToCodex'],
    'The browser title bar carries exactly the two capture buttons',
  );
  const contextMenu = (contributes?.menus?.['editor/title/context'] ?? []).map((entry) => entry.command);
  for (const command of [
    'browserContextBridge.chooseTarget',
    'browserContextBridge.selectPage',
    'browserContextBridge.clearCaptures',
    'browserContextBridge.captureArea',
  ]) {
    assert.ok(contextMenu.includes(command), `The tab context menu offers ${command}`);
  }

  const registeredCommands = new Set(await vscode.commands.getCommands(true));
  for (const command of bridgeCommands) {
    assert.ok(registeredCommands.has(command), `Bridge command is registered: ${command}`);
  }

  await vscode.workspace.getConfiguration('chat.agent').update('enabled', true, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('workbench.browser').update('enableChatTools', true, vscode.ConfigurationTarget.Global);

  const tools = await waitForBrowserTools();
  const missing = requiredBrowserTools.filter((tool) => !tools.has(tool));
  assert.deepEqual(missing, [], `VS Code no longer contributes the browser tools this extension calls: ${missing.join(', ')}`);
  assert.ok(
    !tools.has('list_browser_pages'),
    'list_browser_pages is back; the page picker can use it again instead of open_browser_page',
  );

  // The headline feature: VS Code's own DevTools element inspector, driven end to end.
  // A second CDP session plays the user's mouse, because the picker waits on a real click.
  const nativeTab = await vscode.window.openBrowserTab('https://example.com');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(
    vscode.window.browserTabs.length > 0,
    'The proposed browser API lists tabs; run with --enable-proposed-api if this fails',
  );

  const nativeConfig = vscode.workspace.getConfiguration('browserContextBridge');
  await nativeConfig.update('target', 'clipboard', vscode.ConfigurationTarget.Global);
  const driver = await attachDriver(nativeTab);
  try {
    await driver.send('DOM.enable');
    await driver.send('Runtime.enable');

    // Inspect-mode hit testing only works while the browser view actually paints, which
    // means the VS Code window has to be in the foreground. Headless CI or a background
    // window cannot exercise the click, so say so loudly rather than fail at random.
    const visibility = await driver.send('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    const pageVisible = (visibility.result as { value: string }).value === 'visible';
    if (!pageVisible) {
      console.warn(
        '[Browser Context Bridge] SKIPPED the element-pick assertions: the test window is '
        + 'not in the foreground, so the browser view does not paint and inspect mode '
        + 'never reports a click. Re-run with the window focused to cover this path.',
      );
    }

    // Push the target below the fold and scroll to it, so the capture only lines up if
    // the scroll offset is handled. On an unscrolled page the trap is invisible.
    await driver.send('Runtime.evaluate', {
      expression: `document.body.style.margin = '0';
        document.body.innerHTML = '<div style="height:1400px;background:rgb(0,0,255)"></div>'
          + '<h1 style="height:120px;margin:0;background:rgb(255,0,0);color:rgb(255,0,0)">Example Domain</h1>'
          + '<div style="height:1400px;background:rgb(0,255,0)"></div>';
        window.scrollTo(0, 1350);
        'ok'`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const scrollState = await driver.send('Runtime.evaluate', {
      expression: 'window.scrollY',
      returnByValue: true,
    });
    assert.ok(
      ((scrollState.result as { value: number }).value ?? 0) > 100,
      'The test page is scrolled, so the clip coordinate space matters',
    );

    const document_ = await driver.send('DOM.getDocument', { depth: 1 });
    const rootId = (document_.root as { nodeId: number }).nodeId;
    const found = await driver.send('DOM.querySelector', { nodeId: rootId, selector: 'h1' });
    const boxModel = await driver.send('DOM.getBoxModel', { nodeId: (found as { nodeId: number }).nodeId });
    const quad = (boxModel.model as { border: number[] }).border;
    const x = (quad[0]! + quad[2]!) / 2;
    const y = (quad[1]! + quad[5]!) / 2;

    if (pageVisible) {
    const picking = vscode.commands.executeCommand('browserContextBridge.captureElement');
    // Give the command time to attach its own session and arm inspect mode.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await withTimeout(picking, 60000, 'browserContextBridge.captureElement');

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, 'The integration workspace is open');
    const captureRoot = vscode.Uri.joinPath(root, '.vscode', 'browser-context');
    const elementCaptures = (await vscode.workspace.fs.readDirectory(captureRoot))
      .map(([name]) => name)
      .filter((name) => name.endsWith('-element'))
      .sort();
    const latestElement = elementCaptures.at(-1);
    assert.ok(latestElement, 'The native picker wrote an element capture');

    const elementDirectory = vscode.Uri.joinPath(captureRoot, latestElement);
    const elementFiles = new Set(
      (await vscode.workspace.fs.readDirectory(elementDirectory)).map(([name]) => name),
    );
    const elementMarkdown = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(elementDirectory, 'context.md')),
    );
    assert.match(elementMarkdown, /<h1[^>]*>Example Domain<\/h1>/, "The clicked element HTML was captured");
    assert.match(elementMarkdown, /- Element: h1/, 'The clicked element is named');
    // A picker that mutates the page leaks its highlight styles into the capture.
    assert.doesNotMatch(elementMarkdown, /outline: 2px solid/, 'The picker left no styles on the element');
    const elementShot = /^- Screenshot: `([^`]+)`$/m.exec(elementMarkdown)?.[1];
    assert.ok(elementShot, 'The element capture references a screenshot');
    assert.ok(elementFiles.has(elementShot), `The element screenshot exists: ${elementShot}`);

    // Guards the clip coordinate trap: DOM.getBoxModel reports viewport coordinates
    // while Page.captureScreenshot clips in document coordinates. Getting that wrong
    // silently crops the wrong region rather than failing.
    const shotBytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(elementDirectory, elementShot),
    );
    const size = jpegSize(shotBytes);
    assert.ok(size, 'The element screenshot is a readable JPEG');
    const declared = /- Dimensions: (\d+) × (\d+) px/.exec(elementMarkdown);
    assert.ok(declared, 'context.md states the element dimensions');
    const expectedWidth = Number(declared[1]);
    const expectedHeight = Number(declared[2]);
    assert.ok(
      Math.abs(size.width - expectedWidth) <= 2 && Math.abs(size.height - expectedHeight) <= 2,
      `The screenshot covers the element: got ${size.width}×${size.height}, element is ${expectedWidth}×${expectedHeight}`,
    );

    // Size alone cannot tell a correct crop from one offset by the scroll position, so
    // check the pixels: the element is solid red, its neighbours blue and green.
    const sampled = await driver.send('Runtime.evaluate', {
      expression: `(async () => {
        const img = new Image();
        img.src = 'data:image/jpeg;base64,${Buffer.from(shotBytes).toString('base64')}';
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        const pixel = context.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
        return JSON.stringify({ r: pixel[0], g: pixel[1], b: pixel[2] });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const pixel = JSON.parse((sampled.result as { value: string }).value) as { r: number; g: number; b: number };
    assert.ok(
      pixel.r > 200 && pixel.g < 80 && pixel.b < 80,
      `The screenshot shows the element itself, not a region offset by the scroll position: centre pixel was ${JSON.stringify(pixel)}`,
    );
    }
  } finally {
    await driver.close();
    await nativeTab.close();
    await nativeConfig.update('target', undefined, vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Exercise the real page-acquisition path end to end.
  const opened = await vscode.lm.invokeTool('open_browser_page', {
    toolInvocationToken: undefined,
    input: { url: 'https://example.com' },
  });
  const pageId = /^\s*Page ID:\s*(\S+)\s*$/m.exec(textOf(opened))?.[1];
  assert.ok(pageId, `open_browser_page returned a usable page ID: ${textOf(opened).slice(0, 200)}`);

  const snapshot = await vscode.lm.invokeTool('read_page', {
    toolInvocationToken: undefined,
    input: { pageId },
  });
  assert.match(textOf(snapshot), /Example Domain/, 'read_page returns the page snapshot');

  const shot = await vscode.lm.invokeTool('screenshot_page', {
    toolInvocationToken: undefined,
    input: { pageId },
  });
  const image = shot.content.find(
    (part): part is vscode.LanguageModelDataPart =>
      !!part && typeof part === 'object' && 'mimeType' in part && 'data' in part,
  );
  assert.ok(image, 'screenshot_page returns image data');
  assert.match(image.mimeType, /^image\//, 'screenshot_page returns an image mime type');

  // Drive the real command end to end and check the artifacts it leaves behind.
  const bridgeConfig = vscode.workspace.getConfiguration('browserContextBridge');
  await bridgeConfig.update('pageUrl', 'https://example.com', vscode.ConfigurationTarget.Global);
  await bridgeConfig.update('target', 'clipboard', vscode.ConfigurationTarget.Global);
  try {
    await withTimeout(
      vscode.commands.executeCommand('browserContextBridge.capturePage'),
      90000,
      'browserContextBridge.capturePage',
    );

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(workspaceRoot, 'The integration workspace is open');
    const captureRoot = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'browser-context');
    const captures = (await vscode.workspace.fs.readDirectory(captureRoot))
      .map(([name]) => name)
      .filter((name) => name.endsWith('-page'))
      .sort();
    const latest = captures.at(-1);
    assert.ok(latest, 'capturePage wrote a capture directory');

    const directory = vscode.Uri.joinPath(captureRoot, latest);
    console.log('[Browser Context Bridge] capture directory: ' + directory.fsPath);
    const written = new Set((await vscode.workspace.fs.readDirectory(directory)).map(([name]) => name));
    assert.ok(written.has('context.md'), 'The capture contains context.md');

    const markdown = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'context.md')),
    );
    // Guards the snapshot delta trap: VS Code answers `<unchanged>` once an earlier
    // tool call consumed the full snapshot, which used to empty out context.md.
    assert.doesNotMatch(markdown, /<unchanged>|<unavailable>/, 'context.md carries a real snapshot');
    assert.match(markdown, /heading "Example Domain"/, 'context.md carries the accessibility snapshot');

    const referenced = /^- Screenshot: `([^`]+)`$/m.exec(markdown)?.[1];
    assert.ok(referenced, `context.md references its screenshot: ${markdown.slice(0, 300)}`);
    assert.ok(
      written.has(referenced),
      `context.md references a file that exists: ${referenced} not in ${[...written].join(', ')}`,
    );
  } finally {
    await bridgeConfig.update('pageUrl', undefined, vscode.ConfigurationTarget.Global);
    await bridgeConfig.update('target', undefined, vscode.ConfigurationTarget.Global);
  }

  // The area picker clips against the viewport; a page-coordinate clip fails once the
  // page is scrolled. This rewrites the document, so it runs on a page of its own.
  const scratch = await vscode.lm.invokeTool('open_browser_page', {
    toolInvocationToken: undefined,
    input: { url: 'https://example.com/', forceNew: true },
  });
  const scratchId = /^\s*Page ID:\s*(\S+)\s*$/m.exec(textOf(scratch))?.[1];
  assert.ok(scratchId, 'A scratch page could be opened for the clip check');
  assert.notEqual(scratchId, pageId, 'forceNew opened a page separate from the captured one');

  const scrolled = await vscode.lm.invokeTool('run_playwright_code', {
    toolInvocationToken: undefined,
    input: {
      pageId: scratchId,
      timeoutMs: 15000,
      code: `
        await page.evaluate(() => {
          document.body.style.margin = '0';
          document.body.innerHTML = '<div style="height:1000px"></div><div style="height:2000px"></div>';
          window.scrollTo(0, 1000);
        });
        const viewport = await page.screenshot({ type: 'png', clip: { x: 0, y: 10, width: 20, height: 20 } });
        let pageRelativeFailed = false;
        try {
          await page.screenshot({ type: 'png', clip: { x: 0, y: 1010, width: 20, height: 20 } });
        } catch {
          pageRelativeFailed = true;
        }
        return { viewportClipBytes: viewport.length, pageRelativeFailed };
      `,
    },
  });
  const clip = /Result: (\{.*\})/.exec(textOf(scrolled))?.[1];
  assert.ok(clip, `run_playwright_code returned a result: ${textOf(scrolled).slice(0, 200)}`);
  const clipResult = JSON.parse(clip) as { viewportClipBytes: number; pageRelativeFailed: boolean };
  assert.ok(clipResult.viewportClipBytes > 0, 'A viewport-relative clip captures pixels');
  assert.ok(clipResult.pageRelativeFailed, 'A page-relative clip is rejected once the page is scrolled');

  // Escape must abort the picker. CDP inspect mode reports clicks but never a
  // cancellation, so this checks the in-page listener that supplies it.
  {
    const escTab = await vscode.window.openBrowserTab('https://example.com');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const escDriver = await attachDriver(escTab);
    try {
      await escDriver.send('Runtime.enable');
      const escVisibility = await escDriver.send('Runtime.evaluate', {
        expression: 'document.visibilityState',
        returnByValue: true,
      });
      // Same constraint as the pick itself: with the window in the background the page
      // never takes focus, so a synthetic Escape does not reach the in-page listener.
      const escVisible = (escVisibility.result as { value: string }).value === 'visible';
      if (!escVisible) {
        console.warn(
          '[Browser Context Bridge] SKIPPED the Escape-cancels assertion: the test window '
          + 'is not in the foreground. Re-run with the window focused to cover this path.',
        );
      } else {
        const before = await capturesNamed('-element');

        const picking = vscode.commands.executeCommand('browserContextBridge.captureElement');
        await new Promise((resolve) => setTimeout(resolve, 4000));

        for (const type of ['rawKeyDown', 'keyUp'] as const) {
          await escDriver.send('Input.dispatchKeyEvent', {
            type,
            key: 'Escape',
            code: 'Escape',
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
          });
        }

        await withTimeout(picking, 30000, 'captureElement cancelled with Escape');
        const after = await capturesNamed('-element');
        assert.deepEqual(after, before, 'Escape aborted the pick without writing a capture');

        // The listener must be gone again, or every later key press in the page is hooked.
        const leftover = await escDriver.send('Runtime.evaluate', {
          expression: 'typeof window.__browserContextBridgeCleanupPick',
          returnByValue: true,
        });
        assert.equal(
          (leftover.result as { value: string }).value,
          'undefined',
          'The Escape listener was removed from the page again',
        );
      }
    } finally {
      await escDriver.close();
      await escTab.close();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Handing a capture to Claude Code must not leave an editor tab behind: its
  // insertAtMention command reads the active editor, so the file is opened for a
  // moment and has to be closed again.
  const latest = vscode.workspace.getConfiguration('browserContextBridge');
  await latest.update('target', 'claude', vscode.ConfigurationTarget.Global);
  try {
    try {
      await withTimeout(
        vscode.commands.executeCommand('browserContextBridge.sendLatest'),
        45000,
        'browserContextBridge.sendLatest',
      );
    } catch (error) {
      // Claude may refuse (not signed in, no chat surface). The tab hygiene below is
      // what this case is about, and it must hold either way.
      console.log('[Browser Context Bridge] sendLatest to Claude reported: ' + String(error));
    }

    const strayTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText
        && tab.input.uri.path.includes('browser-context')
        && tab.input.uri.path.endsWith('context.md'));
    assert.deepEqual(
      strayTabs.map((tab) => tab.label),
      [],
      'The Claude hand-off left no capture file open in an editor tab',
    );
  } finally {
    await latest.update('target', undefined, vscode.ConfigurationTarget.Global);
  }

  // Guards the shipped default. Note this cannot detect a stray quick pick: in a test
  // host an unanswered quick pick resolves by itself, so the command still settles.
  // The no-prompt behaviour is covered by the resolveTarget unit tests instead.
  const defaults = vscode.workspace.getConfiguration('browserContextBridge');
  await defaults.update('target', undefined, vscode.ConfigurationTarget.Global);
  assert.equal(
    defaults.inspect('target')?.defaultValue,
    'auto',
    'The shipped default resolves a target instead of prompting',
  );
  await withTimeout(
    vscode.commands.executeCommand('browserContextBridge.sendLatest'),
    30000,
    'browserContextBridge.sendLatest with the default target',
  );

  // Removing captures is destructive, so pin that it only ever touches its own folders.
  // The startup sweep itself runs at activation and is covered by the capturesToSweep
  // unit tests; what is checked here is the explicit sweep and what it spares.
  {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(workspaceRoot, 'The integration workspace is open');
    const captureRoot = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'browser-context');

    for (const name of ['2020-01-01T00-00-00-000Z-element', '2020-01-02T00-00-00-000Z-page']) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(captureRoot, name));
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(captureRoot, 'my-notes'));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(captureRoot, 'keep-me.txt'),
      new TextEncoder().encode('not a capture'),
    );

    await vscode.commands.executeCommand('browserContextBridge.clearCaptures');

    const remaining = (await vscode.workspace.fs.readDirectory(captureRoot)).map(([name]) => name);
    assert.deepEqual(
      remaining.filter((name) => /Z-(page|screenshot|element)$/.test(name)),
      [],
      'Clear Captured Context removed every capture',
    );
    assert.ok(
      remaining.includes('my-notes') && remaining.includes('keep-me.txt'),
      `Clear Captured Context left unrelated entries alone: ${remaining.join(', ')}`,
    );
  }

  const codex = vscode.extensions.getExtension('openai.chatgpt');
  assert.ok(codex, 'The official Codex extension is installed');
  assert.ok(manifestCommands(codex).has('chatgpt.addFileToThread'), 'Codex exposes its file handoff command');

  const claude = vscode.extensions.getExtension('anthropic.claude-code');
  assert.ok(claude, 'The official Claude Code extension is installed');
  assert.ok(manifestCommands(claude).has('claude-vscode.insertAtMention'), 'Claude exposes its @-mention handoff command');

  console.log('[Browser Context Bridge] Integration smoke test passed.');
}

export { run };
