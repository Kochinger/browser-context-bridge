import * as vscode from 'vscode';
import type { CaptureArtifacts } from './artifacts.js';
import { resolveTarget, type Target, type TargetSetting } from './core.js';

export type { Target };

type TargetChoice = vscode.QuickPickItem & { target: Target };

const AGENTS: Array<{ target: Target; extensionId: string; label: string; description: string }> = [
  {
    target: 'claude',
    extensionId: 'anthropic.claude-code',
    label: 'Claude Code',
    description: 'Insert the capture into the open Claude chat',
  },
  {
    target: 'codex',
    extensionId: 'openai.chatgpt',
    label: 'Codex',
    description: 'Attach the capture to the current Codex thread',
  },
];

export function installedAgentTargets(): Target[] {
  return AGENTS.filter((agent) => vscode.extensions.getExtension(agent.extensionId) !== undefined)
    .map((agent) => agent.target);
}

function targetSetting(): TargetSetting {
  return vscode.workspace
    .getConfiguration('browserContextBridge')
    .get<TargetSetting>('target', 'auto');
}

/**
 * Never prompts unless `browserContextBridge.target` is explicitly `ask`. The default
 * `auto` picks the first installed agent, so capturing stays a single click.
 */
export async function chooseTarget(): Promise<Target | undefined> {
  const resolved = resolveTarget(targetSetting(), installedAgentTargets());
  return resolved === 'ask' ? askForTarget() : resolved;
}

async function askForTarget(): Promise<Target | undefined> {
  const installed = new Set(installedAgentTargets());
  const choices: TargetChoice[] = [
    ...AGENTS.filter((agent) => installed.has(agent.target)).map((agent) => ({
      label: agent.label,
      description: agent.description,
      target: agent.target,
    })),
    {
      label: 'Clipboard',
      description: 'Copy file references for any other agent',
      target: 'clipboard',
    },
  ];
  return (await vscode.window.showQuickPick(choices, { title: 'Send browser context to…' }))?.target;
}

/**
 * Backs "Choose Where Captures Go". It writes the visible setting rather than hidden
 * state, so the choice is inspectable and editable in the Settings UI afterwards.
 */
export async function reselectTarget(): Promise<Target | undefined> {
  const picked = await askForTarget();
  if (!picked) {
    return undefined;
  }
  await vscode.workspace
    .getConfiguration('browserContextBridge')
    .update('target', picked, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    `Browser captures now go to ${picked}. Change it any time with browserContextBridge.target.`,
  );
  return picked;
}

async function requireExtension(id: string, name: string): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(id);
  if (!extension) {
    throw new Error(`${name} is not installed.`);
  }
  await extension.activate();
  return extension;
}

async function sendToCodex(artifacts: CaptureArtifacts): Promise<void> {
  await requireExtension('openai.chatgpt', 'The Codex extension');
  // Codex takes a URI and attaches it to the thread without opening an editor.
  await vscode.commands.executeCommand('chatgpt.addFileToThread', artifacts.context);
  if (artifacts.image) {
    await vscode.commands.executeCommand('chatgpt.addFileToThread', artifacts.image);
  }
}

/**
 * Claude Code builds its @-mention from `window.activeTextEditor` and takes no argument,
 * so the context file has to be the active editor for one moment. The tab it leaves
 * behind is closed again by URI, rather than closing whatever happens to be active.
 */
async function sendToClaude(artifacts: CaptureArtifacts): Promise<void> {
  await requireExtension('anthropic.claude-code', 'The Claude Code extension');
  const alreadyOpen = tabsFor(artifacts.context).length > 0;
  const document = await vscode.workspace.openTextDocument(artifacts.context);
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  try {
    await vscode.commands.executeCommand('claude-vscode.insertAtMention');
  } finally {
    if (!alreadyOpen) {
      await closeTabsFor(artifacts.context);
    }
  }
}

function tabsFor(uri: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    );
}

async function closeTabsFor(uri: vscode.Uri): Promise<void> {
  const tabs = tabsFor(uri);
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

async function copyToClipboard(artifacts: CaptureArtifacts): Promise<void> {
  const references = [
    `Browser context: ${artifacts.context.fsPath}`,
    artifacts.image ? `Screenshot: ${artifacts.image.fsPath}` : undefined,
  ].filter((value): value is string => Boolean(value));
  await vscode.env.clipboard.writeText(references.join('\n'));
  // Not awaited: the promise settles only once the notification is dismissed, which
  // would leave the capture command running until the user clicks it away.
  void vscode.window.showInformationMessage('Browser context file references copied to the clipboard.');
}

export async function sendArtifacts(artifacts: CaptureArtifacts, target: Target): Promise<void> {
  switch (target) {
    case 'codex':
      await sendToCodex(artifacts);
      return;
    case 'claude':
      await sendToClaude(artifacts);
      return;
    case 'clipboard':
      await copyToClipboard(artifacts);
      return;
  }
}
