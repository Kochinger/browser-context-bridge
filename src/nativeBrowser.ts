import * as vscode from 'vscode';
import { CdpPage } from './cdp.js';
import type { ElementCapture } from './core.js';

export type CapturedImage = { data: Uint8Array; mimeType: string };

export type NativeElementCapture = {
  element: ElementCapture;
  image?: CapturedImage;
};

/**
 * The DevTools highlight VS Code itself uses for "Add Element to Chat": content, padding,
 * border and margin boxes plus the tag/size tooltip, drawn by the browser rather than by
 * anything injected into the page.
 */
const highlightConfig = {
  showInfo: true,
  showStyles: true,
  showRulers: false,
  showExtensionLines: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

/**
 * Runs with `this` bound to the clicked element via `Runtime.callFunctionOn`. It only
 * reads — unlike an injected picker it never writes styles, so the captured outerHTML
 * and computed CSS are exactly what the page renders.
 */
const extractElement = `function () {
  const target = this;

  const cssPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += '#' + CSS.escape(current.id);
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };

  const htmlPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += '#' + current.id;
      if (current.classList.length) part += '.' + Array.from(current.classList).join('.');
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  const rect = target.getBoundingClientRect();
  const computed = getComputedStyle(target);
  const computedStyle = Array.from(computed)
    .map((property) => property + ': ' + computed.getPropertyValue(property) + ';')
    .join('\\n');

  return {
    url: location.href,
    title: document.title,
    selector: cssPath(target),
    displayName: target.tagName.toLowerCase()
      + (target.id ? '#' + target.id : '')
      + Array.from(target.classList).map((name) => '.' + name).join(''),
    htmlPath: htmlPath(target),
    outerHTML: target.outerHTML,
    computedStyle,
    innerText: target.innerText || target.textContent || '',
    dimensions: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}`;

/**
 * Escape has to be observed inside the page: CDP's inspect mode reports a click but never
 * an abort. A Runtime binding is used rather than a polled flag, so the page keeps its
 * appearance — no styles, no elements, just one keydown listener, removed again when the
 * pick ends.
 *
 * Mouse buttons are deliberately not used for cancelling: the overlay handles mouse input
 * before the page does, so a right-click can arrive as a pick and as a cancel at the same
 * time. The reliable ways out live outside the page — see `runPicker` in extension.ts.
 */
const CANCEL_BINDING = 'browserContextBridgeCancelPick';
const CLEANUP_HANDLE = '__browserContextBridgeCleanupPick';

const installCancelListeners = `(() => {
  if (window.${CLEANUP_HANDLE}) window.${CLEANUP_HANDLE}();
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
    if (typeof window.${CANCEL_BINDING} === 'function') window.${CANCEL_BINDING}('escape');
  };
  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, true);
    delete window.${CLEANUP_HANDLE};
  };
  window.${CLEANUP_HANDLE} = cleanup;
  document.addEventListener('keydown', onKeyDown, true);
  return true;
})()`;

const removeCancelListeners = `(() => {
  if (window.${CLEANUP_HANDLE}) window.${CLEANUP_HANDLE}();
  return true;
})()`;

/**
 * `window.browserTabs` throws when the `browser` API proposal is not enabled for this
 * extension, which is the normal case for a plain VSIX install.
 */
export function nativeBrowserTabs(): readonly vscode.BrowserTab[] | undefined {
  try {
    const tabs = vscode.window.browserTabs;
    return Array.isArray(tabs) ? tabs : undefined;
  } catch {
    return undefined;
  }
}

export function nativeBrowserAvailable(): boolean {
  return nativeBrowserTabs() !== undefined;
}

function activeNativeTab(): vscode.BrowserTab | undefined {
  try {
    return vscode.window.activeBrowserTab;
  } catch {
    return undefined;
  }
}

/** Tabs carry no stable ID across the API boundary, so they are matched by identity. */
export async function chooseNativeTab(): Promise<vscode.BrowserTab | undefined> {
  const tabs = nativeBrowserTabs() ?? [];
  if (tabs.length === 0) {
    const open = await vscode.window.showWarningMessage(
      'No integrated browser tab is open.',
      'Open Integrated Browser',
    );
    if (open) {
      await vscode.commands.executeCommand('workbench.action.browser.open');
    }
    return undefined;
  }

  const active = activeNativeTab();
  if (active && tabs.includes(active)) {
    return active;
  }
  if (tabs.length === 1) {
    return tabs[0];
  }

  const picked = await vscode.window.showQuickPick(
    tabs.map((tab) => ({ label: tab.title || tab.url, description: tab.url, tab })),
    { title: 'Choose a browser tab to capture from' },
  );
  return picked?.tab;
}

/**
 * The same element picker VS Code's own "Add Element to Chat" uses: the browser draws
 * the hover highlight, and clicking reports the node over CDP.
 */
export async function pickElementNatively(
  tab: vscode.BrowserTab,
  token?: vscode.CancellationToken,
): Promise<NativeElementCapture | undefined> {
  const page = await CdpPage.attach(tab);
  try {
    await page.send('DOM.enable');
    await page.send('Overlay.enable');
    await page.send('Runtime.enable');
    await page.send('Runtime.addBinding', { name: CANCEL_BINDING });
    await page.send('Runtime.evaluate', { expression: installCancelListeners });
    await page.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig });

    const backendNodeId = await waitForInspectedNode(page, token);
    if (backendNodeId === undefined) {
      return undefined;
    }

    const element = await readElement(page, backendNodeId);
    const image = await captureElementImage(page, backendNodeId);
    return { element, image };
  } finally {
    // Leave the page as it was found, even when the pick failed midway.
    await page.send('Overlay.setInspectMode', { mode: 'none', highlightConfig }).catch(() => undefined);
    await page.send('Overlay.hideHighlight').catch(() => undefined);
    await page.send('Runtime.evaluate', { expression: removeCancelListeners }).catch(() => undefined);
    await page.send('Runtime.removeBinding', { name: CANCEL_BINDING }).catch(() => undefined);
    page.dispose();
  }
}

function waitForInspectedNode(
  page: CdpPage,
  token?: vscode.CancellationToken,
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    const subscriptions: vscode.Disposable[] = [];
    const settle = (value: number | undefined) => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      resolve(value);
    };
    subscriptions.push(
      page.onEvent<{ backendNodeId: number }>('Overlay.inspectNodeRequested', (params) =>
        settle(params.backendNodeId),
      ),
      page.onEvent<{ name: string }>('Runtime.bindingCalled', (params) => {
        if (params.name === CANCEL_BINDING) {
          settle(undefined);
        }
      }),
    );
    if (token) {
      subscriptions.push(token.onCancellationRequested(() => settle(undefined)));
    }
  });
}

async function readElement(page: CdpPage, backendNodeId: number): Promise<ElementCapture> {
  const { object } = await page.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
  if (!object.objectId) {
    throw new Error('The clicked element could not be resolved.');
  }
  try {
    const { result, exceptionDetails } = await page.send<{
      result: { value?: ElementCapture };
      exceptionDetails?: { text: string };
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: extractElement,
      returnByValue: true,
    });
    if (exceptionDetails || !result.value) {
      throw new Error(`Reading the clicked element failed: ${exceptionDetails?.text ?? 'no value returned'}`);
    }
    return result.value;
  } finally {
    await page.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  }
}

/**
 * `DOM.getBoxModel` reports viewport coordinates while `Page.captureScreenshot` clips in
 * document coordinates, so the scroll offset has to be added back in.
 */
async function captureElementImage(page: CdpPage, backendNodeId: number): Promise<CapturedImage | undefined> {
  try {
    await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    const { model } = await page.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId });
    const quad = model.border;
    const xs = [quad[0], quad[2], quad[4], quad[6]].filter((value): value is number => value !== undefined);
    const ys = [quad[1], quad[3], quad[5], quad[7]].filter((value): value is number => value !== undefined);
    if (xs.length < 4 || ys.length < 4) {
      return undefined;
    }

    const { result } = await page.send<{ result: { value?: { scrollX: number; scrollY: number } } }>(
      'Runtime.evaluate',
      { expression: '({ scrollX: window.scrollX, scrollY: window.scrollY })', returnByValue: true },
    );
    const scrollX = result.value?.scrollX ?? 0;
    const scrollY = result.value?.scrollY ?? 0;

    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (width < 1 || height < 1) {
      return undefined;
    }

    const clip = {
      x: Math.min(...xs) + scrollX,
      y: Math.min(...ys) + scrollY,
      width,
      height,
      scale: 1,
    };
    const shot = await capture(page, clip);
    return { data: Uint8Array.from(Buffer.from(shot, 'base64')), mimeType: 'image/jpeg' };
  } catch (error) {
    // The element context is still worth keeping, but a silently missing screenshot is
    // hard to diagnose, so say why it is missing.
    console.error('[Browser Context Bridge] element screenshot failed', error);
    return undefined;
  }
}

type Clip = { x: number; y: number; width: number; height: number; scale: number };

/**
 * `captureBeyondViewport` is needed for an element scrolled out of view, but it is the
 * more fragile of the two paths, so a plain viewport capture is tried as a fallback.
 */
async function capture(page: CdpPage, clip: Clip): Promise<string> {
  try {
    const beyond = await page.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: true,
      clip,
    });
    return beyond.data;
  } catch (error) {
    console.error('[Browser Context Bridge] captureBeyondViewport failed, retrying', error);
    const plain = await page.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      clip,
    });
    return plain.data;
  }
}
