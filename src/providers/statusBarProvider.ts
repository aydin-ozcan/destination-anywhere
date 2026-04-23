/**
 * Status bar item showing the current Cloud Foundry connection state.
 * Always visible at the bottom. Clicking focuses the Destination Anywhere sidebar.
 */

import * as vscode from 'vscode';
import { isCfCliInstalled, isCfLoggedIn, getCfApiInfo } from '../destination/cfCliAuth';

export class StatusBarProvider {
  private readonly item: vscode.StatusBarItem;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'destinationAnywhere.focusSidebar';
    context.subscriptions.push(this.item);
    this.item.show();
    this.update();

    // Refresh every 5 minutes to catch login/logout
    this.refreshTimer = setInterval(() => this.update(), 300_000);
    context.subscriptions.push({
      dispose: () => {
        if (this.refreshTimer) { clearInterval(this.refreshTimer); }
      },
    });
  }

  async update(): Promise<void> {
    try {
      if (!(await isCfCliInstalled())) {
        this.item.text = '$(error) Destination Anywhere: CF CLI not found';
        this.item.tooltip = 'CF CLI is not installed. Click to open the Destination Anywhere panel.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        return;
      }
      if (!(await isCfLoggedIn())) {
        this.item.text = '$(warning) Destination Anywhere: CF not logged in';
        this.item.tooltip = 'Not logged in to Cloud Foundry. Click to open the Destination Anywhere panel.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
      }
      const info = await getCfApiInfo();
      this.item.text = `$(check) Destination Anywhere: ${info.space}`;
      this.item.tooltip = `Connected to ${info.apiEndpoint}\nOrg: ${info.org} › Space: ${info.space}\nClick to open the Destination Anywhere panel.`;
      this.item.backgroundColor = undefined;
    } catch {
      this.item.text = '$(warning) Destination Anywhere';
      this.item.backgroundColor = undefined;
    }
  }
}
