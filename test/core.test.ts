import { describe, expect, it } from 'vitest';
import {
  areaContextMarkdown,
  elementContextMarkdown,
  getDataPart,
  getTextParts,
  imageFileName,
  pageContextMarkdown,
  parseBrowserPages,
  isSnapshotUnchanged,
  parseDeferredResultId,
  parsePageId,
  parsePageSummary,
  parsePlaywrightResult,
  capturesToSweep,
  captureTimestamp,
  resolveTarget,
  screenshotContextMarkdown,
  targetIndicatorLabel,
  truncate,
  type AreaCapture,
  type ElementCapture,
} from '../src/core.js';

describe('resolveTarget', () => {
  it('never asks by default, even with both agents installed', () => {
    expect(resolveTarget('auto', ['claude', 'codex'])).toBe('claude');
    expect(resolveTarget('auto', ['codex'])).toBe('codex');
    expect(resolveTarget('auto', ['claude'])).toBe('claude');
  });

  it('falls back to the clipboard when no agent is installed', () => {
    expect(resolveTarget('auto', [])).toBe('clipboard');
  });

  it('honours an explicit target over what is installed', () => {
    expect(resolveTarget('codex', ['claude', 'codex'])).toBe('codex');
    expect(resolveTarget('claude', ['codex'])).toBe('claude');
    expect(resolveTarget('clipboard', ['claude'])).toBe('clipboard');
  });

  it('only prompts when the user asked for prompting', () => {
    expect(resolveTarget('ask', ['claude', 'codex'])).toBe('ask');
  });
});

describe('targetIndicatorLabel', () => {
  it('names the target the status bar item will actually send to', () => {
    expect(targetIndicatorLabel('auto', ['claude', 'codex'])).toBe('Browser \u2192 Claude');
    expect(targetIndicatorLabel('auto', ['codex'])).toBe('Browser \u2192 Codex');
    expect(targetIndicatorLabel('auto', [])).toBe('Browser \u2192 Clipboard');
    expect(targetIndicatorLabel('codex', ['claude', 'codex'])).toBe('Browser \u2192 Codex');
  });

  it('says so when a prompt is configured', () => {
    expect(targetIndicatorLabel('ask', ['claude'])).toBe('Browser \u2192 ask');
  });
});

describe('capture retention', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse('2026-08-21T12:00:00.000Z');
  const names = [
    '2026-08-19T09-00-00-000Z-element', // two days old
    '2026-08-20T22-00-00-000Z-page',    // 14 hours old
    '2026-08-21T11-30-00-000Z-element', // 30 minutes old
    'my-notes',                         // not a capture at all
  ];

  it('reads the timestamp back out of a capture folder name', () => {
    expect(captureTimestamp('2026-08-21T11-30-00-000Z-element'))
      .toBe(Date.parse('2026-08-21T11:30:00.000Z'));
    expect(captureTimestamp('my-notes')).toBeUndefined();
    expect(captureTimestamp('2026-08-21T11-30-00-000Z-notes')).toBeUndefined();
  });

  it('sweeps earlier sessions but spares recent work and foreign folders', () => {
    expect(capturesToSweep(names, 'session', now, 12 * HOUR)).toEqual([
      '2026-08-19T09-00-00-000Z-element',
      '2026-08-20T22-00-00-000Z-page',
    ]);
  });

  it('keeps a capture made minutes ago, so a window reload cannot break a chat reference', () => {
    expect(capturesToSweep(names, 'session', now, 12 * HOUR))
      .not.toContain('2026-08-21T11-30-00-000Z-element');
  });

  it('sweeps nothing when retention is disabled', () => {
    expect(capturesToSweep(names, 'forever', now, 12 * HOUR)).toEqual([]);
  });
});

describe('parseBrowserPages', () => {
  it('parses shared browser page lines', () => {
    const pages = parseBrowserPages(`The following browser pages are currently shared:\n- [abc-123] Checkout (http://localhost:3000/cart) (active)\n- [def] Docs (https://example.com/a_(b)) (visible)`);
    expect(pages).toEqual([
      {
        id: 'abc-123',
        label: 'Checkout',
        url: 'http://localhost:3000/cart',
        visibility: 'active',
      },
      {
        id: 'def',
        label: 'Docs',
        url: 'https://example.com/a_(b)',
        visibility: 'visible',
      },
    ]);
  });

  it('ignores unshared-page status text', () => {
    expect(parseBrowserPages('No browser pages are currently shared with you.\n\n2 pages are open but not shared.')).toEqual([]);
  });
});

describe('parsePageId', () => {
  it('reads the id open_browser_page returns for a freshly opened page', () => {
    const text = 'Page ID: 3602dd9c-65f7-4b20-847d-7d7f8bf2651c\n\nSummary:\nPage Title: Example Domain';
    expect(parsePageId(text)).toBe('3602dd9c-65f7-4b20-847d-7d7f8bf2651c');
  });

  it('falls back to the already-shared page listing', () => {
    const text = 'At least one similar page is already open:\n  - [page-7] Checkout (http://localhost:3000/cart) (active)\n\nUse an existing page or pass `forceNew: true` to open a new one.';
    expect(parsePageId(text)).toBe('page-7');
  });

  it('prefers the active page when several are listed', () => {
    const text = '- [bg] Docs (https://example.com) (not visible)\n- [fg] App (http://localhost:3000) (active)';
    expect(parsePageId(text)).toBe('fg');
  });

  it('returns nothing when the tool reported a failure', () => {
    expect(parsePageId('No browser pages are currently open.')).toBeUndefined();
  });
});

describe('parsePageSummary', () => {
  const summary = [
    'Page Title: Example Domain',
    'URL: https://example.com/',
    'Snapshot: ',
    '- generic [ref=e2]:',
    '  - heading "Example Domain" [level=1] [ref=e3]',
  ].join('\n');

  it('splits the read_page answer into title, url and snapshot', () => {
    expect(parsePageSummary(summary)).toEqual({
      title: 'Example Domain',
      url: 'https://example.com/',
      snapshot: '- generic [ref=e2]:\n  - heading "Example Domain" [level=1] [ref=e3]',
    });
  });

  it('treats delta markers as no snapshot at all', () => {
    // VS Code sends snapshots as deltas; any earlier tool call consumes the full one.
    const unchanged = 'Page Title: Example Domain\nURL: https://example.com/\nSnapshot: <unchanged>';
    expect(parsePageSummary(unchanged).snapshot).toBe('');
    expect(isSnapshotUnchanged(unchanged)).toBe(true);
    expect(isSnapshotUnchanged(summary)).toBe(false);

    const unavailable = 'URL: https://example.com/\nSnapshot: <unavailable>';
    expect(parsePageSummary(unavailable).snapshot).toBe('');
    expect(isSnapshotUnchanged(unavailable)).toBe(false);
  });

  it('survives an answer that carries no snapshot line', () => {
    expect(parsePageSummary('No page summary available.')).toEqual({
      title: undefined,
      url: undefined,
      snapshot: '',
    });
  });
});

describe('tool result helpers', () => {
  it('extracts text and binary data parts', () => {
    const data = new Uint8Array([1, 2, 3]);
    const parts = [{ value: 'hello' }, { data, mimeType: 'image/png' }, { nope: true }];
    expect(getTextParts(parts)).toEqual(['hello']);
    expect(getDataPart(parts)).toEqual({ data, mimeType: 'image/png' });
  });

  it('parses deferred and final Playwright results', () => {
    expect(parseDeferredResultId('[deferredResultId=job-42] pending')).toBe('job-42');
    expect(parsePlaywrightResult<{ selector: string }>([{ value: 'Result: {"selector":"#buy"}' }]))
      .toEqual({ selector: '#buy' });
  });
});

describe('truncate', () => {
  it('marks truncated values', () => {
    expect(truncate('abcdef', 3)).toContain('abc');
    expect(truncate('abcdef', 3)).toContain('truncated after 3 characters');
    expect(truncate('abc', 3)).toBe('abc');
  });
});

describe('imageFileName', () => {
  it('names the file after the mime type the browser tool actually returned', () => {
    expect(imageFileName('image/jpeg')).toBe('screenshot.jpg');
    expect(imageFileName('image/png')).toBe('screenshot.png');
    expect(imageFileName('image/webp')).toBe('screenshot.webp');
  });
});

const element: ElementCapture = {
  url: 'http://localhost:3000/cart',
  title: 'Checkout',
  selector: 'main > button',
  displayName: 'button.buy',
  htmlPath: 'html > body > main > button.buy',
  outerHTML: '<button class="buy">Buy</button>',
  computedStyle: 'color: red;',
  innerText: 'Buy',
  dimensions: { top: 10, left: 20, width: 30, height: 40 },
};

const area: AreaCapture = {
  url: 'http://localhost:3000/cart',
  title: 'Checkout',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  scrollX: 0,
  scrollY: 1000,
  screenshotBase64: '',
  mimeType: 'image/jpeg',
};

describe('context markdown', () => {
  it('references the screenshot file that was actually written', () => {
    for (const markdown of [
      pageContextMarkdown({ id: 'a', label: 'Checkout' }, 'snapshot', 1000, 'screenshot.png'),
      screenshotContextMarkdown({ id: 'a', label: 'Checkout' }, 'screenshot.png'),
      elementContextMarkdown(element, 1000, 'screenshot.png'),
      areaContextMarkdown(area, 'screenshot.png'),
    ]) {
      expect(markdown).toContain('- Screenshot: `screenshot.png`');
      expect(markdown).not.toContain('screenshot.jpg');
    }
  });

  it('embeds the screenshot so it renders and an agent can find it', () => {
    expect(elementContextMarkdown(element, 1000, 'screenshot.jpg'))
      .toContain('![Captured element](screenshot.jpg)');
    expect(areaContextMarkdown(area, 'screenshot.jpg'))
      .toContain('![Captured area](screenshot.jpg)');
    expect(pageContextMarkdown({ id: 'a', label: 'Checkout' }, 'snapshot', 1000, 'screenshot.jpg'))
      .toContain('![Captured page](screenshot.jpg)');
    expect(screenshotContextMarkdown({ id: 'a', label: 'Checkout' }, 'screenshot.jpg'))
      .toContain('![Captured viewport](screenshot.jpg)');
  });

  it('omits the screenshot line when no image was captured', () => {
    expect(pageContextMarkdown({ id: 'a', label: 'Checkout' }, 'snapshot', 1000)).not.toContain('- Screenshot:');
    expect(screenshotContextMarkdown({ id: 'a', label: 'Checkout' })).not.toContain('- Screenshot:');
    expect(screenshotContextMarkdown({ id: 'a', label: 'Checkout' })).not.toContain('## Screenshot');
  });

  it('reports an area selection in document coordinates', () => {
    // y is viewport-relative because Playwright clips against the viewport; the
    // markdown adds the scroll offset back so the position means something on the page.
    expect(areaContextMarkdown(area)).toContain('100 × 50 px at (10, 1020) in the document');
  });

  it('fences content that itself contains backtick runs', () => {
    const markdown = elementContextMarkdown(
      { ...element, outerHTML: '<pre>```js\ncode\n```</pre>' },
      1000,
    );
    expect(markdown).toContain('````html');
  });

  it('fences very large captures without overflowing the stack', () => {
    // maxTextLength allows up to 1,000,000 characters; counting backtick runs by
    // spreading them into Math.max blows the stack well before that ceiling.
    const huge = '`x'.repeat(250000);
    expect(() => elementContextMarkdown({ ...element, outerHTML: huge }, 1000000)).not.toThrow();
  });
});
