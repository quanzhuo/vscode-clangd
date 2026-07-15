import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode';

import {ClangdContext} from './clangd-context';

/**
 * @returns The path that corresponds to llvm::sys::path::user_config_directory.
 */
function getUserConfigDirectory(): string|undefined {
  switch (os.platform()) {
  case 'win32':
    if (process.env.LocalAppData)
      return process.env.LocalAppData;
    break;
  case 'darwin':
    if (process.env.HOME)
      return path.join(process.env.HOME, 'Library', 'Preferences');
    break;
  default:
    if (process.env.XDG_CONFIG_HOME)
      return process.env.XDG_CONFIG_HOME;
    if (process.env.HOME)
      return path.join(process.env.HOME, '.config');
    break;
  }
  return undefined;
}

function getUserConfigFile(): string|undefined {
  const dir = getUserConfigDirectory();
  if (!dir)
    return undefined;
  return path.join(dir, 'clangd', 'config.yaml');
}

async function openConfigFile(path: vscode.Uri) {
  let p = path;
  try {
    await vscode.workspace.fs.stat(path);
  } catch {
    // File doesn't exist, create a scratch file.
    p = path.with({scheme: 'untitled'});
  }
  vscode.workspace.openTextDocument(p).then((a => {
    vscode.languages.setTextDocumentLanguage(a, 'yaml');
    vscode.window.showTextDocument(a);
  }));
}

export function activate(context: ClangdContext) {
  // Create a command to open the project root .clangd configuration file.
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.projectConfig', async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
          vscode.window.showErrorMessage(
              vscode.l10n.t('No project is open.'));
          return;
        }

        // Try to get the workspace folder of the active text editor
        const activeEditor = vscode.window.activeTextEditor;
        let targetFolder: vscode.WorkspaceFolder | undefined;
        
        if (activeEditor) {
          targetFolder = vscode.workspace.getWorkspaceFolder(
              activeEditor.document.uri);
        }
        
        // If no active editor or editor is not in a workspace folder,
        // and we have multiple folders, let user choose
        if (!targetFolder && folders.length > 1) {
          const items = folders.map(f => ({
            label: f.name,
            description: f.uri.fsPath,
            folder: f
          }));
          
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select workspace folder for .clangd config')
          });
          
          if (!selected) {
            return; // User cancelled
          }
          targetFolder = selected.folder;
        }
        
        // Fallback to first folder if still not set
        if (!targetFolder) {
          targetFolder = folders[0];
        }
        
        openConfigFile(vscode.Uri.joinPath(targetFolder.uri, '.clangd'));
      }));

  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.userConfig', () => {
        const file = getUserConfigFile();
        if (file) {
          openConfigFile(vscode.Uri.file(file));
        } else {
          vscode.window.showErrorMessage(
              vscode.l10n.t("Couldn't get global configuration directory"));
        }
      }));
}
