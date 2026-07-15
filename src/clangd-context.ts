import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import * as ast from './ast';
import {
  logCMakeCompileCommand,
  logCMakeCompileCommands,
  logMissingCMakeCompileCommand,
} from './cmakeCompileCommandLog';
import {
  CMakeCompileCommands,
  compileCommandNeedsSend,
  markCompileCommandSent,
  projectHasAvailableCompilationDatabase,
} from './cmakeCompileCommands';
import {CMakeTools} from './cmakeTools';
import * as config from './config';
import * as configFileWatcher from './config-file-watcher';
import {extContext} from './extension';
import * as fileStatus from './file-status';
import * as inactiveRegions from './inactive-regions';
import * as inlayHints from './inlay-hints';
import * as install from './install';
import * as memoryUsage from './memory-usage';
import * as openConfig from './open-config';
import * as overrideMethods from './override-methods';
import {QMakeTools} from './qmakeToolsApi';
import * as switchSourceHeader from './switch-source-header';
import * as symbolInfo from './symbol-info';
import * as typeHierarchy from './type-hierarchy';
import {ResolvedCompileCommand} from './cmakeToolsApi';

export const clangdDocumentSelector = [
  {scheme: 'file', language: 'c'},
  {scheme: 'file', language: 'cpp'},
  {scheme: 'file', language: 'cuda-cpp'},
  {scheme: 'file', language: 'objective-c'},
  {scheme: 'file', language: 'objective-cpp'},
];

export function isClangdDocument(document: vscode.TextDocument) {
  return vscode.languages.match(clangdDocumentSelector, document);
}

export class ClangdLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any,
                         token: vscode.CancellationToken|undefined,
                         defaultValue: T): T {
    // Handle command registration conflicts in multi-root workspaces.
    // When multiple clangd clients try to register the same commands
    // (e.g., clangd.applyFix), the second client will fail with an error.
    // We need to ignore these specific errors and return the default value.
    if (error && error.message &&
        (error.message.includes('command already exists') ||
         error.message.includes('is already registered') ||
         error.message.includes('already exists'))) {
      console.log(`[ClangdLanguageClient] Ignoring command registration conflict for ${type.method}`);
      return defaultValue;
    }

    if (error instanceof vscodelc.ResponseError &&
        type.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);

    return super.handleFailedRequest(type, token, error, defaultValue);
  }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
        capabilities.textDocument?.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  clear() {}
}

export class ClangdContext implements vscode.Disposable {
  subscriptions: vscode.Disposable[];
  client: ClangdLanguageClient;
  workspaceFolder: vscode.WorkspaceFolder | undefined;

  static async create(globalStoragePath: string,
                      outputChannel: vscode.OutputChannel):
      Promise<ClangdContext|null> {
    const subscriptions: vscode.Disposable[] = [];
    const clangdPath = await install.activate(subscriptions, globalStoragePath);
    if (!clangdPath) {
      subscriptions.forEach((d) => { d.dispose(); });
      return null;
    }

    return new ClangdContext(
        subscriptions,
        await ClangdContext.createClient(
            clangdPath, outputChannel, subscriptions));
  }

  /**
   * Creates a ClangdContext for a specific workspace folder.
   * This is used for multi-root workspace support.
   */
  static async createForFolder(globalStoragePath: string,
                               outputChannel: vscode.OutputChannel,
                               folder: vscode.WorkspaceFolder):
      Promise<ClangdContext|null> {
    const subscriptions: vscode.Disposable[] = [];
    const clangdPath = await install.activate(subscriptions, globalStoragePath);
    if (!clangdPath) {
      subscriptions.forEach((d) => { d.dispose(); });
      return null;
    }

    const context = new ClangdContext(
        subscriptions,
        await ClangdContext.createClientForFolder(
            clangdPath, outputChannel, subscriptions, folder));
    context.workspaceFolder = folder;
    return context;
  }

  private static async createClient(clangdPath: string,
                                    outputChannel: vscode.OutputChannel,
                                    subscriptions: vscode.Disposable[]):
      Promise<ClangdLanguageClient> {
    // For backwards compatibility, use the first workspace folder if available
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders && folders.length > 0 ? folders[0] : undefined;
    return ClangdContext.createClientForFolder(
        clangdPath, outputChannel, subscriptions, folder);
  }

  private static async createClientForFolder(clangdPath: string,
                                             outputChannel: vscode.OutputChannel,
                                             subscriptions: vscode.Disposable[],
                                             folder: vscode.WorkspaceFolder | undefined):
      Promise<ClangdLanguageClient> {
    const useScriptAsExecutable =
        await config.get<boolean>('useScriptAsExecutable');
    // let clangdArguments = await config.get<string[]>('arguments');
    let clangdArguments = await ClangdContext.getClangdArgs();
    if (useScriptAsExecutable) {
      let quote = (str: string) => { return `"${str}"`; };
      clangdPath = quote(clangdPath)
      for (var i = 0; i < clangdArguments.length; i++) {
        clangdArguments[i] = quote(clangdArguments[i]);
      }
    }
    const clangd: vscodelc.Executable = {
      command: clangdPath,
      args: clangdArguments,
      options: {
        cwd: folder?.uri.fsPath || vscode.workspace.rootPath || process.cwd(),
        shell: useScriptAsExecutable
      }
    };
    const traceFile = await config.get<string>('trace');
    if (!!traceFile) {
      const trace = {CLANGD_TRACE: traceFile};
      clangd.options = {...clangd.options, env: {...process.env, ...trace}};
    }
    const serverOptions: vscodelc.ServerOptions = clangd;
    let client: ClangdLanguageClient|undefined;
    const didOpenTasks = new Map<string, Promise<void>>();
    const cmakeTools = new CMakeTools(undefined, folder!);
    await cmakeTools.init();
    subscriptions.push(cmakeTools);

    const waitForDidOpen = async (document: vscode.TextDocument) => {
      const task = didOpenTasks.get(document.uri.toString());
      if (task) {
        await task.catch(() => {});
      }
    };

    const clientOptions: vscodelc.LanguageClientOptions = {
      // Register the server for c-family and cuda files.
      documentSelector: clangdDocumentSelector,
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: await config.get<string[]>('fallbackFlags')
      },
      synchronize: {
        fileEvents: vscode.workspace.createFileSystemWatcher(
            '**/{.clangd,.clang-tidy,compile_flags.txt}')
      },
      outputChannel: outputChannel,
      // Do not switch to output window when clangd returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

      // We hack up the completion items a bit to prevent VSCode from re-ranking
      // and throwing away all our delicious signals like type information.
      //
      // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
      // By adding the prefix to the beginning of the filterText, we get a
      // perfect
      // fuzzymatch score for every item.
      // The sortText (which reflects clangd ranking) breaks the tie.
      // This also prevents VSCode from filtering out any results due to the
      // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
      // fixes in completion.
      //
      // We also mark the list as incomplete to force retrieving new rankings.
      // See https://github.com/microsoft/language-server-protocol/issues/898
      middleware: {
        didOpen: async (document, next) => {
          const uri = document.uri.toString();
          const task = (async () => {
            await ClangdContext.seedCompileCommandBeforeDidOpen(
                document, client, outputChannel, cmakeTools);
            await next(document);
          })();
          didOpenTasks.set(uri, task);
          try {
            await task;
          } finally {
            didOpenTasks.delete(uri);
          }
        },
        provideDocumentLinks: async (document, token, next) => {
          // clangd needs didOpen before AST-backed document-link requests.
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return [];
          return next(document, token);
        },
        provideDocumentSymbols: async (document, token, next) => {
          // didOpen is delayed while we seed the compile command.
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return [];
          return next(document, token);
        },
        provideCodeActions: async (document, range, context, token, next) => {
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return [];
          return next(document, range, context, token);
        },
        provideFoldingRanges: async (document, context, token, next) => {
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return [];
          return next(document, context, token);
        },
        provideInlayHints: async (document, viewPort, token, next) => {
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return [];
          return next(document, viewPort, token);
        },
        provideDocumentSemanticTokens: async (document, token, next) => {
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return null;
          return next(document, token);
        },
        provideDocumentSemanticTokensEdits:
            async (document, previousResultId, token, next) => {
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return null;
          return next(document, previousResultId, token);
        },
        provideCompletionItem: async (document, position, context, token,
                                      next) => {
          if (!await config.get<boolean>('enableCodeCompletion'))
            return new vscode.CompletionList([], /*isIncomplete=*/ false);
          await waitForDidOpen(document);
          if (token.isCancellationRequested)
            return new vscode.CompletionList([], /*isIncomplete=*/ false);
          let list = await next(document, position, context, token);
          if (!await config.get<boolean>('serverCompletionRanking'))
            return list;
          let items = (!list ? [] : Array.isArray(list) ? list : list.items);
          items = items.map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            // item.range is either a Range or {inserting, replacing} (see
            // CompletionItem in the VS Code API); narrow before using.
            let prefix = '';
            if (item.range) {
              const start = item.range instanceof vscode.Range
                                ? item.range.start
                                : item.range.inserting.start;
              prefix = document.getText(new vscode.Range(start, position));
            }
            if (prefix)
              item.filterText = prefix + '_' + item.filterText;
            // Workaround for https://github.com/clangd/vscode-clangd/issues/357
            // clangd's used of commit-characters was well-intentioned, but
            // overall UX is poor. Due to vscode-languageclient bugs, we didn't
            // notice until the behavior was in several releases, so we need
            // to override it on the client.
            item.commitCharacters = [];
            // VSCode won't automatically trigger signature help when entering
            // a placeholder, e.g. if the completion inserted brackets and
            // placed the cursor inside them.
            // https://github.com/microsoft/vscode/issues/164310
            // They say a plugin should trigger this, but LSP has no mechanism.
            // https://github.com/microsoft/language-server-protocol/issues/274
            // (This workaround is incomplete, and only helps the first param).
            if (item.insertText instanceof vscode.SnippetString &&
                !item.command &&
                item.insertText.value.match(/[([{<,] ?\$\{?[01]\D/))
              item.command = {
                title: 'Signature help',
                command: 'editor.action.triggerParameterHints'
              };
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
        provideHover: async (document, position, token, next) => {
          if (!await config.get<boolean>('enableHover'))
            return null;
          return next(document, position, token);
        },
        // VSCode applies fuzzy match only on the symbol name, thus it throws
        // away all results if query token is a prefix qualified name.
        // By adding the containerName to the symbol name, it prevents VSCode
        // from filtering out any results, e.g. enable workspaceSymbols for
        // qualified symbols.
        provideWorkspaceSymbols: async (query, token, next) => {
          let symbols = await next(query, token);
          return symbols?.map(symbol => {
            // Only make this adjustment if the query is in fact qualified.
            // Otherwise, we get a suboptimal ordering of results because
            // including the name's qualifier (if it has one) in symbol.name
            // means vscode can no longer tell apart exact matches from
            // partial matches.
            if (query.includes('::')) {
              if (symbol.containerName)
                symbol.name = `${symbol.containerName}::${symbol.name}`;
              // results from clangd strip the leading '::', so vscode fuzzy
              // match will filter out all results unless we add prefix back in
              if (query.startsWith('::')) {
                symbol.name = `::${symbol.name}`;
              }
              // Clean the containerName to avoid displaying it twice.
              symbol.containerName = '';
            }
            return symbol;
          })
        },
      },
    };

    // Seed open-document compile commands during initialize.
    // CMakeCompileCommands activates only after client.start(), so it cannot
    // prevent the first didOpen from falling back when no on-disk CDB exists.
    await ClangdContext.setCompilationDatabaseOptions(
        clientOptions, outputChannel, cmakeTools);

    client =
        new ClangdLanguageClient('Kylin Clangd', serverOptions, clientOptions);
    client.clientOptions.errorHandler = client.createDefaultErrorHandler(
        // max restart count
        await config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    client.registerFeature(new EnableEditsNearCursorFeature);

    return client;
  }

  private static async seedCompileCommandBeforeDidOpen(
      document: vscode.TextDocument, client: ClangdLanguageClient|undefined,
      outputChannel: vscode.OutputChannel,
      cmakeTools: CMakeTools): Promise<void> {
    if (!client || !isClangdDocument(document)) {
      return;
    }

    const project = await cmakeTools.getProject(document.uri);
    if (!project?.getCompileCommand) {
      return;
    }

    if (await projectHasAvailableCompilationDatabase(project)) {
      return;
    }

    const command = await project.getCompileCommand(document.uri);
    if (!command) {
      logMissingCMakeCompileCommand(
          outputChannel, 'pre-did-open', document.uri,
          'cmake-tools returned undefined');
      return;
    }

    if (!compileCommandNeedsSend(command) ||
        !markCompileCommandSent(command)) {
      return;
    }

    logCMakeCompileCommand(outputChannel, 'pre-did-open', command);
    client.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        compilationDatabaseChanges: {
          [command.uri.fsPath]: {
            workingDirectory: command.workingDirectory,
            compilationCommand: command.compilationCommand,
          },
        },
      },
    });
  }

  private static async setCompilationDatabaseOptions(
      clientOptions: vscodelc.LanguageClientOptions,
      outputChannel: vscode.OutputChannel, cmakeTools: CMakeTools) {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    if (cmakeTools.cmakeProject &&
        await projectHasAvailableCompilationDatabase(
            cmakeTools.cmakeProject) &&
        cmakeTools.buildDirectory) {
      clientOptions.initializationOptions.compilationDatabasePath =
          cmakeTools.buildDirectory;
      // Prefer clangd's native CDB handling when CMake generated a valid one.
      return;
    }

    if (cmakeTools.cmakeProject?.getCompileCommand) {
      const commands =
          await ClangdContext.getOpenDocumentCompileCommands(
              cmakeTools, outputChannel);
      if (commands.length > 0) {
        logCMakeCompileCommands(
            outputChannel, 'initialize-open-documents', commands);
        commands.forEach((command) => markCompileCommandSent(command));
        // clangd overlays per-file commands on top of the directory-based
        // CDB, so explicit changes win and compilationDatabasePath still
        // serves as a fallback for files we have not pushed yet.
        clientOptions.initializationOptions.compilationDatabaseChanges =
            Object.fromEntries(commands.map((command) => [
              command.uri.fsPath,
              {
                workingDirectory: command.workingDirectory,
                compilationCommand: command.compilationCommand,
              }
            ]));
      }
    }

    if (cmakeTools.buildDirectory) {
      // CMake handled this workspace; avoid falling through to qmake.
      return;
    }

    // on linux, try qmake-tools extension if available
    if (process.platform === 'linux') {
      let qmakeTools: QMakeTools|undefined;
      const cmakeFiles =
          await vscode.workspace.findFiles('CMakeLists.txt', undefined, 1);
      const proFiles = await vscode.workspace.findFiles('*.pro', undefined, 1);
      if (cmakeFiles.length === 0 && proFiles.length > 0) {
        qmakeTools = new QMakeTools(extContext!);
        await qmakeTools.init();

        if (qmakeTools.buildDirectory) {
          clientOptions.initializationOptions.compilationDatabasePath =
              qmakeTools.buildDirectory;
        }
      }
    }
  }

  private static async getOpenDocumentCompileCommands(
      cmakeTools: CMakeTools,
      outputChannel: vscode.OutputChannel): Promise<ResolvedCompileCommand[]> {
    const commandsByFile = new Map<string, ResolvedCompileCommand>();
    const documents = vscode.workspace.textDocuments.filter(
        (document) => isClangdDocument(document));

    await Promise.all(documents.map(async (document) => {
      const project = await cmakeTools.getProject(document.uri);
      if (!project?.getCompileCommand) {
        return;
      }

      if (await projectHasAvailableCompilationDatabase(project)) {
        return;
      }

      const command = await project.getCompileCommand(document.uri);
      if (command) {
        commandsByFile.set(command.uri.fsPath, command);
      } else {
        logMissingCMakeCompileCommand(
            outputChannel, 'initialize-open-documents', document.uri,
            'cmake-tools returned undefined');
      }
    }));

    return [...commandsByFile.values()];
  }

  private constructor(subscriptions: vscode.Disposable[],
                      client: ClangdLanguageClient) {
    this.subscriptions = subscriptions;
    this.client = client;

    this.startClient();
  }

  async startClient() {
    typeHierarchy.activate(this);
    inlayHints.activate(this);
    memoryUsage.activate(this);
    ast.activate(this);
    openConfig.activate(this);
    inactiveRegions.activate(this);
    await configFileWatcher.activate(this);
    await overrideMethods.activate(this);
    await this.client.start();
    const cmakeCompileCommands =
        new CMakeCompileCommands(this.client, this.client.outputChannel, this.workspaceFolder);
    this.subscriptions.push(cmakeCompileCommands);
    await cmakeCompileCommands.activate();
    console.log('Clang Language Server is now active!');
    fileStatus.activate(this);
    switchSourceHeader.activate(this);
    symbolInfo.activate(this);
  }

  get visibleClangdEditors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
        (e) => isClangdDocument(e.document));
  }

  clientIsStarting() {
    return this.client && this.client.state == vscodelc.State.Starting;
  }

  clientIsRunning() {
    return this.client && this.client.state == vscodelc.State.Running;
  }

  static async getClangdArgs(): Promise<string[]> {
    const args = await config.get<string[]>('arguments');

    if (!args.some(arg => arg.startsWith('--header-insertion'))) {
      const headerInsertion = await config.get<string>('headerInsertion');
      if (headerInsertion === 'never') {
        args.push('--header-insertion=never');
      }
    }

    if (!args.some(arg => arg.startsWith('--clang-tidy'))) {
      const clangTidyArgs: number =
          await config.get<boolean>('enableClangTidyDiagnostic') ? 1 : 0;
      args.push(`--clang-tidy=${clangTidyArgs}`);
    }

    return args;
  }

  dispose() {
    this.subscriptions.forEach((d) => { d.dispose(); });
    if (this.client)
      this.client.stop();
    this.subscriptions = []
  }
}
