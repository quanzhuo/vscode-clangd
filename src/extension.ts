import * as vscode from 'vscode';

import {ClangdExtension} from '../api/vscode-clangd';

import {ClangdExtensionImpl} from './api';
import {ClangdContext} from './clangd-context';
import {get, update} from './config';
import {formatWorkspace} from './formatting';
import {activateYamlSupport} from './yaml-support';

let apiInstance: ClangdExtensionImpl|undefined;

/**
 * ExtensionContext should be passed via function arguments, but to make
 * minimal changes to vscode-clangd and facilitate following upstream upgrades,
 * we export extContext here.
 */
export let extContext: vscode.ExtensionContext|undefined;

/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext):
    Promise<ClangdExtension> {
  extContext = context;
  const outputChannel = vscode.window.createOutputChannel('Kylin Clangd');
  context.subscriptions.push(outputChannel);

  let clangdContext: ClangdContext|null = null;

  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.activate', async () => {
        if (clangdContext && (clangdContext.clientIsStarting() ||
                              clangdContext.clientIsRunning())) {
          return;
        }
        vscode.commands.executeCommand('clangd.restart');
      }));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.restart', async () => {
        if (!get<boolean>('enable')) {
          const enable = vscode.l10n.t('Enable');
          const close = vscode.l10n.t('Close');
          vscode.window
              .showInformationMessage(
                  vscode.l10n.t(
                      'Language features from Clangd are currently disabled. Would you like to enable them?'),
                  enable, close)
              .then(async (choice) => {
                if (choice === enable) {
                  await update<boolean>('enable', true);
                  vscode.commands.executeCommand('clangd.restart');
                }
              });
          return;
        }

        // clangd.restart can be called when the extension is not yet activated.
        // In such a case, vscode will activate the extension and then run this
        // handler. Detect this situation and bail out (doing an extra
        // stop/start cycle in this situation is pointless, and doesn't work
        // anyways because the client can't be stop()-ped when it's still in the
        // Starting state).
        if (clangdContext && clangdContext.clientIsStarting()) {
          return;
        }
        if (clangdContext)
          clangdContext.dispose();
        clangdContext = await ClangdContext.create(context.globalStoragePath,
                                                   outputChannel);
        if (clangdContext)
          context.subscriptions.push(clangdContext);
        if (apiInstance) {
          apiInstance.client = clangdContext?.client;
        }
      }));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.shutdown', async () => {
        if (clangdContext && clangdContext.clientIsStarting()) {
          return;
        }
        if (clangdContext)
          clangdContext.dispose();
      }));
  context.subscriptions.push(vscode.commands.registerCommand(
      'clangd.formatWorkspace', () => formatWorkspace(context)));

  let shouldCheck = false;

  if (vscode.workspace.getConfiguration('clangd').get<boolean>('enable')) {
    clangdContext =
        await ClangdContext.create(context.globalStoragePath, outputChannel);
    if (clangdContext)
      context.subscriptions.push(clangdContext);

    shouldCheck = vscode.workspace.getConfiguration('clangd').get<boolean>(
                      'detectExtensionConflicts') ??
                  false;
  }

  if (shouldCheck) {
    const interval = setInterval(function() {
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (cppTools && cppTools.isActive) {
        const cppToolsConfiguration =
            vscode.workspace.getConfiguration('C_Cpp');
        const cppToolsEnabled =
            cppToolsConfiguration.get<string>('intelliSenseEngine');
        if (cppToolsEnabled?.toLowerCase() !== 'disabled') {
          const disableIntelliSense =
            vscode.l10n.t('Disable IntelliSense');
          const neverShow = vscode.l10n.t('Never show this warning');
          vscode.window
            .showWarningMessage(
              vscode.l10n.t(
                "You have both the Microsoft C++ (cpptools) extension and clangd extension enabled. The Microsoft IntelliSense features conflict with clangd's code completion, diagnostics etc."),
              disableIntelliSense, neverShow)
              .then(selection => {
                if (selection == disableIntelliSense) {
                  cppToolsConfiguration.update(
                      'intelliSenseEngine', 'disabled',
                      vscode.ConfigurationTarget.Global);
                } else if (selection == neverShow) {
                  vscode.workspace.getConfiguration('clangd').update(
                      'detectExtensionConflicts', false,
                      vscode.ConfigurationTarget.Global);
                  clearInterval(interval);
                }
              });
        }
      }
    }, 5000);
  }

  activateYamlSupport(context);

  apiInstance = new ClangdExtensionImpl(clangdContext?.client);
  return apiInstance;
}
