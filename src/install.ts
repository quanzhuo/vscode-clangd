// Automatically install clangd binary releases from GitHub.
// This wraps `@clangd/install` in the VSCode UI. See that package for more.

import * as common from '@clangd/install';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import * as vscode from 'vscode';

import * as config from './config';
import {extContext} from './extension';

// Returns the clangd path to be used, or null if clangd is not installed.
export async function activate(disposables: vscode.Disposable[],
                               globalStoragePath: string):
    Promise<string|null> {
  const ui = await UI.create(disposables, globalStoragePath);
  disposables.push(vscode.commands.registerCommand(
      'clangd.install', async () => common.installLatest(ui)));
  disposables.push(vscode.commands.registerCommand(
      'clangd.update', async () => common.checkUpdates(true, ui)));
  const status =
      await common.prepare(ui, await config.get<boolean>('checkUpdates'));
  return status.clangdPath;
}

class UI {
  static async create(disposables: vscode.Disposable[],
                      globalStoragePath: string): Promise<UI> {
    const ui = new UI(disposables, globalStoragePath);
    await ui.resolveClangdPath();
    return ui;
  }

  private constructor(private disposables: vscode.Disposable[],
                      private globalStoragePath: string) {}

  get storagePath(): string { return this.globalStoragePath; }
  async choose(prompt: string, options: string[]): Promise<string|undefined> {
    return await vscode.window.showInformationMessage(prompt, ...options);
  }
  slow<T>(title: string, result: Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: false,
    };
    return Promise.resolve(vscode.window.withProgress(opts, () => result));
  }
  progress<T>(title: string, cancel: AbortController|null,
              body: (progress: (fraction: number) => void) => Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: cancel !== null,
    };
    const result = vscode.window.withProgress(opts, async (progress, canc) => {
      if (cancel)
        canc.onCancellationRequested((_) => cancel.abort());
      let lastFraction = 0;
      return body(fraction => {
        if (fraction > lastFraction) {
          progress.report({increment: 100 * (fraction - lastFraction)});
          lastFraction = fraction;
        }
      });
    });
    return Promise.resolve(result); // Thenable to real promise.
  }
  localize(message: string, ...args: Array<string|number|boolean>): string {
    let ret = message;
    for (const i in args) {
      ret = ret.replace(`{${i}}`, args[i].toString());
    }
    return ret;
  }
  error(s: string) { vscode.window.showErrorMessage(s); }
  info(s: string) { vscode.window.showInformationMessage(s); }
  command(name: string, body: () => any) {
    this.disposables.push(vscode.commands.registerCommand(name, body));
  }

  async shouldReuse(release: string): Promise<boolean|undefined> {
    const message = vscode.l10n.t('clangd {0} is already installed!', release);
    const use = vscode.l10n.t('Use the installed version');
    const reinstall = vscode.l10n.t('Delete it and reinstall');
    const response =
        await vscode.window.showInformationMessage(message, use, reinstall);
    if (response === use) {
      // Find clangd within the existing directory.
      return true;
    } else if (response === reinstall) {
      // Remove the existing installation.
      return false;
    } else {
      // User dismissed prompt, bail out.
      return undefined;
    }
  }

  private _pathUpdated: Promise<void>|null = null;

  async promptReload(message: string) {
    vscode.window.showInformationMessage(message);
    await this._pathUpdated;
    this._pathUpdated = null;
    vscode.commands.executeCommand('clangd.restart');
  }

  async showHelp(message: string, url: string) {
    if (await vscode.window.showInformationMessage(
            message, vscode.l10n.t('Open website')))
      vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async promptUpdate(oldVersion: string, newVersion: string) {
    const message = vscode.l10n.t(
        'An updated clangd language server is available.\n Would you like to upgrade to clangd {0}? (from {1})',
        newVersion, oldVersion);
    const update = vscode.l10n.t('Install clangd {0}', newVersion);
    const dontCheck = vscode.l10n.t('Don\'t ask again');
    const response =
        await vscode.window.showInformationMessage(message, update, dontCheck);
    if (response === update) {
      common.installLatest(this);
    } else if (response === dontCheck) {
      config.update('checkUpdates', false, vscode.ConfigurationTarget.Global);
    }
  }

  async promptInstall(version: string) {
    const p = this.clangdPath;
    let message = '';
    if (p.indexOf(path.sep) < 0) {
      message +=
          vscode.l10n.t(
              'The \'{0}\' language server was not found on your PATH.', p) +
          '\n';
    } else {
      message +=
          vscode.l10n.t('The clangd binary \'{0}\' was not found.', p) + '\n';
    }
    message += vscode.l10n.t(
        'Would you like to download and install clangd {0}?', version);
    if (await vscode.window.showInformationMessage(message,
                                                   vscode.l10n.t('Install')))
      common.installLatest(this);
  }

  async resolveClangdPath() {
    if (await this.useBundledClangd()) {
      return;
    }

    let p = await config.get<string>('path');
    // Backwards compatibility: if it's a relative path with a slash, interpret
    // relative to project root.
    if (!path.isAbsolute(p) && p.includes(path.sep) &&
        vscode.workspace.rootPath !== undefined) {
      p = path.join(vscode.workspace.rootPath, p);
    }

    this._clangdPath = p;
  }

  async useBundledClangd(): Promise<boolean> {
    const workspaceConfig = vscode.workspace.getConfiguration('clangd');
    const inspectNew = workspaceConfig.inspect<boolean>('preferBundledClangd');
    const newIsSet = inspectNew?.globalValue !== undefined ||
                     inspectNew?.workspaceValue !== undefined ||
                     inspectNew?.workspaceFolderValue !== undefined;

    // `useBuiltInClangdIfAvailable` renamed to `preferBundledClangd` since
    // v0.5.0 but we still support the old setting for backwards compatibility.
    const useBundled =
        newIsSet ? workspaceConfig.get<boolean>('preferBundledClangd')
                 : workspaceConfig.get<boolean>('useBuiltInClangdIfAvailable');

    if (!useBundled) {
      return false;
    }

    const extensionPath = extContext!.extensionPath;
    const clangdExe = os.platform() === 'win32' ? 'clangd.exe' : 'clangd';
    const clangdPath =
        path.join(extensionPath, 'res', 'clangd', 'bin', clangdExe);
    if (fs.existsSync(clangdPath)) {
      this._clangdPath = clangdPath;
      return true;
    }

    const tgzPath = path.join(extensionPath, 'res', 'clangd.tgz')
    if (!fs.existsSync(tgzPath)) {
      return false;
    }

    // Extract the tarball to the global storage path.
    const extractPath = path.join(extensionPath, 'res');
    await this.slow(vscode.l10n.t('Extracting bundled clangd...'), tar.x({
      file: tgzPath,
      cwd: extractPath,
      gzip: true,
    }));

    if (fs.existsSync(clangdPath)) {
      this._clangdPath = clangdPath;
      return true;
    }
    return false;
  }

  private _clangdPath?: string = undefined;

  get clangdPath(): string { return this._clangdPath as string; }
  set clangdPath(p: string) {
    this._pathUpdated = new Promise(resolve => {
      config.update('path', p, vscode.ConfigurationTarget.Global).then(() => {
        this._clangdPath = p;
        resolve();
      });
    });
  }
}
