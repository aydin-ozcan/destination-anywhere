import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { parseHttpFile, getRequestBlockAtLine, isDestinationUrl, isMobileServicesUrl } from './parser/httpFileParser';
import { collectVariables, resolveVariables } from './parser/variableResolver';
import { resolveDestinationUrl, clearDestinationCache, getDestinationDetails } from './destination/destinationResolver';
import { clearProxyAppCache, initProxyLogin, uninstallProxyApp } from './destination/proxyApp';
import { resolveMobileServicesUrl, clearMobileServicesCache } from './mobileservices/mobileServicesResolver';
import { initMobileServicesLogin } from './mobileservices/mobileServicesLogin';
import { isCfCliInstalled, isCfLoggedIn } from './destination/cfCliAuth';
import { sendRequest, buildHttpRequest } from './client/httpClient';
import { createCodeLensProvider } from './providers/codeLensProvider';
import { createCompletionProvider } from './providers/completionProvider';
import { DestinationTreeProvider } from './providers/destinationTreeProvider';
import { StatusBarProvider } from './providers/statusBarProvider';
import { ResponsePanel } from './views/responsePanel';
import { Logger } from './utils/logger';
import type { RequestBlock } from './parser/types';

const HTTP_LANGUAGE_SELECTOR: vscode.DocumentSelector = { language: 'dest', scheme: 'file' };

export function activate(context: vscode.ExtensionContext): void {
  Logger.init(context);
  Logger.info('Destination Anywhere extension activating…');

  // Init Mobile Services login (needs SecretStorage)
  initMobileServicesLogin(context.secrets);

  // Init on-premise proxy login (needs SecretStorage + extension path)
  initProxyLogin(context.secrets, context.extensionPath);

  // Sidebar tree view
  const treeProvider = new DestinationTreeProvider();
  const treeView = vscode.window.createTreeView('destinationAnywhere.destinationsView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Status bar
  new StatusBarProvider(context);

  // Providers
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(HTTP_LANGUAGE_SELECTOR, createCodeLensProvider()),
    vscode.languages.registerCompletionItemProvider(HTTP_LANGUAGE_SELECTOR, createCompletionProvider()),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'destinationAnywhere.sendRequest',
      (blockArg?: RequestBlock) => handleSendRequest(context, blockArg),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.switchEnvironment',
      () => handleSwitchEnvironment(),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.clearDestinationCache',
      async () => {
        clearDestinationCache();
        await clearProxyAppCache();
        await clearMobileServicesCache();
        vscode.window.showInformationMessage('Destination Anywhere: Destination cache cleared.');
        Logger.info('Destination cache cleared.');
      },
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.refreshDestinations',
      () => treeProvider.refresh(),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.cfLogin',
      async () => {
        // Try CF Tools extension first, fall back to terminal
        try {
          await vscode.commands.executeCommand('cf.login');
          // After login, refresh sidebar and status bar
          setTimeout(() => treeProvider.refresh(), 2000);
        } catch {
          // CF Tools not available — open terminal with cf login
          const terminal = vscode.window.createTerminal('CF Login');
          terminal.show();
          terminal.sendText('cf login');
        }
      },
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.cfLogout',
      async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('cf', ['logout'], { timeout: 10_000 }, (err) => {
              if (err) { reject(err); } else { resolve(); }
            });
          });
          clearDestinationCache();
          await clearProxyAppCache();
          await clearMobileServicesCache();
          treeProvider.refresh();
          vscode.window.showInformationMessage('Destination Anywhere: Logged out from Cloud Foundry.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Destination Anywhere: Logout failed — ${msg}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.insertSnippet',
      (node) => DestinationTreeProvider.insertSnippet(node),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.msLogin',
      async () => {
        treeProvider.loginToMobileServices();
      },
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.createDestService',
      () => treeProvider.createDestinationService(),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.deployProxyApp',
      () => treeProvider.deployProxyApp(),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.proxyLogin',
      () => treeProvider.loginToProxy(),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.showDestinationInfo',
      async (node: { kind: string; data?: { destinationName?: string } }) => {
        const name = node?.data?.destinationName;
        if (!name) {
          vscode.window.showWarningMessage('No destination selected.');
          return;
        }
        try {
          const config = await getDestinationDetails(name);
          const lines: string[] = [`Destination: ${name}`, ''];
          // Show sensitive-safe properties
          const sensitiveKeys = new Set(['Password', 'clientSecret', 'tokenServicePassword']);
          for (const [key, value] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`${key}: ${sensitiveKeys.has(key) ? '••••••••' : value}`);
          }
          const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'properties' });
          await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Destination Anywhere: Failed to fetch destination info — ${msg}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.focusSidebar',
      () => vscode.commands.executeCommand('destinationAnywhere.destinationsView.focus'),
    ),

    vscode.commands.registerCommand(
      'destinationAnywhere.uninstallRouterApp',
      async () => {
        const answer = await vscode.window.showWarningMessage(
          'Delete the on-premise router app from your CF space?\n\n' +
          'On-premise destinations will fall back to direct mode.',
          { modal: true },
          'Delete',
        );
        if (answer !== 'Delete') { return; }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Removing on-premise router app…' },
            async () => { await uninstallProxyApp(); },
          );
          treeProvider.refresh();
          vscode.window.showInformationMessage('Destination Anywhere: On-premise router app deleted.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Destination Anywhere: Failed to delete router app — ${msg}`);
        }
      },
    ),
  );

  Logger.info('Destination Anywhere extension activated.');
}

export function deactivate(): void {
  // Nothing to clean up — disposables are handled via context.subscriptions.
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSendRequest(
  context: vscode.ExtensionContext,
  blockArg?: RequestBlock,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a .dest file first.');
    return;
  }

  const document = editor.document;
  const fileText = document.getText();

  // Determine the request block — either passed from CodeLens or found by cursor
  let block: RequestBlock | undefined = blockArg;
  if (!block) {
    const blocks = parseHttpFile(fileText);
    if (blocks.length === 0) {
      vscode.window.showWarningMessage('No HTTP requests found in this file.');
      return;
    }
    block = getRequestBlockAtLine(blocks, editor.selection.active.line);
    if (!block) {
      vscode.window.showWarningMessage(
        'Place your cursor inside a request block, then try again.',
      );
      return;
    }
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Sending ${block.method} request…`,
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      try {
        // 1. Collect & resolve variables
        progress.report({ message: 'Resolving variables…' });
        const variables = await collectVariables(fileText, workspaceFolder);
        const resolvedUrl = resolveVariables(block.rawUrl, variables);

        const resolvedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(block.headers)) {
          resolvedHeaders[resolveVariables(key, variables)] =
            resolveVariables(value, variables);
        }

        const resolvedBody = block.body
          ? resolveVariables(block.body, variables)
          : undefined;

        // 2. Resolve dest:// URLs
        let finalUrl = resolvedUrl;
        let additionalHeaders: Record<string, string> = {};
        let proxyConfig: import('./parser/types').ProxyConfig | undefined;

        const needsCf = isDestinationUrl(resolvedUrl) || isMobileServicesUrl(resolvedUrl);
        if (needsCf) {
          // CF guard — check before making any CF calls
          if (!(await isCfCliInstalled())) {
            const action = await vscode.window.showErrorMessage(
              'Destination Anywhere: CF CLI not found. Install it to use dest:// and mdk:// URLs.',
              'Open Installation Guide',
            );
            if (action) {
              vscode.env.openExternal(vscode.Uri.parse('https://github.com/cloudfoundry/cli/releases'));
            }
            return;
          }
          if (!(await isCfLoggedIn())) {
            const action = await vscode.window.showErrorMessage(
              'Destination Anywhere: Not logged in to Cloud Foundry. Please log in to resolve dest:// and mdk:// URLs.',
              'Login with CF Tools',
              'Dismiss',
            );
            if (action === 'Login with CF Tools') {
              vscode.commands.executeCommand('destinationAnywhere.cfLogin');
            }
            return;
          }
        }

        let viaProxy = false;

        if (isDestinationUrl(resolvedUrl)) {
          progress.report({ message: 'Resolving destination…' });
          const dest = await resolveDestinationUrl(resolvedUrl);
          finalUrl = dest.url;
          additionalHeaders = dest.headers;
          proxyConfig = dest.proxyConfig;
          viaProxy = dest.viaProxy ?? false;
        } else if (isMobileServicesUrl(resolvedUrl)) {
          progress.report({ message: 'Resolving Mobile Services destination…' });
          const mdk = await resolveMobileServicesUrl(resolvedUrl);
          finalUrl = mdk.url;
          additionalHeaders = mdk.headers;
        }

        // 3. Build and send
        const resolvedBlock: RequestBlock = {
          ...block,
          headers: resolvedHeaders,
          body: resolvedBody,
        };
        const httpRequest = buildHttpRequest(resolvedBlock, finalUrl, additionalHeaders, proxyConfig);

        // When routed through the on-premise proxy, disable redirect following
        // to prevent chasing internal redirects to unreachable hostnames.
        if (viaProxy) {
          httpRequest.followRedirects = false;
        }

        progress.report({ message: 'Waiting for response…' });
        Logger.info(`${httpRequest.method} ${httpRequest.url}`);
        const response = await sendRequest(httpRequest, cancellationToken);

        // 4. Show response
        Logger.info(
          `Response: ${response.statusCode} ${response.statusMessage} (${response.elapsedTime} ms)`,
        );
        ResponsePanel.show(response, context.extensionUri);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message === 'Request was cancelled') {
          Logger.info('Request cancelled by user.');
          return;
        }

        Logger.error('Request failed', err instanceof Error ? err : undefined);
        vscode.window.showErrorMessage(`Destination Anywhere: ${message}`);
      }
    },
  );
}

async function handleSwitchEnvironment(): Promise<void> {
  const config = vscode.workspace.getConfiguration('destinationAnywhere');
  const envVars = config.get<Record<string, Record<string, string>>>('environmentVariables');

  if (!envVars || Object.keys(envVars).length === 0) {
    vscode.window.showInformationMessage(
      'No environments configured. Add environments in "destinationAnywhere.environmentVariables".',
    );
    return;
  }

  const current = config.get<string>('activeEnvironment') ?? '';
  const items: vscode.QuickPickItem[] = Object.keys(envVars).map((name) => ({
    label: name,
    description: name === current ? '(active)' : undefined,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an environment',
  });

  if (picked) {
    await config.update('activeEnvironment', picked.label, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`Switched to environment: ${picked.label}`);
    Logger.info(`Environment switched to "${picked.label}".`);
  }
}
