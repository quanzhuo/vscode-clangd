import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DeclarationRequest,
  RequestType,
  TextDocumentPositionParams
} from 'vscode-languageclient/node';
import {Location} from 'vscode-languageserver-types';

import {ClangdContext} from './clangd-context';
import {extContext} from './extension';

/**
 * https://clangd.llvm.org/extensions#symbol-info-request
 *
 * This attempts to resolve the symbol under the cursor, without retrieving
 * further information (like definition location, which may require consulting
 * an index).
 *
 * name: the unqualified name of the symbol.
 * containerName: the enclosing namespace, class etc(without trailing ::)
 * usr: the clang-specific "unified symbol resolution" identifier
 * id: the clangd-specific opaque symbol ID
 */
interface SymbolInfo {
  name: string;
  containerName: string;
  usr: string;
  id: string|null;
}
interface SymbolDetails extends SymbolInfo {
  header?: string;
}

interface DocumentationProvider {
  /**
   * The extension ID of the documentation provider.
   */
  extensionId: string;

  /**
   * The base path of the include directories. eg: ['/usr/include/kysdk']
   */
  baseIncludePathes: string[];

  /**
   * The command provided by the extensionId to show documentation.
   */
  command: string;
}

namespace SymbolInfoRequest {
export const type =
    new RequestType<TextDocumentPositionParams, string|undefined, void>(
        'textDocument/symbolInfo');
}

export async function activate(context: ClangdContext) {
  context.subscriptions.push(
      vscode.commands.registerCommand(
          'clangd.showDocumentation',
          async () => { await showDocumentation(context); }),
      vscode.commands.registerCommand(
          'clangd.registerDocumentationProvider',
          async (provider: DocumentationProvider) => {
            await registerDocumentationProvider(extContext!, provider);
          }),
  );
}

async function getSymbolDetails(context: ClangdContext):
    Promise<SymbolDetails|undefined> {
  const activateEditor = vscode.window.activeTextEditor;
  if (!activateEditor) {
    console.debug('showDocumentation: No active editor');
    return;
  }

  const languageIds = new Set<string>(['c', 'cpp']);
  if (!languageIds.has(activateEditor.document.languageId)) {
    console.debug('showDocumentation: Not a C/C++ file');
    return;
  }

  const curPos: vscode.Position = activateEditor.selection.active,
                line = activateEditor.document.lineAt(curPos);
  if (line.text.trim().length === 0) {
    console.debug('showDocumentation: Empty line');
    return;
  }

  const uri = vscode.Uri.file(activateEditor.document.fileName);
  const pos = {
    textDocument: {
      uri: uri.toString(),
    },
    position: curPos,
  };

  const symbolInfos: SymbolInfo[] =
      (await context.client.sendRequest(SymbolInfoRequest.type, pos)) as
      unknown as SymbolInfo[];
  if (symbolInfos.length === 0) {
    console.log(`No symbol info found for ${
        JSON.stringify(pos)}, clangd returned: ${JSON.stringify(symbolInfos)}`);
    return;
  }
  const locations: Location[] =
      (await context.client.sendRequest(DeclarationRequest.type, pos)) as
      unknown as Location[];
  const ret: SymbolDetails = {
    ...symbolInfos[0],
  };
  if (locations.length > 0) {
    ret.header = vscode.Uri.parse(locations[0].uri).fsPath;
  }
  return ret;
}

function getUnixStylePath(pathString: string): string {
  pathString = path.normalize(pathString);
  if (os.platform() === 'win32') {
    const segments = pathString.toLowerCase().split(path.sep);
    return segments.join('/');
  }
  return pathString;
}

async function showDocumentation(context: ClangdContext) {
  const details = await getSymbolDetails(context);
  console.log(`showDocumentation, getSymbolDetails returned: ${
      JSON.stringify(details)}`);
  if (!details || !details.header) {
    return;
  }

  const providers = extContext!.globalState.get<DocumentationProvider[]>(
                        'clangd.documentationProviders') ||
                    [];
  const provider = providers.find((p) => {
    return p.baseIncludePathes.some((basePath) => {
      basePath = getUnixStylePath(basePath);
      if (!details.header) {
        return false;
      }
      const header = getUnixStylePath(details.header);
      return header.startsWith(basePath);
    });
  });
  if (provider) {
    const extension = vscode.extensions.getExtension(provider.extensionId);
    if (!extension) {
      vscode.window.showErrorMessage(
          vscode.l10n.t('Extension {0} not found', provider.extensionId));
      return;
    }
    vscode.commands.executeCommand(provider.command, details);
    return;
  }

  // fallback to kylin sdk documentation viewer
  const docViewer = vscode.extensions.getExtension('KylinIdeTeam.doc-viewer');
  if (docViewer) {
    vscode.commands.executeCommand('doc-viewer.showDocumentation', details);
  }
}

async function registerDocumentationProvider(context: vscode.ExtensionContext,
                                             provider: DocumentationProvider) {
  // context.globalState.setKeysForSync([]);
  let providers = context.globalState.get<DocumentationProvider[]>(
                      'clangd.documentationProviders') ||
                  [];
  providers = providers.filter((p) => p.extensionId !== provider.extensionId);
  providers.push(provider);
  await context.globalState.update('clangd.documentationProviders', providers);
}
