import * as vscode from 'vscode';
import { HttpMethod } from '../parser/types';

const HTTP_METHODS: HttpMethod[] = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
];

const COMMON_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Cache-Control',
  'User-Agent',
  'Accept-Encoding',
  'Accept-Language',
  'Connection',
  'Host',
  'If-None-Match',
  'If-Modified-Since',
  'Cookie',
  'Referer',
  'Origin',
  'X-Requested-With',
  'X-Forwarded-For',
  'X-CSRF-Token',
];

const CONTENT_TYPE_VALUES = [
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
  'application/octet-stream',
  'application/pdf',
  'text/plain',
  'text/html',
  'text/xml',
  'text/csv',
  'multipart/form-data',
];

const HEADER_LINE_RE = /^([\w-]+)\s*:\s*/;

class DestinationAnywhereCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character);

    // Content-Type value completions
    const contentTypeMatch = /^Content-Type\s*:\s*/i.exec(prefix);
    if (contentTypeMatch) {
      return CONTENT_TYPE_VALUES.map((value) => {
        const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
        item.detail = 'Content-Type value';
        return item;
      });
    }

    // Header name completions: cursor is on an empty line or a line that
    // looks like the start of a header (letters/dashes only, no colon yet)
    // but not a request line (doesn't start with an HTTP method).
    if (HEADER_LINE_RE.test(prefix) === false && this.isHeaderPosition(document, position)) {
      return COMMON_HEADERS.map((header) => {
        const item = new vscode.CompletionItem(header, vscode.CompletionItemKind.Field);
        item.insertText = new vscode.SnippetString(`${header}: $0`);
        item.detail = 'HTTP header';
        return item;
      });
    }

    // HTTP method completions at the start of a line
    if (this.isMethodPosition(prefix)) {
      return [
        ...HTTP_METHODS.map((method) => {
          const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Keyword);
          item.insertText = new vscode.SnippetString(`${method} $0`);
          item.detail = 'HTTP method';
          return item;
        }),
        this.createDestUrlItem(),
        this.createMdkUrlItem(),
      ];
    }

    // dest:// or mdk:// prefix when typing a URL (after an HTTP method)
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S*$/i.test(prefix)) {
      return [this.createDestUrlItem(), this.createMdkUrlItem()];
    }

    return undefined;
  }

  private createDestUrlItem(): vscode.CompletionItem {
    const item = new vscode.CompletionItem('dest://', vscode.CompletionItemKind.Value);
    item.insertText = new vscode.SnippetString('dest://${1:destinationName}/${0:path}');
    item.detail = 'SAP BTP Destination URL';
    item.documentation = new vscode.MarkdownString(
      'Insert a `dest://` URL targeting an SAP BTP destination.',
    );
    return item;
  }

  private createMdkUrlItem(): vscode.CompletionItem {
    const item = new vscode.CompletionItem('mdk://', vscode.CompletionItemKind.Value);
    item.insertText = new vscode.SnippetString('mdk://${1:AppId}/${2:DestinationName}/${0:path}');
    item.detail = 'SAP Mobile Services Destination URL';
    item.documentation = new vscode.MarkdownString(
      'Insert an `mdk://` URL routing through SAP Mobile Services.\n\n' +
      'Format: `mdk://AppId/DestinationName/path`',
    );
    return item;
  }

  /** Returns true when the cursor is at the very start of a line (method position). */
  private isMethodPosition(prefix: string): boolean {
    return /^\s*[A-Z]*$/i.test(prefix);
  }

  /**
   * Returns true when the cursor is in a header region: after the request
   * line but before the body (blank-line separator).
   */
  private isHeaderPosition(document: vscode.TextDocument, position: vscode.Position): boolean {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character);

    // Only trigger when the line looks like a partial header name
    if (!/^[\w-]*$/.test(prefix.trim())) {
      return false;
    }

    // Walk backwards to find the request line; bail if we hit a blank line first
    for (let i = position.line - 1; i >= 0; i--) {
      const text = document.lineAt(i).text;
      if (text.trim() === '') {
        return false; // blank line means we're in the body
      }
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.test(text.trim())) {
        return true;
      }
    }
    return false;
  }
}

export function createCompletionProvider(): vscode.CompletionItemProvider {
  return new DestinationAnywhereCompletionProvider();
}
