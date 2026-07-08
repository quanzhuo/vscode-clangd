import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  logCMakeCompileCommand,
  logCMakeCompileCommands,
  logMissingCMakeCompileCommand,
} from './cmakeCompileCommandLog';
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
const sentCommandKeys = new Map<string, string>();
const compilationDatabaseAvailabilityByBuildDirectory =
    new Map<string, Promise<boolean>>();

function isClangdDocument(document: vscode.TextDocument): boolean {
  return clangdLanguages.has(document.languageId);
}

function commandKey(command: ResolvedCompileCommand): string {
  return JSON.stringify([command.workingDirectory, command.compilationCommand]);
}

export function compileCommandNeedsSend(command: ResolvedCompileCommand):
    boolean {
  return sentCommandKeys.get(command.uri.fsPath) !== commandKey(command);
}

export function markCompileCommandSent(command: ResolvedCompileCommand):
    boolean {
  const key = commandKey(command);
  const file = command.uri.fsPath;
  if (sentCommandKeys.get(file) === key) {
    return false;
  }
  sentCommandKeys.set(file, key);
  return true;
}

async function hasOnDiskCompilationDatabase(project: Project): Promise<boolean> {
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

async function queryCompilationDatabaseAvailability(project: Project):
    Promise<boolean> {
  if (project.getCompilationDatabaseInfo) {
    try {
      const info = await project.getCompilationDatabaseInfo();
      return info.state === 'available';
    } catch {
      return false;
    }
  }

  return hasOnDiskCompilationDatabase(project);
}

export function projectHasAvailableCompilationDatabase(project: Project):
    Promise<boolean> {
  return getCompilationDatabaseAvailability(project, false);
}

export function refreshCompilationDatabaseAvailability(project: Project):
    Promise<boolean> {
  return getCompilationDatabaseAvailability(project, true);
}

async function getCompilationDatabaseAvailability(project: Project,
                                                  refresh: boolean):
    Promise<boolean> {
  const buildDirectory = await project.getBuildDirectory();
  if (!buildDirectory) {
    return queryCompilationDatabaseAvailability(project);
  }

  const key = path.normalize(buildDirectory).toLowerCase();
  if (!refresh) {
    const cached = compilationDatabaseAvailabilityByBuildDirectory.get(key);
    if (cached) {
      return cached;
    }
  }

  // CDB availability changes only when CMake reconfigures the project.
  const availability = queryCompilationDatabaseAvailability(project);
  compilationDatabaseAvailabilityByBuildDirectory.set(key, availability);
  return availability;
}

export class CMakeCompileCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cmakeTools = new CMakeTools();
  private activeProjectDisposables: vscode.Disposable[] = [];
  private activeProject: Project|undefined;
  private readonly fullSyncProjects = new WeakSet<Project>();
  private readonly fullSyncTasks = new WeakMap<Project, Promise<void>>();
  private sentOverlayCommands = false;
  private ready = false;

  constructor(private readonly client: vscodelc.LanguageClient,
              private readonly outputChannel: vscode.OutputChannel) {}

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

    await this.onActiveProjectChanged(undefined);
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

    if (!project) {
      return;
    }

    if (project.onCompileCommandsChanged) {
      this.activeProjectDisposables.push(project.onCompileCommandsChanged(
          this.onCompileCommandsChanged.bind(this)));
    }

    if (await projectHasAvailableCompilationDatabase(project)) {
      return;
    }

    await Promise.all(vscode.workspace.textDocuments.map(
        (document) => this.pushCompileCommandForDocument(document)));
    void this.maybePushInitialTranslationUnitCommands(project);
  }

  private async onCompileCommandsChanged(
      event: CompileCommandsChangeEvent): Promise<void> {
    if (event.kind === 'full') {
      if (this.activeProject &&
          await refreshCompilationDatabaseAvailability(this.activeProject)) {
        if (this.sentOverlayCommands) {
          // clangd cannot clear LSP CDB overlays, so restart when disk CDB wins.
          this.sentOverlayCommands = false;
          await vscode.commands.executeCommand('clangd.restart');
        }
        return;
      }

      await Promise.all(vscode.workspace.textDocuments.map(
          (document) => this.pushCompileCommandForDocument(document)));
      if (this.activeProject) {
        // A full CMake update can change commands for files that are not open.
        this.fullSyncProjects.delete(this.activeProject);
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

      if (await projectHasAvailableCompilationDatabase(project)) {
        return;
      }

      const command = await project.getCompileCommand(uri);
      if (command) {
        logCMakeCompileCommand(
            this.outputChannel, 'runtime-changed-file-received', command);
        this.sendCompileCommands([command]);
      } else {
        logMissingCMakeCompileCommand(
            this.outputChannel, 'runtime-changed-file-received', uri,
            'cmake-tools returned undefined');
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

    if (await projectHasAvailableCompilationDatabase(project)) {
      return;
    }

    const command = await project.getCompileCommand(document.uri);
    if (!command) {
      logMissingCMakeCompileCommand(
          this.outputChannel, 'runtime-open-document-received', document.uri,
          'cmake-tools returned undefined');
      return;
    }

    if (!compileCommandNeedsSend(command)) {
      return;
    }

    logCMakeCompileCommand(
        this.outputChannel, 'runtime-open-document-received', command);
    this.sendCompileCommands([command]);
  }

  private async maybePushInitialTranslationUnitCommands(project: Project):
      Promise<void> {
    if (!project.getTranslationUnitCompileCommands ||
        this.fullSyncProjects.has(project)) {
      return;
    }

    if (await projectHasAvailableCompilationDatabase(project)) {
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

    const changedCommands =
        commands.filter((command) => compileCommandNeedsSend(command));
    if (changedCommands.length > 0) {
      logCMakeCompileCommands(
          this.outputChannel, 'runtime-translation-units-received',
          changedCommands);
      this.sendCompileCommands(changedCommands, fullSyncBatchSize);
    }
    this.fullSyncProjects.add(project);
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

    const changedCommands = commands.filter((command) => {
      return markCompileCommandSent(command);
    });

    if (changedCommands.length === 0) {
      return;
    }

    this.outputChannel.appendLine(
        `cmake-compile-command: phase=runtime-send-to-clangd ` +
        `count=${changedCommands.length}`);

    const compilationDatabaseChanges: Record<string, {
      workingDirectory: string,
      compilationCommand: string[],
    }> = {};

    for (const command of changedCommands) {
      compilationDatabaseChanges[command.uri.fsPath] = {
        workingDirectory: command.workingDirectory,
        compilationCommand: command.compilationCommand,
      };
    }

    this.client.sendNotification('workspace/didChangeConfiguration', {
      settings: {compilationDatabaseChanges}
    });
    this.sentOverlayCommands = true;
  }

}
