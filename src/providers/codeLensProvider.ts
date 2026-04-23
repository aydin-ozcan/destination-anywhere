import * as vscode from 'vscode';
import { parseHttpFile } from '../parser/httpFileParser';
import { RequestBlock } from '../parser/types';

class DestinationAnywhereCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const blocks = parseHttpFile(document.getText());
    return blocks.map((block) => this.createCodeLens(block));
  }

  private createCodeLens(block: RequestBlock): vscode.CodeLens {
    const range = new vscode.Range(block.startLine, 0, block.startLine, 0);
    const title = block.name
      ? `▶ Send Request - ${block.name}`
      : '▶ Send Request';

    return new vscode.CodeLens(range, {
      title,
      command: 'destinationAnywhere.sendRequest',
      arguments: [block],
    });
  }
}

export function createCodeLensProvider(): vscode.CodeLensProvider {
  return new DestinationAnywhereCodeLensProvider();
}
