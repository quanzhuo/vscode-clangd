import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as fs from 'fs/promises';
import * as path from 'path';

import {CMakeTools} from './cmakeTools';
import {
  CompileCommandsChangeEvent,
  Project,
  ResolvedCompileCommand,
} from './cmakeToolsApi';

const clangdLanguages = new Set([
  'c',
  'cpp',
  'cuda-cpp',
  'objective-c',
  'objective-cpp',
]);

const fullSyncBatchSize = 200;

function isClangdDocument(document: vscode.TextDocument): boolean {
  return clangdLanguages.has(document.languageId);
}

export class CMakeCompileCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cmakeTools = new CMakeTools();
  private activeProjectDisposables: vscode.Disposable[] = [];
  private activeProject: Project|undefined;
  private readonly diskCdbProjects = new WeakSet<Project>();
  private readonly fullSyncProjects = new WeakSet<Project>();
  private readonly fullSyncTasks = new WeakMap<Project, Promise<void>>();
  private ready = false;

  constructor(private readonly client: vscodelc.LanguageClient) {}

  async activate(): Promise<void> {
    await this.cmakeTools.init();
    this.disposables.push(this.cmakeTools);

    const api = this.cmakeTools.cmakeToolsApi;
    if (!api) {
      return;
    }

    const project = this.cmakeTools.cmakeProject;
    if (!project || !project.getCompileCommand ||
        !project.getTranslationUnitCompileCommands) {
      return;
    }

    // This keeps clangd in sync after startup. Initial open documents still
    // need initialize-time seeding because the client is already running here.
    this.ready = true;

    this.disposables.push(api.onActiveProjectChanged(
        (uri) => void this.onActiveProjectChanged(uri)));
    this.disposables.push(vscode.workspace.onDidOpenTextDocument(
        (document) => void this.pushCompileCommandForDocument(document)));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void this.pushCompileCommandForDocument(editor.document);
      }
    }));

    await this.onActiveProjectChanged(undefined);
    await Promise.all(vscode.workspace.textDocuments.map(
        (document) => this.pushCompileCommandForDocument(document)));
  }

  dispose() {
    this.activeProjectDisposables.forEach((disposable) => disposable.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async onActiveProjectChanged(uri: vscode.Uri|undefined):
      Promise<void> {
    const project = uri ? await this.cmakeTools.getProject(uri) :
                          this.cmakeTools.cmakeProject;
    await this.bindProject(project);
  }

  private async bindProject(project: Project|undefined): Promise<void> {
    this.activeProjectDisposables.forEach((disposable) => disposable.dispose());
    this.activeProjectDisposables = [];
    this.activeProject = project;

    if (!project || !project.onCompileCommandsChanged) {
      return;
    }

    this.activeProjectDisposables.push(project.onCompileCommandsChanged(
        this.onCompileCommandsChanged.bind(this)));
    await Promise.all(vscode.workspace.textDocuments.map(
        (document) => this.pushCompileCommandForDocument(document)));
    void this.maybePushInitialTranslationUnitCommands(project);
  }

  private async onCompileCommandsChanged(
      event: CompileCommandsChangeEvent): Promise<void> {
    if (event.kind === 'full') {
      await Promise.all(vscode.workspace.textDocuments.map(
          (document) => this.pushCompileCommandForDocument(document)));
      if (this.activeProject) {
        void this.maybePushInitialTranslationUnitCommands(this.activeProject);
      }
      return;
    }

    if (!event.files) {
      return;
    }

    await Promise.all(event.files.map(async (uri) => {
      const project = await this.cmakeTools.getProject(uri);
      if (!project?.getCompileCommand) {
        return;
      }

      const command = await project.getCompileCommand(uri);
      if (command) {
        this.sendCompileCommands([command]);
      }
    }));
  }

  private async pushCompileCommandForDocument(document: vscode.TextDocument):
      Promise<void> {
    if (!this.ready || !isClangdDocument(document)) {
      return;
    }

    const project = await this.cmakeTools.getProject(document.uri);
    if (!project?.getCompileCommand) {
      return;
    }

    const command = await project.getCompileCommand(document.uri);
    if (!command) {
      return;
    }

    this.sendCompileCommands([command]);
  }

  private async maybePushInitialTranslationUnitCommands(project: Project):
      Promise<void> {
    if (!project.getTranslationUnitCompileCommands ||
        this.diskCdbProjects.has(project) ||
        this.fullSyncProjects.has(project)) {
      return;
    }

    if (await this.hasOnDiskCompilationDatabase(project)) {
      this.diskCdbProjects.add(project);
      this.fullSyncProjects.add(project);
      return;
    }

    const existingTask = this.fullSyncTasks.get(project);
    if (existingTask) {
      await existingTask;
      return;
    }

    const task = this.pushInitialTranslationUnitCommands(project);
    this.fullSyncTasks.set(project, task);

    try {
      await task;
    } finally {
      this.fullSyncTasks.delete(project);
    }
  }

  private async pushInitialTranslationUnitCommands(project: Project):
      Promise<void> {
    const commands = await project.getTranslationUnitCompileCommands?.();
    if (!commands || commands.length === 0) {
      return;
    }

    this.sendCompileCommands(commands, fullSyncBatchSize);
    this.fullSyncProjects.add(project);
  }

  private async hasOnDiskCompilationDatabase(project: Project):
      Promise<boolean> {
    const buildDirectory = await project.getBuildDirectory();
    if (!buildDirectory) {
      return false;
    }

    try {
      await fs.access(path.join(buildDirectory, 'compile_commands.json'));
      return true;
    } catch {
      return false;
    }
  }

  private sendCompileCommands(commands: ResolvedCompileCommand[],
                              batchSize?: number): void {
    if (!this.ready || commands.length === 0) {
      return;
    }

    if (!batchSize || batchSize <= 0 || commands.length <= batchSize) {
      this.sendCompileCommandsBatch(commands);
      return;
    }

    for (let index = 0; index < commands.length; index += batchSize) {
      this.sendCompileCommandsBatch(commands.slice(index, index + batchSize));
    }
  }

  private sendCompileCommandsBatch(commands: ResolvedCompileCommand[]): void {
    if (!this.ready || commands.length === 0) {
      return;
    }

    const compilationDatabaseChanges: Record<string, {
      workingDirectory: string,
      compilationCommand: string[],
    }> = {};

    for (const command of commands) {
      compilationDatabaseChanges[command.uri.fsPath] = {
        workingDirectory: command.workingDirectory,
        compilationCommand: command.compilationCommand,
      };
    }

    this.client.sendNotification('workspace/didChangeConfiguration', {
      settings: {compilationDatabaseChanges}
    });
  }
}