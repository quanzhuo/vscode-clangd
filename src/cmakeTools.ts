import * as vscode from 'vscode';

import {
  CMakeToolsApi,
  CodeModel,
  getCMakeToolsApi,
  Project,
  Version
} from './cmakeToolsApi';

export class CMakeTools implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _cmakeToolsApi: CMakeToolsApi|undefined;
  private _cmakeProject: Project|undefined;
  private _workspaceFolder: string = '';
  // TODO: Default to configure in cmake tools extension
  private _buildDirectory: string|undefined;
  private _codeModel: CodeModel.Content|undefined;

  get buildDirectory(): string|undefined { return this._buildDirectory; }

  get cmakeToolsApi(): CMakeToolsApi|undefined { return this._cmakeToolsApi; }

  get cmakeProject(): Project|undefined { return this._cmakeProject; }

  async init() {
    this._cmakeToolsApi = await getCMakeToolsApi(Version.v1);
    if (!this._cmakeToolsApi) {
      return;
    }

    this._workspaceFolder = this._cmakeToolsApi.getActiveFolderPath();
    this._cmakeProject = await this._cmakeToolsApi.getProject(
        vscode.Uri.file(this._workspaceFolder));
    if (!this._cmakeProject) {
      // logger.info(`Project is undefined for ${this._workspaceFolder}`);
      return;
    }

    this._buildDirectory = await this._cmakeProject.getBuildDirectory();
    this._disposables.push(
        // this._cmakeToolsApi.onActiveProjectChanged(this.onActiveProjectChanged.bind(this)),
        // this._cmakeToolsApi.onBuildTargetChanged(this.onBuildTargetChanged.bind(this)),
        // this._cmakeToolsApi.onLaunchTargetChanged(this.onLaunchTargetChanged.bind(this)),
        this._cmakeProject.onCodeModelChanged(
            this.onCodeModelChanged.bind(this)),
        // this._cmakeProject.onSelectedConfigurationChanged(this.onSelectedConfigurationChanged.bind(this)),
    );
  }

  private async onCodeModelChanged() {
    this._codeModel = this._cmakeProject?.codeModel;
    if (!this._codeModel) {
      return;
    }

    const buildDirectory = await this._cmakeProject?.getBuildDirectory();
    if (this._buildDirectory !== buildDirectory) {
      this._buildDirectory = buildDirectory;
      vscode.commands.executeCommand('clangd.restart');
    }
  }

  dispose() { this._disposables.forEach((disposable) => disposable.dispose()); }
}