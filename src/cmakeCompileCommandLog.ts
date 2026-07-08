import * as vscode from 'vscode';

import {ResolvedCompileCommand} from './cmakeToolsApi';

export function logCMakeCompileCommand(
    outputChannel: vscode.OutputChannel, phase: string,
    command: ResolvedCompileCommand): void {
  outputChannel.appendLine(
      `cmake-compile-command: phase=${phase} file=${command.uri.fsPath} ` +
      `source=${command.sourceUri.fsPath} inferred=${command.inferred} ` +
      `language=${command.language ?? '<none>'} ` +
      `target=${command.targetName ?? '<none>'} ` +
      `config=${command.configurationName ?? '<none>'} ` +
      `cwd=${command.workingDirectory} ` +
      `argv=${JSON.stringify(command.compilationCommand)}`);
}

export function logCMakeCompileCommands(
    outputChannel: vscode.OutputChannel, phase: string,
    commands: ResolvedCompileCommand[]): void {
  outputChannel.appendLine(
      `cmake-compile-command: phase=${phase} count=${commands.length}`);
  for (const command of commands) {
    logCMakeCompileCommand(outputChannel, phase, command);
  }
}

export function logMissingCMakeCompileCommand(
    outputChannel: vscode.OutputChannel, phase: string, uri: vscode.Uri,
    reason: string): void {
  outputChannel.appendLine(
      `cmake-compile-command: phase=${phase} file=${uri.fsPath} ` +
      `missing=true reason=${reason}`);
}
