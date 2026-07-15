import * as vscode from 'vscode';

import {
  CMakeToolsApi,
  CodeModel,
  getCMakeToolsApi,
  Project,
  Version
} from './cmakeToolsApi';

/**
 * Manages CMakeTools instances for multi-root workspace support.
 * Each workspace folder can have its own CMake project.
 */
export class CMakeToolsManager implements vscode.Disposable {
  private _instances: Map<string, CMakeTools> = new Map();
  private _sharedApi: CMakeToolsApi | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this.initSharedApi();
  }

  private async initSharedApi() {
    this._sharedApi = await getCMakeToolsApi(Version.v1000, true);
    if (!this._sharedApi) {
      this._sharedApi = await getCMakeToolsApi(Version.v5);
    }
  }

  /**
   * Gets or creates a CMakeTools instance for a specific workspace folder.
   */
  async getCMakeTools(folder: vscode.WorkspaceFolder): Promise<CMakeTools> {
    const folderUri = folder.uri.toString();
    
    let instance = this._instances.get(folderUri);
    if (!instance) {
      instance = new CMakeTools(this._sharedApi, folder);
      await instance.init();
      this._instances.set(folderUri, instance);
    }
    return instance;
  }

  /**
   * Gets the CMakeTools instance for a specific document URI.
   */
  async getCMakeToolsForDocument(document: vscode.TextDocument): Promise<CMakeTools | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      // Fallback to first instance if document is not in a workspace folder
      const firstInstance = this._instances.values().next().value;
      return firstInstance;
    }
    return this.getCMakeTools(folder);
  }

  /**
   * Removes the CMakeTools instance for a specific workspace folder.
   */
  removeCMakeTools(folder: vscode.WorkspaceFolder): void {
    const folderUri = folder.uri.toString();
    const instance = this._instances.get(folderUri);
    if (instance) {
      instance.dispose();
      this._instances.delete(folderUri);
    }
  }

  dispose(): void {
    for (const instance of this._instances.values()) {
      instance.dispose();
    }
    this._instances.clear();
    this._disposables.forEach(d => d.dispose());
  }
}

export class CMakeTools implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _cmakeToolsApi: CMakeToolsApi|undefined;
  private _cmakeProject: Project|undefined;
  private _workspaceFolder: string = '';
  private _workspaceFolderUri: vscode.Uri;
  // TODO: Default to configure in cmake tools extension
  private _buildDirectory: string|undefined;
  private _codeModel: CodeModel.Content|undefined;

  get buildDirectory(): string|undefined { return this._buildDirectory; }

  get cmakeToolsApi(): CMakeToolsApi|undefined { return this._cmakeToolsApi; }

  get cmakeProject(): Project|undefined { return this._cmakeProject; }

  get workspaceFolder(): vscode.Uri { return this._workspaceFolderUri; }

  constructor(cmakeToolsApi: CMakeToolsApi | undefined, folder: vscode.WorkspaceFolder) {
    this._cmakeToolsApi = cmakeToolsApi;
    this._workspaceFolderUri = folder.uri;
    this._workspaceFolder = folder.uri.fsPath;
  }

  async init() {
    if (this._cmakeToolsApi) {
      this._cmakeProject = await this._cmakeToolsApi.getProject(this._workspaceFolderUri);
      if (this._cmakeProject) {
        this._buildDirectory = await this._cmakeProject.getBuildDirectory();
        this._disposables.push(
            this._cmakeProject.onCodeModelChanged(
                this.onCodeModelChanged.bind(this)),
        );
        return;
      }
    }

    // Try to get a new API instance if the shared one didn't work
    this._cmakeToolsApi = await getCMakeToolsApi(Version.v1000, true);
    if (!this._cmakeToolsApi) {
      this._cmakeToolsApi = await getCMakeToolsApi(Version.v5);
    }
    
    if (!this._cmakeToolsApi) {
      return;
    }

    this._cmakeProject = await this._cmakeToolsApi.getProject(this._workspaceFolderUri);
    if (!this._cmakeProject) {
      // logger.info(`Project is undefined for ${this._workspaceFolder}`);
      return;
    }

    this._buildDirectory = await this._cmakeProject.getBuildDirectory();
    this._disposables.push(
        this._cmakeProject.onCodeModelChanged(
            this.onCodeModelChanged.bind(this)),
    );
  }

  async getProject(uri: vscode.Uri): Promise<Project|undefined> {
    if (this._cmakeToolsApi) {
      return this._cmakeToolsApi.getProject(uri);
    }
    return undefined;
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