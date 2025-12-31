import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  TextDocument as LSTextDocument
} from 'vscode-languageserver-textdocument';
import {MarkupContent} from 'vscode-languageserver-types';
import {getLanguageService} from 'yaml-language-server';

// Define the file patterns we want to support
const SUPPORTED_FILES = [
  {pattern: '**/.clangd', schemaUri: 'internal://schemas/clangd.json'},
  {pattern: '**/.clang-tidy', schemaUri: 'internal://schemas/clang-tidy.json'},
  {
    pattern: '**/.clang-format',
    schemaUri: 'internal://schemas/clang-format.json'
  }
];

export function activateYamlSupport(context: vscode.ExtensionContext) {
  // 1. Initialize the YAML Language Service
  const yamlService = getLanguageService({
    schemaRequestService: async (uri) => {
      // Handle internal schemas
      if (uri.startsWith('internal://schemas/')) {
        const schemaName = uri.replace('internal://schemas/', '');
        const schemaPath =
            path.join(context.extensionPath, 'res', 'schemas', schemaName);
        try {
          const content = fs.readFileSync(schemaPath, 'utf8');
          return content;
        } catch (e) {
          return '';
        }
      }

      // Handle base.json redirection
      if (uri === 'https://json.schemastore.org/base.json' ||
          uri === 'http://json.schemastore.org/base.json') {
        const schemaPath =
            path.join(context.extensionPath, 'res', 'schemas', 'base.json');
        try {
          const content = fs.readFileSync(schemaPath, 'utf8');
          return content;
        } catch (e) {
          return '';
        }
      }

      // Fallback for other http requests
      if (uri.startsWith('http')) {
        try {
          const response = await fetch(uri);
          return await response.text();
        } catch (e) {
          return '';
        }
      }
      return '';
    },
    workspaceContext: {
      resolveRelativePath:
          (relativePath,
           resource) => { return vscode.Uri.file(relativePath).toString(); }
    }
  });

  // 2. Configure Schemas
  const schemas = SUPPORTED_FILES.map(
      item => ({uri: item.schemaUri, fileMatch: [item.pattern]}));

  yamlService.configure(
      {schemas: schemas, validate: true, hover: true, completion: true});

  // 3. Register Providers
  // Use language selector 'yaml' for these files as we registered them in
  // package.json But also keep pattern to be safe if language detection fails
  // or user overrides it
  const selector: vscode.DocumentSelector = [
    {language: 'yaml', pattern: '**/.clangd'},
    {language: 'yaml', pattern: '**/.clang-tidy'},
    {language: 'yaml', pattern: '**/.clang-format'},
    // Fallback patterns
    {pattern: '**/.clangd'}, {pattern: '**/.clang-tidy'},
    {pattern: '**/.clang-format'}
  ];

  // Helper to convert VS Code document to LS document
  const getLSDocument = (document: vscode.TextDocument): LSTextDocument => {
    return LSTextDocument.create(
        document.uri.toString(),
        'yaml', // Force languageId to yaml for the service
        document.version, document.getText());
  };

  // Completion Provider
  context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems: async (document, position) => {
          const lsDoc = getLSDocument(document);
          const lsPos = {line: position.line, character: position.character};
          const list = await yamlService.doComplete(lsDoc, lsPos, false);

          // Convert LS CompletionList to VS Code CompletionItems
          return list.items
              .filter(item => {
                // Filter out unwanted snippets that might be returned by the LS
                // or merged from other sources "bold", "heading", etc. are
                // typically Markdown snippets. Although we are filtering what
                // WE return, this helps if LS returns them. If they come from
                // VS Code, this filter won't help, but setting language to YAML
                // in package.json should fix that.
                if (item.kind ===
                    15 /* Snippet */) { // CompletionItemKind.Snippet
                  const label = item.label;
                  if ([
                        'bold', 'italic', 'heading', 'code', 'fenced codeblock',
                        'fenced math', 'inline math'
                      ].includes(label)) {
                    return false;
                  }
                }
                return true;
              })
              .map(item => {
                const vscodeItem = new vscode.CompletionItem(item.label);
                if (item.documentation) {
                  if (typeof item.documentation === 'string') {
                    vscodeItem.documentation = item.documentation;
                  } else if (MarkupContent.is(item.documentation)) {
                    vscodeItem.documentation =
                        new vscode.MarkdownString(item.documentation.value);
                  }
                }
                vscodeItem.detail = item.detail;
                vscodeItem.kind = item.kind as any; // Map kinds if necessary
                vscodeItem.insertText = item.insertText;
                // Handle edits, snippets etc.
                return vscodeItem;
              });
        }
      }));

  // Hover Provider
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    provideHover: async (document, position) => {
      const lsDoc = getLSDocument(document);
      const lsPos = {line: position.line, character: position.character};

      const hover = await yamlService.doHover(lsDoc, lsPos);
      if (!hover) {
        return null;
      }

      // Convert LS Hover to VS Code Hover
      let contents: vscode.MarkdownString|vscode.MarkdownString[];

      if (MarkupContent.is(hover.contents)) {
        contents = new vscode.MarkdownString(hover.contents.value);
      } else if (Array.isArray(hover.contents)) {
        contents = hover.contents.map(c => {
          if (typeof c === 'string')
            return new vscode.MarkdownString(c);
          return new vscode.MarkdownString(
              `\`\`\`${c.language}\n${c.value}\n\`\`\``);
        });
      } else if (typeof hover.contents === 'string') {
        contents = new vscode.MarkdownString(hover.contents);
      } else {
        // MarkedString object { language, value }
        contents = new vscode.MarkdownString(`\`\`\`${
            hover.contents.language}\n${hover.contents.value}\n\`\`\``);
      }

      const range = hover.range ? new vscode.Range(hover.range.start.line,
                                                   hover.range.start.character,
                                                   hover.range.end.line,
                                                   hover.range.end.character)
                                : undefined;

      return new vscode.Hover(contents, range);
    }
  }));

  // Validation (Diagnostics)
  const diagnosticCollection =
      vscode.languages.createDiagnosticCollection('clangd-yaml');
  context.subscriptions.push(diagnosticCollection);

  const validate = async (document: vscode.TextDocument) => {
    if (!SUPPORTED_FILES.some(
            f => vscode.languages.match({pattern: f.pattern}, document))) {
      return;
    }
    const lsDoc = getLSDocument(document);
    const diagnostics = await yamlService.doValidation(lsDoc, false);

    // Convert LS Diagnostics to VS Code Diagnostics
    const vscodeDiagnostics = diagnostics.map(d => {
      const range =
          new vscode.Range(d.range.start.line, d.range.start.character,
                           d.range.end.line, d.range.end.character);
      const severity = d.severity === 1 ? vscode.DiagnosticSeverity.Error
                                        : vscode.DiagnosticSeverity.Warning;
      return new vscode.Diagnostic(range, d.message, severity);
    });
    diagnosticCollection.set(document.uri, vscodeDiagnostics);
  };

  context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(validate),
      vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
      vscode.workspace.onDidSaveTextDocument(validate));

  // Validate open documents
  vscode.workspace.textDocuments.forEach(validate);
}
