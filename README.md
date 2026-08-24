# Browser Context Bridge

Capture context from VS Code's integrated browser — a hovered element, a screenshot, a page snapshot — and hand it straight to **Claude Code** or **Codex** instead of the built-in Copilot chat.

The element picker is the same interaction as VS Code's built-in **Add Element to Chat**: hover the page, the browser draws the DevTools highlight, click to capture. The only difference is where the result lands.

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Enable the native element picker](#enable-the-native-element-picker)
- [Use](#use)
- [Commands](#commands)
- [Settings](#settings)
- [What a capture contains](#what-a-capture-contains)
- [How the agent hand-off works](#how-the-agent-hand-off-works)
- [How the page is resolved](#how-the-page-is-resolved)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Requirements

- VS Code with the integrated browser. The browser tool surface is verified against **VS Code 1.129**; the manifest allows 1.109 and newer, but older builds may contribute a different set of tools. When a tool is missing, the error names it.
- Setting `workbench.browser.enableChatTools` enabled.
- VS Code publishes its integrated-browser tools only while a default chat participant (normally GitHub Copilot Chat) is active. The captured artifacts can still be handed to Codex or Claude.
- For the hand-off: the **Claude Code** (`anthropic.claude-code`) and/or **Codex** (`openai.chatgpt`) extension installed.

## Install

The extension is distributed as a `.vsix` rather than through the Marketplace, because it declares the proposed `browser` API. See [Publishing](#publishing) for what that does and does not rule out. Install it from the package:

```sh
npm install
npm run vsix        # writes browser-context-bridge-<version>.vsix
code --install-extension browser-context-bridge-<version>.vsix --force
```

If `code` is not on your PATH, the CLI ships inside the app bundle:

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension browser-context-bridge-<version>.vsix --force
```

**Restart VS Code fully** afterwards (`Cmd+Q` / `Alt+F4`). VS Code loads extensions at startup; installing while it runs does not swap the running copy, so you would keep using the previous version.

## Enable the native element picker

The DevTools-style picker needs VS Code's proposed `browser` API, which is opt-in. Without it everything still works — the element command falls back to a picker injected into the page, which is noticeably worse (see [the comparison below](#with-and-without-the-proposed-api)).

**Recommended — runtime arguments, no terminal needed.** In VS Code: Command Palette → *Preferences: Configure Runtime Arguments*. That opens `~/.vscode/argv.json`. Add:

```jsonc
{
	"enable-proposed-api": [
		"local.browser-context-bridge"
	]
}
```

Then **quit and restart** VS Code. The file is read by the main process at startup, so reloading the window is not enough.

> The path matters: `argv.json` lives in `~/.vscode`, next to the extensions folder — **not** in the `Application Support` user-data directory.

Alternatives: start VS Code with `--enable-proposed-api local.browser-context-bridge`, or run the extension from source with `--extensionDevelopmentPath`.

**Do not leave the array empty.** Keep it a named list. An empty list is a different, much broader mode.

### With and without the proposed API

`run_playwright_code` declares a confirmation prompt, but VS Code only renders it inside a chat turn — invoked from an extension it runs without asking. So the fallback is not gated by a dialog; it differs in these ways:

| | Native picker (proposed API on) | Fallback picker |
|---|---|---|
| Hover highlight | Browser-drawn DevTools box: content, padding, border, margin, plus tag and size tooltip | A plain outline written into the page |
| Page is modified | No | Yes — an inline `outline` style during hover |
| Captured HTML/CSS | Exactly what the page renders | Also clean — the outline is removed before the element is read |
| Page selection | Tabs are listed; the active one is used | Asks for a URL the first time, and cannot see a tab you opened yourself |

To check which one you have: run the element command and hover. A multi-coloured box with a tooltip is the native picker.

## Use

1. Open a page: Command Palette → **Browser: Open Integrated Browser**. For a local file, right-click it in the Explorer → *Open in Integrated Browser*.
2. In the browser's title bar there are **two buttons**:

   | Button | Click it to |
   |---|---|
   | cursor with a **spark** | pick an element and send it to **Claude Code** |
   | cursor with a **ring** | pick an element and send it to **Codex** |

   **Right-click the browser tab** for everything else: the other capture commands, the default target, the page chooser, and *Clear Captured Context*.

3. Hover an element — the highlight follows the mouse — and click it.

   Three ways to abort: press **`Escape`**, run the same command **again** (clicking the button a second time stops the picker), or hit **Cancel** on the progress notification. Mouse buttons are deliberately not used for cancelling — the overlay sees mouse input before the page does, so a right-click inside the page can arrive as a pick and as a cancel at the same time.

4. The capture is written to disk and handed to your agent. By default nothing is asked.

Captures land in `.vscode/browser-context/<timestamp>-<kind>/` as `context.md` plus a screenshot.

## Commands

All are prefixed **Browser Context Bridge:** in the Command Palette.

| Command | What it does |
|---|---|
| **Select and Capture Element** | Hover-and-click picker. The headline feature. |
| **Select and Capture Area** | Drag a rectangle; captures that region of the viewport. |
| **Capture Viewport Screenshot** | Screenshot of the visible page, no picking. |
| **Capture Page Context** | Page title, URL, accessibility snapshot and a screenshot. |
| **Choose Where Captures Go…** | Pick the target agent; writes `browserContextBridge.target`. Also reachable from the status bar. |
| **Clear Captured Context** | Delete every capture folder. Files you put in that directory yourself are left alone. |
| **Choose Browser Page…** | Point the bridge at a different URL. |
| **Open Latest Context** | Open the most recent `context.md` in an editor. |
| **Send Latest Context to…** | Re-send the most recent capture. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `browserContextBridge.target` | `auto` | Where captures go. `auto` sends to the first installed agent — Claude Code, else Codex, else the clipboard — **without ever asking**. `ask` restores a prompt after every capture. `claude`, `codex` and `clipboard` pin one target. |
| `browserContextBridge.pageUrl` | `""` | URL captured without asking. Empty means you are prompted the first time, then the resolved page is remembered. |
| `browserContextBridge.artifactDirectory` | `.vscode/browser-context` | Workspace-relative directory for generated files. Must stay inside the workspace. |
| `browserContextBridge.retention` | `session` | `session` removes captures left over from earlier runs of VS Code when it starts. `forever` never removes anything automatically. |
| `browserContextBridge.maxTextLength` | `120000` | Character cap for page, HTML and CSS content (10,000–1,000,000). |

The status bar shows where captures currently go — for example `Browser → claude`. Click it to switch.

If captures keep prompting you for a target, `browserContextBridge.target` is set to `ask` — set it back to `auto`.

## What a capture contains

`context.md`, plus `screenshot.jpg` next to it. Depending on the command:

- page URL and title;
- an accessible page snapshot;
- viewport, area or element screenshot;
- for an element: outer HTML, full computed CSS, visible text, CSS selector, HTML path and pixel dimensions.

Every capture starts with a line telling the agent to treat page content as untrusted data rather than instructions.

## How the agent hand-off works

- **Codex** — `context.md` and the screenshot are both attached to the current Codex thread. Codex accepts a file URI directly, so no editor opens.
- **Claude Code** — `context.md` is inserted as an `@` file reference into the Claude chat that is currently open. Claude's `insertAtMention` command takes no argument and reads the active editor, so the file is made active for a moment and its tab is then closed again **by URI**. You keep the reference in the chat without a stray editor tab. The document embeds the screenshot as a relative Markdown image next to `context.md`, so it renders in a preview and Claude can read the image from there.
- **Clipboard** — absolute paths are copied for any other agent.

### Why the target does not follow the selected chat

Both Claude Code and Codex host their chat as a **sidebar webview view**, and VS Code exposes no API that lets a third extension ask which sidebar view is visible or focused — `window.tabGroups` only covers editor tabs. So the target cannot follow whichever chat you have open.

`auto` therefore uses a fixed, documented order, and the status bar makes the current target visible and switchable in one click. Within Claude, the mention still lands in whichever Claude chat surface is visible — the Claude extension handles that itself.

## How the page is resolved

VS Code publishes the list of shared browser pages as *chat workspace context*, not as a tool, so an extension cannot enumerate pages through the public API. `open_browser_page` is the only public tool that returns a page ID, so the bridge asks for a URL once and caches the ID. A page ID survives navigation, so later captures follow wherever you browse in that tab.

With the proposed API enabled, the element picker skips all of this and talks to the tab directly.

Two consequences of the public path:

- A page you opened and shared by hand is invisible to the bridge. Giving it the URL opens a page it can address, which may be a second tab onto the same URL.
- Page snapshots arrive as deltas. Once any tool call has consumed a full snapshot, VS Code answers `<unchanged>`; the bridge remembers the last full snapshot per page so `context.md` is never left with an empty snapshot section.

## Housekeeping

Captures accumulate while you work: every pick writes a timestamped folder with a `context.md` and a screenshot. With the default `retention: "session"` those folders are swept **when VS Code next starts**, not when it closes — a crash or a force quit would skip a shutdown hook, whereas a startup sweep always runs.

Captures younger than 12 hours are never swept. Reloading the window restarts the extension host, and without that margin a reload would delete captures made minutes earlier and break `@` references already sitting in an open chat.

Set `retention` to `forever` to keep everything, and use **Clear Captured Context** to wipe on demand. Both paths only ever touch folders named like a capture — anything else you keep in that directory is left alone.

## Security and privacy

Worth knowing before you enable the proposed API:

- **The proposed API grant is per extension ID** and gives this extension a raw CDP session to integrated-browser tabs. VS Code does not filter CDP methods, so the grant is effectively full debugger access to those tabs: read and modify the DOM, run scripts, read cookies and storage, intercept network traffic. It does **not** touch your normal Chrome or Safari. Revoke it by deleting the entry from `argv.json` and restarting.
- **Captures land in your workspace.** The default is `.vscode/browser-context/`, which most projects do not gitignore. Captures contain full outer HTML, computed CSS, visible text and screenshots — on an authenticated page that can include personal data or tokens sitting in DOM attributes. Add `.vscode/browser-context/` to your global gitignore.
- **Captures are sent to a third-party model provider** — that is the point of the tool, but it means page content leaves your machine.
- **Prompt injection.** Page content enters an agent's context. The untrusted-data preamble is a mitigation, not a guarantee; a hostile page can try to steer the agent.

## Troubleshooting

**It asks which chat to use after every capture.** `browserContextBridge.target` is `ask`. Set it to `auto`, or run *Choose Where Captures Go…*.

**Changes to the extension have no effect.** VS Code loads extensions at startup. Quit fully and reopen — reloading the window is not enough.

**The hover highlight looks like a thin outline and VS Code asks to confirm each pick.** The proposed API is not enabled — see [Enable the native element picker](#enable-the-native-element-picker). Verify with Command Palette → *Preferences: Configure Runtime Arguments*, and remember the full restart.

**"VS Code browser tools are unavailable (…)".** Enable `workbench.browser.enableChatTools`, make sure a default chat participant such as GitHub Copilot Chat is active, then reload. The message names the missing tool.

**The element screenshot shows the wrong part of the page.** That was a real bug (viewport vs. document coordinates) fixed in 0.4.0. Check your installed version in the Extensions view.

**An editor tab with `context.md` stays open.** Fixed in 0.5.0 for the Claude path.

**I cannot find where to choose the chat.** You usually do not have to: the two title-bar buttons send to Claude and to Codex directly. For the default used by the other capture commands, right-click the browser tab and pick **Send Captures To…** — it is also in the status bar and the Command Palette.

**I cannot find the status bar item.** It is right-aligned and labelled for example `Browser → Claude`. If it is missing, right-click the status bar: the item is listed as *Browser Context Bridge* and can be re-enabled there. It appears at startup, so a full restart is needed after installing.

**The capture has a `context.md` but no screenshot.** The screenshot step logs why in the Extension Host output channel. It is skipped rather than failing the whole capture.

**Old captures disappeared.** With `retention: "session"` captures from earlier runs of VS Code are swept at startup. Set `browserContextBridge.retention` to `forever` to keep them.

## Publishing

`vsce package` does not care about proposed APIs — that is why building the `.vsix` works. `vsce publish` is the one that refuses:

```
Extensions using unallowed proposed API (enabledApiProposals: [browser]) can't be
published to the Marketplace. Use --allow-proposed-apis <APIS...> or
--allow-all-proposed-apis to bypass.
```

So it is a policy gate with a documented bypass, not a hard wall. The reason to respect it anyway is what happens *after* publishing: VS Code grants proposed APIs only to extensions on its own allowlist, and strips them from everyone else. Verified here — with no `argv.json` entry the installed extension reports `enabledApiProposals: []`, with the entry it reports `["browser"]`. A Marketplace user would therefore have to opt in by hand before the native picker did anything, and a proposed API can change or disappear in any VS Code release.

Three options, depending on what you want:

1. **Keep distributing the `.vsix`** (what this does today). The native picker works for anyone who adds the `argv.json` entry.
2. **Publish a build without the proposal.** Strip `enabledApiProposals` from `package.json` before packaging. Everything still works — the element picker falls back to the injected variant — and no opt-in is needed. You lose the DevTools-quality highlight for Marketplace users.
3. **Publish with the bypass flag** (`vsce publish --allow-proposed-apis browser`). Possible, but the native picker stays inert for users who do not opt in, so it mostly buys a Marketplace listing.

## Development

```sh
npm run check            # typecheck
npm run test             # unit tests
npm run test:integration # drives a real VS Code instance and the real browser tools
npm run vsix             # package
```

The integration test drives the native element picker end to end: it opens a tab, arms the picker, plays a synthetic mouse click through a second CDP session, and then samples the captured **pixels** — a crop offset by the scroll position is caught, not merely a wrong file size. It also asserts that the Claude hand-off leaves no editor tab behind, and pins the contracts this extension depends on: that `open_browser_page` returns a page ID, that `read_page` and `screenshot_page` answer for it, and that screenshot clipping is viewport-relative for Playwright but document-relative for CDP.

Two limits are worth knowing:

- A quick pick that nobody answers resolves by itself in a test host, so the integration test cannot detect a stray prompt. The no-prompt behaviour is covered by the `resolveTarget` unit tests instead.
- **The element pick and the Escape cancellation only run with the VS Code window in the foreground.** Chromium parks the renderer of an occluded window, so `document.visibilityState` becomes `hidden`, the browser view stops painting and inspect mode never reports a click. The test detects this and prints a `SKIPPED` warning instead of failing at random — if you want those paths covered, run the suite with the window focused and watch for the warning.
