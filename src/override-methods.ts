import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext} from './clangd-context';

const t = vscode.l10n.t;

// Clangd extension capabilities.
interface ClangdServerCapabilities {
  overrideMethodsProvider?: boolean;
}

interface OverridableMethod {
  id: string; // USR
  signature: string;
  isPureVirtual: boolean;
  fromClass: string;
  accessSpecifier: string;
}

interface GetOverridableMethodsResult {
  methods: OverridableMethod[];
  insertPosition: vscode.Position;
  targetClass: string;
}

// Custom LSP request types (cleaner than workspace/executeCommand)
namespace ListOverridableMethodsRequest {
export const type =
    new vscodelc.RequestType<vscodelc.TextDocumentPositionParams,
                             GetOverridableMethodsResult, void>(
        'clangd/listOverridableMethods');
}

interface AddOverridableMethodsParams {
  textDocument: vscodelc.TextDocumentIdentifier;
  position: vscode.Position;
  methodIds: string[];
}

namespace AddOverridableMethodsRequest {
export const type =
    new vscodelc
        .RequestType<AddOverridableMethodsParams, vscodelc.WorkspaceEdit, void>(
            'clangd/addOverridableMethods');
}

class OverrideMethodsFeature implements vscodelc.StaticFeature {
  constructor(private context: ClangdContext) {}

  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities) {
    // No client capabilities to fill
  }

  async initialize(capabilities: vscodelc.ServerCapabilities,
                   _documentSelector: vscodelc.DocumentSelector|undefined) {
    const serverCaps = capabilities as ClangdServerCapabilities;
    if (!serverCaps.overrideMethodsProvider) {
      // Server doesn't support override methods feature
      return;
    }

    // Register the command handler (dynamically, only if server supports it)
    this.context.subscriptions.push(vscode.commands.registerCommand(
        'clangd.overrideMethods',
        async (params?: vscodelc.CodeActionParams) => {
          await this.handleOverrideMethods(params);
        }));
  }

  private async handleOverrideMethods(params?: vscodelc.CodeActionParams) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const position = params?.range.start || editor.selection.active;

    try {
      // 1. Get overridable methods from clangd (using custom LSP request)
      const result: GetOverridableMethodsResult =
          await this.context.client.sendRequest(
              ListOverridableMethodsRequest.type, {
                textDocument:
                    {uri: params?.textDocument.uri || document.uri.toString()},
                position: position
              });

      if (!result.methods || result.methods.length === 0) {
        vscode.window.showInformationMessage(
            t('No overridable methods available at this position.'));
        return;
      }

      // 2. Show QuickPick to let user select methods
      interface MethodQuickPickItem extends vscode.QuickPickItem {
        method: OverridableMethod;
      }

      const items: MethodQuickPickItem[] = result.methods.map(
          m => ({
            label: m.signature,
            description: m.isPureVirtual ? '[pure virtual]' : '[virtual]',
            detail: `from ${m.fromClass} (${m.accessSpecifier})`,
            picked: m.isPureVirtual, // Pre-select pure virtuals
            method: m
          }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder:
            t('Select methods to override in {0}', result.targetClass),
        ignoreFocusOut: true
      });

      if (!selected || selected.length === 0) {
        return;
      }

      // 3. Call clangd to insert the selected methods (using custom LSP
      // request)
      const methodIds = selected.map(s => s.method.id);

      const edit = await this.context.client.sendRequest(
          AddOverridableMethodsRequest.type, {
            textDocument:
                {uri: params?.textDocument.uri || document.uri.toString()},
            position: result.insertPosition,
            methodIds: methodIds
          });

      // 4. Apply the workspace edit
      const applied = await vscode.workspace.applyEdit(
          await this.context.client.protocol2CodeConverter.asWorkspaceEdit(
              edit));

    } catch (error: any) {
      if (error.code === -32601) {
        // Method not found - server doesn't support the feature
        vscode.window.showWarningMessage(t(
            'Override methods feature requires a newer version of clangd. Please update your clangd executable.'));
      } else {
        // Other error
        const message = error.message || String(error);
        vscode.window.showErrorMessage(
            t('Failed to override methods: {0}', message));
      }
    }
  }

  getState(): vscodelc.FeatureState { return {kind: 'static'}; }

  clear() {}
}

export async function activate(context: ClangdContext) {
  // Use StaticFeature for dynamic registration based on server capability
  context.client.registerFeature(new OverrideMethodsFeature(context));
}
