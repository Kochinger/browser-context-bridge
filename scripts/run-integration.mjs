import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, '.test-dist');
const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'browser-context-bridge-vscode-'));

// Codex runs shell commands inside VS Code's extension host and therefore
// inherits variables that would make a nested Electron process start as Node.
delete process.env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('VSCODE_')) {
    delete process.env[name];
  }
}

await mkdir(outputDirectory, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'test', 'integration', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: path.join(outputDirectory, 'integration.cjs'),
  external: ['vscode'],
});

try {
  await runTests({
    vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(outputDirectory, 'integration.cjs'),
    launchArgs: [
      root,
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${path.join(homedir(), '.vscode', 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
} finally {
  if (userDataDirectory.startsWith(path.join(tmpdir(), 'browser-context-bridge-vscode-'))) {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}
