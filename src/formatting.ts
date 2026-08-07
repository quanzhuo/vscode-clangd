import * as cp from 'child_process';
import * as fs from 'fs';
import ignore = require('ignore');
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
  const globPattern = normalizeGlobPattern(
      config.get<string>('includePattern') ||
      '**/*.{c,cpp,h,hpp,cc,cxx,m,mm,cu,inc}');
  const excludePattern = normalizeGlobPattern(
      config.get<string>('excludePattern') ||
      '**/build/**,**/out/**,**/cmake-build-*/**');
  const concurrencyLevel = config.get<number>('concurrency', 0);
  const timeoutMs = config.get<number>('timeoutMs', 15000);
  const respectGitIgnore = config.get<boolean>('respectGitIgnore', true);
  const bundledStylePath =
      path.join(context.extensionPath, 'res', 'config', '.clang-format');

  // 3. Find files
  let files = await vscode.workspace.findFiles(globPattern, excludePattern);
  if (respectGitIgnore) {
    files = await filterGitIgnoredFiles(files);
  }

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
        const failureDetails: string[] = [];
        const styleLookupCache = new Map<string, Promise<boolean>>();

        // Determine concurrency
        const workerCount =
            concurrencyLevel > 0 ? concurrencyLevel : os.cpus().length;

        // Helper to process a single file
        const processFile = async (file: vscode.Uri) => {
          if (token.isCancellationRequested)
            return;

          const relativePath = vscode.workspace.asRelativePath(file, false);
          try {
            const styleArg =
                await resolveClangFormatStyleArg(file, bundledStylePath,
                                                 styleLookupCache);
            await runClangFormat(clangFormatPath,
                                 ['-i', styleArg, file.fsPath],
                                 {timeoutMs, token});
          } catch (e: any) {
            failures++;
            if (failureDetails.length < 5) {
              const message = e instanceof Error ? e.message : String(e);
              failureDetails.push(`${relativePath}: ${message}`);
            }
          } finally {
            processed++;
            progress.report({
              message: `${processed}/${total} (Errors: ${failures}) ${relativePath}`,
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
                    failures) +
                (failureDetails.length > 0 ?
                     ` ${failureDetails.join('; ')}` :
                     ''));
          } else {
            vscode.window.showInformationMessage(
                vscode.l10n.t('Workspace formatting completed.'));
          }
        }
      });
}

function normalizeGlobPattern(pattern: string): string {
  const parts = splitTopLevelCommaSeparated(pattern);
  return parts.length > 1 ? `{${parts.join(',')}}` : pattern;
}

function splitTopLevelCommaSeparated(pattern: string): string[] {
  const parts: string[] = [];
  let current = '';
  let braceDepth = 0;

  for (const char of pattern) {
    if (char === '{') {
      braceDepth++;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    if (char === ',' && braceDepth === 0) {
      const part = current.trim();
      if (part.length > 0) {
        parts.push(part);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const lastPart = current.trim();
  if (lastPart.length > 0) {
    parts.push(lastPart);
  }
  return parts;
}

async function filterGitIgnoredFiles(files: vscode.Uri[]):
    Promise<vscode.Uri[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return files;
  }

  const filters = new Map<string, ignore.Ignore|null>();
  for (const folder of workspaceFolders) {
    filters.set(folder.uri.fsPath, await loadGitIgnore(folder.uri.fsPath));
  }

  return files.filter(file => {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (!folder) {
      return true;
    }

    const filter = filters.get(folder.uri.fsPath);
    if (!filter) {
      return true;
    }

    const relativePath = toGitIgnorePath(
        path.relative(folder.uri.fsPath, file.fsPath));
    return !filter.ignores(relativePath);
  });
}

async function loadGitIgnore(workspaceFolderPath: string):
    Promise<ignore.Ignore|null> {
  const gitIgnorePath = path.join(workspaceFolderPath, '.gitignore');

  try {
    const contents = await fs.promises.readFile(gitIgnorePath, 'utf8');
    return ignore().add(contents);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return null;
    }

    throw e;
  }
}

function toGitIgnorePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

async function resolveClangFormatStyleArg(
    file: vscode.Uri, bundledStylePath: string,
    styleLookupCache: Map<string, Promise<boolean>>): Promise<string> {
  const folder = vscode.workspace.getWorkspaceFolder(file);
  if (folder) {
    const hasWorkspaceStyle = await hasClangFormatStyleInPath(
        path.dirname(file.fsPath), folder.uri.fsPath, styleLookupCache);
    if (hasWorkspaceStyle) {
      return '-style=file';
    }
  }

  if (await pathExists(bundledStylePath)) {
    return `-style=file:${bundledStylePath}`;
  }

  return '-style=file';
}

async function hasClangFormatStyleInPath(
    directory: string, workspaceFolderPath: string,
    cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const resolvedDirectory = path.resolve(directory);
  const resolvedWorkspaceFolder = path.resolve(workspaceFolderPath);

  if (!isPathInsideOrEqual(resolvedDirectory, resolvedWorkspaceFolder)) {
    return false;
  }

  const cacheKey = normalizePathKey(resolvedDirectory);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = (async () => {
    if (await pathExists(path.join(resolvedDirectory, '.clang-format'))) {
      return true;
    }

    if (samePath(resolvedDirectory, resolvedWorkspaceFolder)) {
      return false;
    }

    const parent = path.dirname(resolvedDirectory);
    if (samePath(parent, resolvedDirectory)) {
      return false;
    }

    return hasClangFormatStyleInPath(parent, resolvedWorkspaceFolder, cache);
  })();

  cache.set(cacheKey, lookup);
  return lookup;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' ||
         (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() :
                                       resolvedPath;
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

interface ClangFormatOptions {
  timeoutMs: number;
  token?: vscode.CancellationToken;
}

function runClangFormat(command: string, args: string[],
                        options?: ClangFormatOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout|undefined;
    let cancellation: vscode.Disposable|undefined;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cancellation?.dispose();

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const child = cp.execFile(command, args, {windowsHide: true}, (err) => {
      finish(err ?? undefined);
    });

    timeout = options?.timeoutMs && options.timeoutMs > 0 ?
        setTimeout(() => {
          finish(new Error(`clang-format timed out after ${options.timeoutMs}ms`));
          child.kill();
        }, options.timeoutMs) :
        undefined;

    cancellation = options?.token?.onCancellationRequested(() => {
      finish(new Error('clang-format cancelled.'));
      child.kill();
    });
  });
}
