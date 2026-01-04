import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext} from './clangd-context';
import * as config from './config';
import {extContext} from './extension';

export async function activate(context: ClangdContext) {
  if (await config.get<string>('onConfigChanged') !== 'ignore') {
    context.client.registerFeature(new ConfigFileWatcherFeature(context));
  }

  context.subscriptions.push(
      vscode.commands.registerCommand(
          'clangd.createClangdConfigFile',
          async () => { await createClangdConfigFile(context); }),
  );
}

class ClangdConfigFilePickItem implements vscode.QuickPickItem {
  constructor(
      public label: string,
      public detail?: string,
      public picked?: boolean,
  ) {}
}

async function createClangdConfigFile(context: ClangdContext) {
  await vscode.window
      .showQuickPick(
          [
            new ClangdConfigFilePickItem(
                '.clangd',
                vscode.l10n.t(
                    '.clangd is used to configure clangd features (completion, diagnostics, etc.), requires clangd version 11 or later.'),
                true),
            new ClangdConfigFilePickItem(
                '.clang-tidy',
                vscode.l10n.t(
                    '.clang-tidy is used to configure clang-tidy checks and diagnostics.'),
                true),
            new ClangdConfigFilePickItem(
                '.clang-format',
                vscode.l10n.t(
                    '.clang-format is used to configure code formatting style.'),
                true),
          ],
          {
            title: vscode.l10n.t(
                'Select configure files to create in the workspace folder'),
            canPickMany: true,
            ignoreFocusOut: true,
          })
      .then(async (items) => {
        if (!items) {
          return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          return;
        }

        for (const item of items) {
          const fileFrom =
              path.join(extContext!.extensionPath, 'res', 'config', item.label);
          const filePath =
              path.join(workspaceFolders[0].uri.fsPath, item.label);

          if (!fs.existsSync(filePath)) {
            fs.copyFileSync(fileFrom, filePath);
          }
        }
      });
}

// Clangd extension capabilities.
interface ClangdClientCapabilities {
  compilationDatabase?: {automaticReload?: boolean;},
}

class ConfigFileWatcherFeature implements vscodelc.StaticFeature {
  constructor(private context: ClangdContext) {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities) {}

  async initialize(capabilities: vscodelc.ServerCapabilities,
                   _documentSelector: vscodelc.DocumentSelector|undefined) {
    if (!await config.get<boolean>('onConfigChangedForceEnable') &&
        (capabilities as ClangdClientCapabilities)
            .compilationDatabase?.automaticReload) {
      return;
    }
    this.context.subscriptions.push(new ConfigFileWatcher(this.context));
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  clear() {}
}

class ConfigFileWatcher implements vscode.Disposable {
  private databaseWatcher?: vscode.FileSystemWatcher;
  private debounceTimer?: NodeJS.Timeout;

  dispose() {
    if (this.databaseWatcher)
      this.databaseWatcher.dispose();
  }

  constructor(private context: ClangdContext) {
    this.createFileSystemWatcher();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(
        () => { this.createFileSystemWatcher(); }));
  }

  createFileSystemWatcher() {
    if (this.databaseWatcher)
      this.databaseWatcher.dispose();
    if (vscode.workspace.workspaceFolders) {
      this.databaseWatcher = vscode.workspace.createFileSystemWatcher(
          '{' +
          vscode.workspace.workspaceFolders.map(f => f.uri.fsPath).join(',') +
          '}/{build/compile_commands.json,compile_commands.json,compile_flags.txt}');
      this.context.subscriptions.push(this.databaseWatcher.onDidChange(
          this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.databaseWatcher.onDidCreate(
          this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.databaseWatcher);
    }
  }

  async debouncedHandleConfigFilesChanged(uri: vscode.Uri) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      await this.handleConfigFilesChanged(uri);
      this.debounceTimer = undefined;
    }, 2000);
  }

  async handleConfigFilesChanged(uri: vscode.Uri) {
    // Sometimes the tools that generate the compilation database, before
    // writing to it, they create a new empty file or they clear the existing
    // one, and after the compilation they write the new content. In this cases
    // the server is not supposed to restart
    if ((await vscode.workspace.fs.stat(uri)).size <= 0)
      return;

    switch (await config.get<string>('onConfigChanged')) {
    case 'restart':
      vscode.commands.executeCommand('clangd.restart');
      break;
    case 'ignore':
      break;
    case 'prompt':
    default:
      const yes = vscode.l10n.t('Yes');
      const yesAlways = vscode.l10n.t('Yes, always');
      const noNever = vscode.l10n.t('No, never');
      switch (await vscode.window.showInformationMessage(
          vscode.l10n.t(
              `Clangd configuration file at {0} has been changed. Do you want to restart it?`,
              uri.fsPath),
          yes, yesAlways, noNever)) {
      case yes:
        vscode.commands.executeCommand('clangd.restart');
        break;
      case yesAlways:
        vscode.commands.executeCommand('clangd.restart');
        config.update<string>('onConfigChanged', 'restart',
                              vscode.ConfigurationTarget.Global);
        break;
      case noNever:
        config.update<string>('onConfigChanged', 'ignore',
                              vscode.ConfigurationTarget.Global);
        break;
      default:
        break;
      }
      break;
    }
  }
}
