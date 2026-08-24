# Browser Context Bridge — Installation

Pick an element in VS Code's integrated browser and send it straight to **Claude Code** or **Codex**, instead of the built-in Copilot chat.

Two steps, about a minute.

---

## 1. Install the extension

You got a file called `browser-context-bridge-<version>.vsix`.

**Easiest way — drag and drop:**

Open VS Code, go to the Extensions sidebar (`Cmd+Shift+X` / `Ctrl+Shift+X`), and drag the `.vsix` file into the extension list.

**Or via the Command Palette:**

`Cmd+Shift+P` / `Ctrl+Shift+P` → *Extensions: Install from VSIX…* → pick the file.

**Or in a terminal:**

```sh
code --install-extension browser-context-bridge-<version>.vsix
```

Then **quit VS Code completely** (`Cmd+Q` / close all windows) and start it again. Extensions are loaded at startup, so a window reload is not enough.

## 2. Switch on the good element picker

After the restart the extension shows a notification:

> *Browser Context Bridge works, but the DevTools element picker is switched off.*

Click **Set up**. VS Code opens `argv.json` and puts the line you need on your clipboard. Paste it inside the outermost `{ }`, so the file looks roughly like this:

```jsonc
{
	"enable-proposed-api": ["local.browser-context-bridge"]
}
```

Save, then **start VS Code once more**. That file is only read at startup.

<details>
<summary>Why is this needed?</summary>

The picker uses a VS Code API that is still marked "proposed". VS Code only hands those out to extensions the user explicitly names in `argv.json`. Without it the extension still works — you just get a plain outline instead of the DevTools highlight, and you have to type a URL instead of choosing an open tab.

</details>

## 3. Use it

1. Open a page: `Cmd+Shift+P` → **Browser: Open Integrated Browser**.
2. In the browser's title bar there are two buttons:
   - **cursor with a spark** → element goes to **Claude Code**
   - **cursor with a ring** → element goes to **Codex**
3. Hover an element — you get the DevTools highlight — and click it.

To abort: press `Escape`, or click the same button again.

Everything else — area capture, screenshots, full page context, settings — is on the **right-click menu of the browser tab**.

## Where things end up

Captures land in `.vscode/browser-context/` inside your project, as a `context.md` plus a screenshot. Leftovers from earlier VS Code sessions are cleaned up automatically at startup.

**Note:** that folder is not in `.gitignore` by default in most projects, and captures contain the page's HTML and screenshots. If you pick elements on pages with real data, add this to your global gitignore:

```
.vscode/browser-context/
```

## If something looks wrong

| Symptom | Fix |
|---|---|
| Only one button in the title bar, or none | VS Code was not fully restarted after installing |
| Plain blue outline instead of the DevTools box | Step 2 not done, or VS Code not restarted after it |
| It asks which chat every time | Set `browserContextBridge.target` back to `auto` |
| Where do I change the default chat? | Right-click the browser tab → **Send Captures To…** |

The full documentation is in `README.md`.
