'use strict';

import * as vscode from 'vscode';

export interface QMakeToolsApi {
  getBuildDirectory: () => string;
  onBuildDirectoryChanged: vscode.Event<string>;
}
;

export async function getQMakeToolsApi(): Promise<QMakeToolsApi|undefined> {
  const extension = vscode.extensions.getExtension('KylinIdeTeam.qmake-tools');

  if (!extension) {
    console.warn(
        '[qmake-tools-api] QMake Tools extension is not installed, Please install extension `KylinIdeTeam.qmake-tools` first.');
    return undefined;
  }

  let exports: QMakeToolsApi|undefined;
  if (!extension.isActive) {
    try {
      // activate() may throw if VS Code is shutting down.
      exports = await extension.activate();
    } catch {
    }
  } else {
    exports = extension.exports;
  }

  if (!exports || !exports.getBuildDirectory ||
      !exports.onBuildDirectoryChanged) {
    console.warn(
        '[qmake-tools-api] QMake Tools extension does not provide an API.');
    return undefined;
  }

  return exports;
}

export class QMakeTools implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];

  private _buildDirectory: string|undefined;
  private _qmakeToolsApi: QMakeToolsApi|undefined;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(this);
  }

  get buildDirectory(): string|undefined { return this._buildDirectory; }

  async init() {
    const qmakeToolsApi = await getQMakeToolsApi();
    if (!qmakeToolsApi) {
      return;
    }

    this._qmakeToolsApi = qmakeToolsApi;
    this._buildDirectory = qmakeToolsApi.getBuildDirectory();

    this._disposables.push(
        this._qmakeToolsApi.onBuildDirectoryChanged((buildDirectory) => {
          if (this._buildDirectory !== buildDirectory) {
            this._buildDirectory = buildDirectory;
            vscode.commands.executeCommand('clangd.restart');
          }
        }));
  }

  dispose() { this._disposables.forEach((disposable) => disposable.dispose()); }
}