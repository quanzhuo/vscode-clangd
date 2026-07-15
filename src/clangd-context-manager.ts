import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext} from './clangd-context';
import {extContext} from './extension';
import * as install from './install';

/**
 * Manages multiple ClangdContext instances for multi-root workspaces.
 * Each workspace folder gets its own ClangdContext and language client.
 */
export class ClangdContextManager implements vscode.Disposable {
  private contexts: Map<string, ClangdContext> = new Map();
  private outputChannel: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private workspaceFolderChangeDisposable: vscode.Disposable | undefined;
  private globalStoragePath: string = '';

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  async initialize(globalStoragePath: string): Promise<void> {
    this.globalStoragePath = globalStoragePath;
    
    // Listen for workspace folder changes
    this.workspaceFolderChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(
      async (event) => {
        // Remove contexts for removed folders
        for (const removed of event.removed) {
          const context = this.contexts.get(removed.uri.toString());
          if (context) {
            context.dispose();
            this.contexts.delete(removed.uri.toString());
          }
        }
        
        // Add contexts for added folders
        for (const added of event.added) {
          await this.createContextForFolder(added);
        }
      }
    );
    this.disposables.push(this.workspaceFolderChangeDisposable!);

    // Create contexts for existing workspace folders
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        await this.createContextForFolder(folder);
      }
    }
  }

  private async createContextForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderUri = folder.uri.toString();
    
    // Skip if context already exists for this folder
    if (this.contexts.has(folderUri)) {
      return;
    }

    const context = await ClangdContext.createForFolder(
      this.globalStoragePath,
      this.outputChannel,
      folder
    );
    
    if (context) {
      this.contexts.set(folderUri, context);
      this.disposables.push(context);
    }
  }

  /**
   * Gets the ClangdContext for a specific document URI.
   * Returns the context associated with the workspace folder containing the document.
   */
  getContextForDocument(document: vscode.TextDocument): ClangdContext | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      // Fallback to first context if document is not in a workspace folder
      const firstContext = this.contexts.values().next().value;
      return firstContext;
    }
    return this.contexts.get(folder.uri.toString());
  }

  /**
   * Gets the ClangdContext for a specific workspace folder.
   */
  getContextForFolder(folder: vscode.WorkspaceFolder): ClangdContext | undefined {
    return this.contexts.get(folder.uri.toString());
  }

  /**
   * Gets all ClangdContext instances.
   */
  getAllContexts(): ClangdContext[] {
    return Array.from(this.contexts.values());
  }

  /**
   * Gets the first (primary) ClangdContext.
   */
  getPrimaryContext(): ClangdContext | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return this.contexts.get(folders[0].uri.toString());
    }
    return this.contexts.values().next().value;
  }

  /**
   * Restarts all ClangdContext instances.
   */
  async restartAll(): Promise<void> {
    // Dispose all existing contexts
    for (const [folderUri, context] of this.contexts) {
      context.dispose();
      this.contexts.delete(folderUri);
    }

    // Recreate contexts for all workspace folders
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        await this.createContextForFolder(folder);
      }
    }
  }

  /**
   * Restarts the ClangdContext for a specific workspace folder.
   */
  async restartFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderUri = folder.uri.toString();
    const existingContext = this.contexts.get(folderUri);
    
    if (existingContext) {
      existingContext.dispose();
      this.contexts.delete(folderUri);
    }

    await this.createContextForFolder(folder);
  }

  /**
   * Shuts down all ClangdContext instances.
   */
  shutdownAll(): void {
    for (const [folderUri, context] of this.contexts) {
      context.dispose();
      this.contexts.delete(folderUri);
    }
  }

  dispose(): void {
    this.shutdownAll();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}