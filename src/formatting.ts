import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export async function formatWorkspace(context: vscode.ExtensionContext) {
  // 1. Resolve clang-format path
  const clangFormatPath = await resolveClangFormatPath(context);
  if (!clangFormatPath) {
    vscode.window.showErrorMessage(
        vscode.l10n.t(
            'Clang-format executable not found. Please check your configuration or install clang-format.'));
    return;
  }

  // 2. Resolve glob patterns
  const config = vscode.workspace.getConfiguration('clangd.formatting');
  const globPattern = config.get<string>('includePattern') ||
                      '**/*.{c,cpp,h,hpp,cc,cxx,m,mm,cu,inc}';
  const excludePattern = config.get<string>('excludePattern') ||
                         '**/build/**,**/out/**,**/cmake-build-*/**';
  const concurrencyLevel = config.get<number>('concurrency', 0);

  // 3. Find files
  const files = await vscode.workspace.findFiles(globPattern, excludePattern);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('No C/C++ files found to format.'));
    return;
  }

  // 4. Confirm action (Destructive & Auto-save warning)
    const confirmFormat = vscode.l10n.t('Confirm Format');
    const cancel = vscode.l10n.t('Cancel');
  const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'This operation will modify {0} files on disk AND save all open editors. It cannot be undone from VS Code. Ensure your work is committed to Git.',
        files.length),
      confirmFormat, cancel);

  if (confirm !== confirmFormat) {
    return;
  }

  // 5. Save all open files to avoid conflicts
  await vscode.workspace.saveAll();

  // 6. Execute formatting with concurrency
  await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Formatting Workspace'),
        cancellable: true
      },
      async (progress, token) => {
        const total = files.length;
        let processed = 0;
        let failures = 0;

        // Determine concurrency
        const workerCount =
            concurrencyLevel > 0 ? concurrencyLevel : os.cpus().length;

        // Helper to process a single file
        const processFile = async (file: vscode.Uri) => {
          if (token.isCancellationRequested)
            return;

          try {
            await runClangFormat(clangFormatPath,
                                 ['-i', '-style=file', file.fsPath]);
          } catch (e: any) {
            failures++;
          } finally {
            processed++;
            progress.report({
              message: `${processed}/${total} (Errors: ${failures})`,
              increment: (1 / total) * 100
            });
          }
        };

        // Promise Pool implementation
        const queue = [...files];
        const workers =
            Array(Math.min(workerCount, queue.length))
                .fill(null)
                .map(async () => {
                  while (queue.length > 0 && !token.isCancellationRequested) {
                    const file = queue.shift();
                    if (file)
                      await processFile(file);
                  }
                });

        await Promise.all(workers);

        if (token.isCancellationRequested) {
          vscode.window.showInformationMessage(
              vscode.l10n.t('Workspace formatting cancelled.'));
        } else {
          if (failures > 0) {
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Workspace formatting completed with {0} failures.',
                    failures));
          } else {
            vscode.window.showInformationMessage(
                vscode.l10n.t('Workspace formatting completed.'));
          }
        }
      });
}

async function resolveClangFormatPath(context: vscode.ExtensionContext):
    Promise<string|undefined> {
  const config = vscode.workspace.getConfiguration('clangd.formatting');

  // Priority: Built-in (if preferred & exists) > System/Config
  const preferBundled = config.get<boolean>('preferBundledClangFormat');
  const configPath = config.get<string>('clangFormatPath');
  const binaryName =
      process.platform === 'win32' ? 'clang-format.exe' : 'clang-format';
  const bundledPath = path.join(context.extensionPath, 'res', binaryName);
  const hasBundled = fs.existsSync(bundledPath);

  if (preferBundled && hasBundled) {
    return bundledPath;
  }

  // Check user config
  if (configPath) {
    // Basic verification - try asking for version
    try {
      await runClangFormat(configPath, ['--version']);
      return configPath;
    } catch (e) {
      // Configured path is invalid
    }
  }

  return undefined;
}

function runClangFormat(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
