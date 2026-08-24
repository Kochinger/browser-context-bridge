import * as vscode from 'vscode';
import {
  type AreaCapture,
  type BrowserPage,
  type ElementCapture,
  getDataPart,
  getTextParts,
  isSnapshotUnchanged,
  parseDeferredResultId,
  parsePageId,
  parsePageSummary,
  parsePlaywrightResult,
  type PageSummary,
} from './core.js';

const TOOL_OPEN_PAGE = 'open_browser_page';
const TOOL_READ_PAGE = 'read_page';
const TOOL_SCREENSHOT = 'screenshot_page';
const TOOL_RUN_PLAYWRIGHT = 'run_playwright_code';

const PAGE_ID_KEY = 'browserPageId';
const PAGE_URL_KEY = 'browserPageUrl';

/** A human may take a while to pick; poll the deferred result until this budget runs out. */
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

function isAbsoluteUrl(value: string): boolean {
  return /^(https?|file):\/\/./.test(value);
}

const elementPickerCode = String.raw`
const picked = await page.evaluate(() => new Promise((resolve) => {
  const marker = 'browser-context-bridge-picker';
  document.getElementById(marker)?.remove();

  const style = document.createElement('style');
  style.id = marker;
  style.textContent = '* { cursor: crosshair !important; }';
  document.documentElement.appendChild(style);

  let highlighted;
  let previousOutline = '';
  let previousOutlineOffset = '';

  const restore = () => {
    if (highlighted) {
      highlighted.style.outline = previousOutline;
      highlighted.style.outlineOffset = previousOutlineOffset;
      highlighted = undefined;
    }
  };

  const cleanup = () => {
    restore();
    style.remove();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const onMouseOver = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target === highlighted) return;
    restore();
    highlighted = target;
    previousOutline = target.style.outline;
    previousOutlineOffset = target.style.outlineOffset;
    target.style.outline = '2px solid #0e70c0';
    target.style.outlineOffset = '-2px';
  };

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

  const onClick = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // Drop the hover outline before reading the element, otherwise the picker's own
    // inline styles end up in the captured outerHTML and computed CSS.
    restore();

    const rect = target.getBoundingClientRect();
    const computed = getComputedStyle(target);
    const computedStyle = Array.from(computed)
      .map((property) => property + ': ' + computed.getPropertyValue(property) + ';')
      .join('\n');
    const result = {
      url: location.href,
      title: document.title,
      selector: cssPath(target),
      displayName: target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + Array.from(target.classList).map((name) => '.' + name).join(''),
      htmlPath: htmlPath(target),
      outerHTML: target.outerHTML,
      computedStyle,
      innerText: target.innerText || target.textContent || '',
      dimensions: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    };
    cleanup();
    resolve(result);
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cleanup();
    resolve({ cancelled: true });
  };

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}));
return picked;
`;

const areaPickerCode = String.raw`
const area = await page.evaluate(() => new Promise((resolve) => {
  const marker = 'browser-context-bridge-area-picker';
  document.getElementById(marker)?.remove();

  const overlay = document.createElement('div');
  overlay.id = marker;
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px dashed #0e70c0;background:rgba(14,112,192,.15);display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';

  let startX = 0;
  let startY = 0;
  let dragging = false;

  const cleanup = () => {
    overlay.remove();
    document.documentElement.style.cursor = previousCursor;
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const update = (x, y) => {
    const left = Math.min(startX, x);
    const top = Math.min(startY, y);
    overlay.style.left = left + 'px';
    overlay.style.top = top + 'px';
    overlay.style.width = Math.abs(x - startX) + 'px';
    overlay.style.height = Math.abs(y - startY) + 'px';
  };

  const onMouseDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    overlay.style.display = 'block';
    update(startX, startY);
  };

  const onMouseMove = (event) => {
    if (!dragging) return;
    event.preventDefault();
    update(event.clientX, event.clientY);
  };

  const onMouseUp = (event) => {
    if (!dragging || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dragging = false;

    // Playwright's screenshot clip is viewport-relative, so the selection is reported
    // in viewport coordinates and clamped to the viewport. The scroll offset travels
    // alongside it so the capture can still be described in document coordinates.
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const left = Math.max(0, Math.min(startX, event.clientX));
    const top = Math.max(0, Math.min(startY, event.clientY));
    const right = Math.min(viewportWidth, Math.max(startX, event.clientX));
    const bottom = Math.min(viewportHeight, Math.max(startY, event.clientY));
    const width = right - left;
    const height = bottom - top;
    if (width < 3 || height < 3) {
      overlay.style.display = 'none';
      dragging = false;
      return;
    }
    const result = {
      x: left,
      y: top,
      width,
      height,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      url: location.href,
      title: document.title,
    };
    cleanup();
    resolve(result);
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cleanup();
    resolve({ cancelled: true });
  };

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);
}));
if (area.cancelled) return area;
await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const screenshot = await page.screenshot({
  type: 'jpeg',
  quality: 85,
  clip: { x: area.x, y: area.y, width: area.width, height: area.height },
});
return { ...area, screenshotBase64: screenshot.toString('base64'), mimeType: 'image/jpeg' };
`;

export type ResolvedPage = {
  page: BrowserPage;
  /** The snapshot read while resolving the page, so `read_page` is only called once. */
  summary: PageSummary;
};

export class IntegratedBrowserTools {
  /**
   * Last full snapshot per page. VS Code sends snapshots as deltas, so once any tool
   * call has consumed one, later calls answer `<unchanged>` — which still means the
   * remembered snapshot describes the page.
   */
  private readonly snapshots = new Map<string, string>();

  constructor(private readonly state: vscode.Memento) {}

  private ensureTools(names: string[]): void {
    const available = new Set(vscode.lm.tools.map((tool) => tool.name));
    const missing = names.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(
        `VS Code browser tools are unavailable (${missing.join(', ')}). Enable the workbench.browser.enableChatTools setting, make sure a default chat participant such as GitHub Copilot Chat is active, then reload VS Code.`,
      );
    }
  }

  private invoke(name: string, input: object, token?: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult> {
    return vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input }, token);
  }

  /**
   * VS Code has no tool that lists shared browser pages — the list is injected into chat
   * as workspace context and is not reachable from an extension. `open_browser_page` is
   * the only tool that hands out a page ID, so the ID is resolved once and then cached:
   * a page ID survives navigation, so later captures follow wherever the user browses.
   */
  async resolvePage(
    token?: vscode.CancellationToken,
    options: { alwaysAsk?: boolean } = {},
  ): Promise<ResolvedPage | undefined> {
    this.ensureTools([TOOL_OPEN_PAGE, TOOL_READ_PAGE]);

    const cachedId = options.alwaysAsk ? undefined : this.state.get<string>(PAGE_ID_KEY);
    if (cachedId) {
      const summary = await this.tryReadPage(cachedId, token);
      if (summary?.url) {
        await this.state.update(PAGE_URL_KEY, summary.url);
        return {
          page: { id: cachedId, label: summary.title || summary.url, url: summary.url, visibility: 'active' },
          summary,
        };
      }
    }

    const url = await this.askForUrl(options.alwaysAsk === true);
    if (!url) {
      return undefined;
    }

    const result = await this.invoke(TOOL_OPEN_PAGE, { url }, token);
    const text = getTextParts(result.content).join('\n');
    const pageId = parsePageId(text);
    if (!pageId) {
      throw new Error(`The integrated browser did not return a page ID: ${text.trim() || 'no response'}`);
    }
    // Opening already produced a snapshot; seed the cache so a follow-up
    // `<unchanged>` still has something to fall back on.
    const opened = parsePageSummary(text);
    if (opened.snapshot) {
      this.snapshots.set(pageId, opened.snapshot);
    }

    await this.state.update(PAGE_ID_KEY, pageId);
    await this.state.update(PAGE_URL_KEY, url);

    const summary = (await this.tryReadPage(pageId, token)) ?? opened;
    return {
      page: {
        id: pageId,
        label: summary.title || url,
        url: summary.url ?? url,
        visibility: 'active',
      },
      summary,
    };
  }

  /**
   * A configured `pageUrl` turns capture into one click; otherwise ask once and remember.
   * `alwaysAsk` is how "Choose Browser Page…" stays useful even with `pageUrl` set.
   */
  private async askForUrl(alwaysAsk: boolean): Promise<string | undefined> {
    const configured = vscode.workspace
      .getConfiguration('browserContextBridge')
      .get<string>('pageUrl', '')
      .trim();
    if (!alwaysAsk && isAbsoluteUrl(configured)) {
      return configured;
    }

    const entered = await vscode.window.showInputBox({
      title: 'Browser Context Bridge',
      prompt: 'URL to capture. VS Code opens it in the integrated browser and shares that page with this extension.',
      value: configured || this.state.get<string>(PAGE_URL_KEY) || 'http://localhost:3000',
      ignoreFocusOut: true,
      validateInput: (value) =>
        isAbsoluteUrl(value.trim())
          ? undefined
          : 'Enter an absolute URL, for example http://localhost:3000.',
    });
    return entered?.trim() || undefined;
  }

  /** Doubles as a liveness check: reading a closed or unknown page fails. */
  private async tryReadPage(
    pageId: string,
    token?: vscode.CancellationToken,
  ): Promise<PageSummary | undefined> {
    try {
      return await this.readPage(pageId, token);
    } catch {
      return undefined;
    }
  }

  /** Drops the cached page so the next capture asks for a URL again. */
  async forgetPage(): Promise<void> {
    await this.state.update(PAGE_ID_KEY, undefined);
  }

  async readPage(pageId: string, token?: vscode.CancellationToken): Promise<PageSummary> {
    this.ensureTools([TOOL_READ_PAGE]);
    const result = await this.invoke(TOOL_READ_PAGE, { pageId }, token);
    const text = getTextParts(result.content).join('\n\n');
    const summary = parsePageSummary(text);

    if (summary.snapshot) {
      this.snapshots.set(pageId, summary.snapshot);
      return summary;
    }
    if (isSnapshotUnchanged(text)) {
      const remembered = this.snapshots.get(pageId);
      if (remembered) {
        return { ...summary, snapshot: remembered };
      }
    }
    return summary;
  }

  async screenshot(
    pageId: string,
    options: { selector?: string; element?: string } = {},
    token?: vscode.CancellationToken,
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    this.ensureTools([TOOL_SCREENSHOT]);
    const result = await this.invoke(TOOL_SCREENSHOT, { pageId, ...options }, token);
    const image = getDataPart(result.content);
    if (!image) {
      throw new Error(`The browser screenshot tool returned no image: ${getTextParts(result.content).join(' ')}`);
    }
    return image;
  }

  async pickElement(pageId: string, token?: vscode.CancellationToken): Promise<ElementCapture | undefined> {
    const parsed = await this.runDeferredPlaywright<ElementCapture>(
      pageId,
      elementPickerCode,
      '$(inspect) Click an element in the browser; press Esc to cancel.',
      token,
    );
    return parsed?.cancelled ? undefined : parsed;
  }

  async pickArea(pageId: string, token?: vscode.CancellationToken): Promise<AreaCapture | undefined> {
    const parsed = await this.runDeferredPlaywright<AreaCapture>(
      pageId,
      areaPickerCode,
      '$(screen-full) Drag an area in the browser; press Esc to cancel.',
      token,
    );
    return parsed?.cancelled ? undefined : parsed;
  }

  private async runDeferredPlaywright<T>(
    pageId: string,
    code: string,
    statusText: string,
    token?: vscode.CancellationToken,
  ): Promise<T | undefined> {
    this.ensureTools([TOOL_RUN_PLAYWRIGHT]);
    const status = vscode.window.setStatusBarMessage(statusText);
    const deadline = Date.now() + PICKER_TIMEOUT_MS;

    try {
      let result = await this.invoke(
        TOOL_RUN_PLAYWRIGHT,
        { pageId, code, timeoutMs: 750 },
        token,
      );

      for (;;) {
        const parsed = parsePlaywrightResult<T>(result.content);
        if (parsed !== undefined) {
          return parsed;
        }

        const text = getTextParts(result.content).join('\n');
        const deferredResultId = parseDeferredResultId(text);
        if (!deferredResultId) {
          throw new Error(`The browser picker failed: ${text.trim() || 'no response'}`);
        }
        if (token?.isCancellationRequested) {
          return undefined;
        }
        if (Date.now() >= deadline) {
          throw new Error('The browser picker timed out. Run the command again and pick within five minutes.');
        }

        result = await this.invoke(
          TOOL_RUN_PLAYWRIGHT,
          { pageId, deferredResultId, timeoutMs: 5000 },
          token,
        );
      }
    } finally {
      status.dispose();
    }
  }
}
