import * as path from 'node:path';
import * as vscode from 'vscode';
import { capturesToSweep, imageFileName, type Retention } from './core.js';

export type CaptureArtifacts = {
  directory: vscode.Uri;
  context: vscode.Uri;
  image?: vscode.Uri;
};

function safeDirectorySetting(): string[] {
  const configured = vscode.workspace
    .getConfiguration('browserContextBridge')
    .get<string>('artifactDirectory', '.vscode/browser-context')
    .trim();

  if (!configured || path.isAbsolute(configured)) {
    throw new Error('browserContextBridge.artifactDirectory must be a workspace-relative path.');
  }

  const segments = configured.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('browserContextBridge.artifactDirectory must stay inside the workspace.');
  }
  return segments;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Only ever matches directories this extension created, so sweeping cannot stray. */
const CAPTURE_DIRECTORY = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(page|screenshot|element)$/;

/**
 * How long a capture is protected from the startup sweep. Reloading the window restarts
 * the extension host, so without this margin a reload would delete captures made minutes
 * earlier and break `@` references already sitting in a chat.
 */
const SESSION_GRACE_MS = 12 * 60 * 60 * 1000;

function retention(): Retention {
  return vscode.workspace
    .getConfiguration('browserContextBridge')
    .get<Retention>('retention', 'session') === 'forever' ? 'forever' : 'session';
}

async function captureDirectories(base: vscode.Uri): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(base);
  } catch {
    return [];
  }
  return entries
    .filter(([name, type]) => type === vscode.FileType.Directory && CAPTURE_DIRECTORY.test(name))
    .map(([name]) => name)
    // Timestamps are ISO, so lexicographic order is chronological.
    .sort();
}

/**
 * Removes captures left over from earlier runs of VS Code. Called once on activation:
 * during a session captures simply accumulate, which keeps every reference a chat may
 * already hold alive for as long as that chat is in front of you.
 */
export async function sweepPreviousSessions(
  extensionContext: vscode.ExtensionContext,
): Promise<number> {
  const base = captureBase(extensionContext);
  const stale = capturesToSweep(
    await captureDirectories(base),
    retention(),
    Date.now(),
    SESSION_GRACE_MS,
  );
  let removed = 0;
  for (const name of stale) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(base, name), {
        recursive: true,
        useTrash: false,
      });
      removed += 1;
    } catch {
      // Locked or already gone; it is swept on a later start.
    }
  }
  return removed;
}

/** Deletes every capture this extension wrote, and nothing else. */
export async function clearCaptures(extensionContext: vscode.ExtensionContext): Promise<number> {
  const base = captureBase(extensionContext);
  const directories = await captureDirectories(base);
  let removed = 0;
  for (const name of directories) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(base, name), {
        recursive: true,
        useTrash: false,
      });
      removed += 1;
    } catch {
      // Skip what cannot be removed rather than aborting the sweep.
    }
  }
  await extensionContext.workspaceState.update('latestCapture', undefined);
  return removed;
}

function captureBase(extensionContext: vscode.ExtensionContext): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, ...safeDirectorySetting())
    : vscode.Uri.joinPath(extensionContext.globalStorageUri, 'browser-context');
}

export class ArtifactStore {
  constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  /**
   * `buildMarkdown` receives the screenshot's file name so `context.md` can only ever
   * reference the file that is actually written next to it.
   */
  async write(
    kind: 'page' | 'screenshot' | 'element',
    buildMarkdown: (imageName?: string) => string,
    image?: { data: Uint8Array; mimeType: string },
  ): Promise<CaptureArtifacts> {
    const base = captureBase(this.extensionContext);
    const directory = vscode.Uri.joinPath(base, `${timestamp()}-${kind}`);
    const context = vscode.Uri.joinPath(directory, 'context.md');
    const imageName = image ? imageFileName(image.mimeType) : undefined;

    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(context, new TextEncoder().encode(buildMarkdown(imageName)));

    let imageUri: vscode.Uri | undefined;
    if (image && imageName) {
      imageUri = vscode.Uri.joinPath(directory, imageName);
      await vscode.workspace.fs.writeFile(imageUri, image.data);
    }

    const artifacts = { directory, context, image: imageUri };
    await this.extensionContext.workspaceState.update('latestCapture', {
      directory: directory.toString(),
      context: context.toString(),
      image: imageUri?.toString(),
    });
    return artifacts;
  }

  latest(): CaptureArtifacts | undefined {
    const stored = this.extensionContext.workspaceState.get<{
      directory: string;
      context: string;
      image?: string;
    }>('latestCapture');
    if (!stored) {
      return undefined;
    }
    return {
      directory: vscode.Uri.parse(stored.directory),
      context: vscode.Uri.parse(stored.context),
      image: stored.image ? vscode.Uri.parse(stored.image) : undefined,
    };
  }
}
