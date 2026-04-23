/**
 * TreeDataProvider for the Destination Anywhere sidebar panel.
 *
 * Shows three sections:
 *   1. CF connection status (with login shortcut if not connected)
 *   2. BTP Destinations (dest://)
 *   3. Mobile Services Apps + their destinations (mdk://)
 *
 * Clicking a leaf destination inserts a sample request block into the
 * active .dest editor.
 */

import * as vscode from 'vscode';
import {
  isCfCliInstalled,
  isCfLoggedIn,
  getCfApiInfo,
  getServiceKeyCredentials,
  findDestinationServiceInstanceOrNull,
  createDestinationServiceInstance,
} from '../destination/cfCliAuth';
import { isProxyAppDeployed, getProxyAppUrl, deployProxyApp, clearProxyAppCache, hasProxyToken, getProxyAuthToken } from '../destination/proxyApp';
import { listMobileServicesApps, getMobileServicesCredentials } from '../mobileservices/mobileServicesAuth';
import { clearDestinationCache, getDestinationServiceToken } from '../destination/destinationResolver';
import { clearMobileServicesCache, listMobileServicesDestinations } from '../mobileservices/mobileServicesResolver';
import { getMobileServicesToken, hasMobileServicesToken } from '../mobileservices/mobileServicesLogin';
import { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

type NodeKind =
  | 'cf-status'
  | 'cf-action'
  | 'group'
  | 'loading'
  | 'error'
  | 'btp-destination'
  | 'ms-app'
  | 'ms-destination';

export class DestinationNode extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly data?: {
      destinationName?: string;
      appId?: string;
      proxyType?: string;
      authType?: string;
    },
  ) {
    super(label, collapsible);
    // Set contextValue so package.json menus can target destination nodes
    if (kind === 'btp-destination' || kind === 'ms-destination') {
      this.contextValue = 'destination';
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DestinationTreeProvider
  implements vscode.TreeDataProvider<DestinationNode>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<DestinationNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached BTP destinations list */
  private btpDestinations: Array<{ name: string; proxyType: string; authType: string; scope: string }> | undefined;
  /** 'missing' = no destination service instance found in this space */
  private btpServiceStatus: 'unknown' | 'missing' | 'creating' | 'error' | 'ok' = 'unknown';
  /** Name of the destination service instance being used */
  private btpServiceName = '';
  /** Error message when btpServiceStatus === 'error' */
  private btpServiceError = '';
  /** Cached Mobile Services apps map: instanceName → xsuaaInstanceName */
  private msApps: Map<string, string> | undefined;
  /** Cached MS destinations per app: appId → destination names */
  private msDestinations: Map<string, string[]> = new Map();
  /** Whether the user is logged in to Mobile Services */
  private msLoggedIn = false;
  /** Whether the on-premise router app is deployed */
  private proxyAppDeployed = false;
  /** URL of the deployed router app */
  private proxyAppUrl: string | undefined;
  /** Whether the user is logged in to the on-premise proxy */
  private proxyLoggedIn = false;
  /** Guard: true while router app deployment is in progress */
  private proxyDeploying = false;
  /** Current CF status */
  private cfStatus: 'checking' | 'no-cli' | 'not-logged-in' | 'ok' = 'checking';
  /** Guard: true while loadAllDestinations is running to prevent concurrent calls */
  private destinationsLoading = false;
  /** Whether the initial async load has been triggered (deferred until the view is visible). */
  private initialLoadTriggered = false;
  /** CF target identity — used to detect org/space switches */
  private cfApiEndpoint = '';
  private cfOrg = '';
  private cfSpace = '';

  constructor() {
    // Loading is deferred to the first getChildren() call (when the sidebar view becomes visible).
  }

  refresh(): void {
    this.btpDestinations = undefined;
    this.btpServiceStatus = 'unknown';
    this.btpServiceName = '';
    this.btpServiceError = '';
    this.msApps = undefined;
    this.msDestinations.clear();
    this.msLoggedIn = false;
    this.proxyAppDeployed = false;
    this.proxyAppUrl = undefined;
    this.proxyLoggedIn = false;
    void clearProxyAppCache();
    // Clear resolver caches so credentials/tokens from a previous CF target
    // are not reused after the user switches subaccounts.
    clearDestinationCache();
    void clearMobileServicesCache();
    this.cfStatus = 'checking';
    this.destinationsLoading = false;
    this._onDidChangeTreeData.fire(undefined);
    // Trigger async load
    this.loadCfStatus().then(() => {
      this._onDidChangeTreeData.fire(undefined);
      if (this.cfStatus === 'ok') {
        this.loadAllDestinations();
      }
    });
  }

  getTreeItem(element: DestinationNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DestinationNode): Promise<DestinationNode[]> {
    // Trigger initial load on first call (deferred until the view is visible)
    if (!this.initialLoadTriggered) {
      this.initialLoadTriggered = true;
      this.loadCfStatus().then(() => {
        this._onDidChangeTreeData.fire(undefined);
        if (this.cfStatus === 'ok') {
          this.loadAllDestinations();
        }
      });
    }

    // Root level
    if (!element) {
      return this.getRootNodes();
    }

    if (element.kind === 'group' && element.label === '🌐 BTP Destinations') {
      return this.getBtpChildren();
    }

    if (element.kind === 'group' && element.label === '📱 Mobile Services Apps') {
      return this.getMsAppChildren();
    }

    if (element.kind === 'ms-app' && element.data?.appId) {
      return this.getMsDestinationChildren(element.data.appId);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Root nodes
  // ---------------------------------------------------------------------------

  private getRootNodes(): DestinationNode[] {
    const nodes: DestinationNode[] = [];

    // CF status node
    if (this.cfStatus === 'checking') {
      const n = new DestinationNode('loading', '⏳ Connecting to Cloud Foundry…', vscode.TreeItemCollapsibleState.None);
      n.description = '';
      nodes.push(n);
      return nodes;
    }

    if (this.cfStatus === 'no-cli') {
      const n = new DestinationNode('cf-status', '❌ CF CLI not found', vscode.TreeItemCollapsibleState.None);
      n.tooltip = 'Install the CF CLI from https://github.com/cloudfoundry/cli/releases';
      n.description = 'Install CF CLI to continue';
      const action = new DestinationNode('cf-action', '  ↗ Open Installation Guide', vscode.TreeItemCollapsibleState.None);
      action.command = {
        command: 'vscode.open',
        title: 'Open CF CLI installation guide',
        arguments: [vscode.Uri.parse('https://github.com/cloudfoundry/cli/releases')],
      };
      action.iconPath = new vscode.ThemeIcon('link-external');
      nodes.push(n, action);
      return nodes;
    }

    if (this.cfStatus === 'not-logged-in') {
      const n = new DestinationNode('cf-status', '⚠️ Not logged in to Cloud Foundry', vscode.TreeItemCollapsibleState.None);
      n.tooltip = 'Click Login to authenticate with Cloud Foundry';
      const action = new DestinationNode('cf-action', '  ↗ Login with CF Tools', vscode.TreeItemCollapsibleState.None);
      action.command = {
        command: 'destinationAnywhere.cfLogin',
        title: 'Login to Cloud Foundry',
      };
      action.iconPath = new vscode.ThemeIcon('sign-in');
      nodes.push(n, action);
      return nodes;
    }

    // Logged in — show status + groups
    const status = new DestinationNode(
      'cf-status',
      `✅ ${this.cfApiEndpoint.replace('https://', '')}`,
      vscode.TreeItemCollapsibleState.None,
    );
    status.description = `${this.cfOrg} › ${this.cfSpace}`;
    status.tooltip = `API: ${this.cfApiEndpoint}\nOrg: ${this.cfOrg}\nSpace: ${this.cfSpace}`;
    status.iconPath = new vscode.ThemeIcon('cloud');

    const btpGroup = new DestinationNode(
      'group',
      '🌐 BTP Destinations',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    btpGroup.iconPath = new vscode.ThemeIcon('globe');

    const msGroup = new DestinationNode(
      'group',
      '📱 Mobile Services Apps',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    msGroup.iconPath = new vscode.ThemeIcon('device-mobile');

    nodes.push(status, btpGroup, msGroup);
    return nodes;
  }

  // ---------------------------------------------------------------------------
  // BTP Destination children
  // ---------------------------------------------------------------------------

  private getBtpChildren(): DestinationNode[] {
    // Still loading
    if (this.btpServiceStatus === 'unknown') {
      return [this.loadingNode('Loading BTP destinations…')];
    }

    // No destination service instance found in this space
    if (this.btpServiceStatus === 'missing') {
      const create = new DestinationNode(
        'cf-action',
        'Create Destination Service instance…',
        vscode.TreeItemCollapsibleState.None,
      );
      create.iconPath = new vscode.ThemeIcon('add');
      create.tooltip = new vscode.MarkdownString(
        '**No Destination Service instance in this CF space**\n\n' +
        'This instance is needed to fetch the subaccount-level global destinations from BTP.\n\n' +
        'Creates `dest-anywhere-dest` with the free **lite** plan in this CF space.',
        true,
      );
      create.command = {
        command: 'destinationAnywhere.createDestService',
        title: 'Create Destination Service instance',
      };
      return [create];
    }

    // Creation in progress
    if (this.btpServiceStatus === 'creating') {
      return [this.loadingNode('Creating Destination Service instance…')];
    }

    // Creation or fetch failed
    if (this.btpServiceStatus === 'error') {
      const err = new DestinationNode(
        'error',
        '❌ Failed to load destinations',
        vscode.TreeItemCollapsibleState.None,
      );
      err.tooltip = this.btpServiceError;
      err.iconPath = new vscode.ThemeIcon('error');
      return [err];
    }

    // Loaded OK — btpServiceName is the instance in use
    if (!this.btpDestinations || this.btpDestinations.length === 0) {
      const info = new DestinationNode(
        'error',
        'No destinations configured',
        vscode.TreeItemCollapsibleState.None,
      );
      info.description = this.btpServiceName;
      info.tooltip = `Service instance: ${this.btpServiceName}\nNo destinations found.`;
      info.iconPath = new vscode.ThemeIcon('info');
      return [info];
    }

    const nodes = this.btpDestinations.map((d) => {
      const isOnPremise = d.proxyType?.toLowerCase() === 'onpremise';
      const scopeLabel = d.scope === 'instance' ? 'instance' : 'subaccount';
      const node = new DestinationNode(
        'btp-destination',
        d.name,
        vscode.TreeItemCollapsibleState.None,
        { destinationName: d.name, proxyType: d.proxyType, authType: d.authType },
      );
      node.description = `${d.proxyType} · ${d.authType} · ${scopeLabel}`;
      if (isOnPremise) {
        if (this.proxyAppDeployed) {
          node.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.green'));
          node.tooltip = new vscode.MarkdownString(
            `**On-Premise Destination** (routed via router)\n\n` +
            `Requests to this destination will be relayed through the on-premise router app ` +
            `at \`${this.proxyAppUrl ?? 'unknown'}\`, which reaches the backend via Cloud Connector.`,
            true,
          );
        } else {
          node.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
          node.description = `${d.proxyType} · ${d.authType} · ${scopeLabel} · direct`;
          node.tooltip = new vscode.MarkdownString(
            `**On-Premise Destination** (direct mode)\n\n` +
            `This destination uses SAP Cloud Connector to reach the on-premise backend. ` +
            `Requests will be sent directly using the resolved destination URL and credentials.\n\n` +
            `This works if Cloud Connector is reachable from your machine (e.g. local installation, VPN). ` +
            `If not, you can deploy the **On-Premise Router** — a lightweight Express app that runs ` +
            `inside your CF space and relays requests through Cloud Connector.`,
            true,
          );
        }
      } else {
        node.iconPath = new vscode.ThemeIcon('plug');
        node.tooltip = `Right-click for options`;
      }
      return node;
    });

    // Prepend proxy status node if any on-premise destinations exist
    const hasOnPremise = nodes.some(
      (n) => n.data?.proxyType?.toLowerCase() === 'onpremise',
    );
    if (hasOnPremise) {
      if (this.proxyAppDeployed) {
        // Login status node (like Mobile Services)
        if (this.proxyLoggedIn) {
          const loginNode = new DestinationNode(
            'cf-status',
            'On-Premise Router ✓',
            vscode.TreeItemCollapsibleState.None,
          );
          loginNode.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
          loginNode.description = this.proxyAppUrl?.replace('https://', '') ?? '';
          loginNode.contextValue = 'proxyRouter';
          loginNode.tooltip = new vscode.MarkdownString(
            `**On-premise router app is running — authenticated**\n\n` +
            `URL: \`${this.proxyAppUrl}\`\n\n` +
            `A valid XSUAA token is active. All on-premise destination requests are ` +
            `routed through this Express server via Cloud Connector.`,
            true,
          );
          nodes.unshift(loginNode);
        } else {
          const loginNode = new DestinationNode(
            'cf-action',
            'Login to On-Premise Router…',
            vscode.TreeItemCollapsibleState.None,
          );
          loginNode.iconPath = new vscode.ThemeIcon('sign-in');
          loginNode.tooltip = new vscode.MarkdownString(
            '**Authentication required**\n\n' +
            'The on-premise router requires a user-level XSUAA token to relay requests ' +
            'through Cloud Connector.\n\n' +
            'Click to open your browser and authenticate with BTP. ' +
            'After login, on-premise destinations will work automatically.',
            true,
          );
          loginNode.command = {
            command: 'destinationAnywhere.proxyLogin',
            title: 'Login to On-Premise Router',
          };
          nodes.unshift(loginNode);
        }
      } else {
        const deployNode = new DestinationNode(
          'cf-action',
          'Deploy On-Premise Router…',
          vscode.TreeItemCollapsibleState.None,
        );
        deployNode.iconPath = new vscode.ThemeIcon('add');
        deployNode.tooltip = new vscode.MarkdownString(
          '**Deploy an Express router to forward on-premise requests**\n\n' +
          'On-premise destinations use Cloud Connector, which is only reachable from inside CF. ' +
          'This deploys a lightweight Express app to your CF space with the required services:\n\n' +
          '- **Destination Service** — reads destination configs\n' +
          '- **Connectivity Service** — tunnels through Cloud Connector (reuses existing or creates new)\n' +
          '- **XSUAA** — provides the authentication identity for the tunnel\n\n' +
          'Destination Anywhere then sends requests to the router with a valid XSUAA token, ' +
          'and the router relays them to on-premise backends via SAP Cloud SDK.',
          true,
        );
        deployNode.command = {
          command: 'destinationAnywhere.deployProxyApp',
          title: 'Deploy On-Premise Router',
        };
        nodes.unshift(deployNode);
      }
    }

    return nodes;
  }

  // ---------------------------------------------------------------------------
  // Mobile Services app children
  // ---------------------------------------------------------------------------

  private getMsAppChildren(): DestinationNode[] {
    if (!this.msApps) {
      return [this.loadingNode('Loading Mobile Services apps…')];
    }
    if (this.msApps.size === 0) {
      const info = new DestinationNode(
        'error',
        'No Mobile Services instances in this space',
        vscode.TreeItemCollapsibleState.None,
      );
      info.tooltip = new vscode.MarkdownString(
        '## No SAP Mobile Services instances found\n\n' +
        'No CF service of type `mobile-services` exists in the current org/space.\n\n' +
        '**Mobile Services is a separate BTP service** — unlike the Destination Service, ' +
        'it cannot be created automatically. It must be subscribed to and provisioned ' +
        'in the **BTP Cockpit** under *Services → Service Marketplace*.\n\n' +
        'Once provisioned and bound to your CF space, the apps you create there ' +
        'will appear here automatically after a refresh.',
        true,
      );
      info.iconPath = new vscode.ThemeIcon('info');
      return [info];
    }

    const nodes: DestinationNode[] = [];

    // Login / status node — always the first child
    if (this.msLoggedIn) {
      const status = new DestinationNode(
        'cf-status',
        'Mobile Services ✓',
        vscode.TreeItemCollapsibleState.None,
      );
      status.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
      status.description = 'authenticated';
      status.tooltip = new vscode.MarkdownString(
        '**Authenticated to SAP Mobile Services**\n\n' +
        'A valid user token is active. Destination lists are fetched from the ' +
        'Mobile Services Endpoints API.',
        true,
      );
      nodes.push(status);
    } else {
      const login = new DestinationNode(
        'cf-action',
        'Login to Mobile Services…',
        vscode.TreeItemCollapsibleState.None,
      );
      login.iconPath = new vscode.ThemeIcon('sign-in');
      login.tooltip = new vscode.MarkdownString(
        '**Authentication required**\n\n' +
        'Mobile Services destinations are fetched from the server via the ' +
        'OData Endpoints API, which requires a user-level token.\n\n' +
        'Click to open your browser and authenticate with SAP Mobile Services. ' +
        'After login, the app nodes below will become expandable and show ' +
        'their configured destinations.',
        true,
      );
      login.command = {
        command: 'destinationAnywhere.msLogin',
        title: 'Login to Mobile Services',
      };
      nodes.push(login);
    }

    // App nodes — expandable only when logged in
    for (const instanceName of this.msApps.keys()) {
      const node = new DestinationNode(
        'ms-app',
        instanceName,
        this.msLoggedIn
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        { appId: instanceName },
      );
      node.iconPath = new vscode.ThemeIcon('device-mobile');
      node.tooltip = this.msLoggedIn
        ? `Mobile Services app: ${instanceName}`
        : `Login to Mobile Services to see destinations for ${instanceName}`;
      nodes.push(node);
    }

    return nodes;
  }

  private getMsDestinationChildren(appId: string): DestinationNode[] {
    const dests = this.msDestinations.get(appId);
    if (!dests) {
      // Trigger load
      this.loadMsDestinations(appId);
      return [this.loadingNode('Loading destinations…')];
    }
    if (dests.length === 0) {
      return [this.emptyNode('No destinations configured')];
    }
    return dests.map((destName) => {
      const node = new DestinationNode(
        'ms-destination',
        destName,
        vscode.TreeItemCollapsibleState.None,
        { destinationName: destName, appId },
      );
      node.iconPath = new vscode.ThemeIcon('plug');
      node.tooltip = `Right-click for options`;
      return node;
    });
  }

  // ---------------------------------------------------------------------------
  // Async data loading
  // ---------------------------------------------------------------------------

  private async loadCfStatus(): Promise<void> {
    try {
      if (!(await isCfCliInstalled())) {
        this.cfStatus = 'no-cli';
        return;
      }
      if (!(await isCfLoggedIn())) {
        this.cfStatus = 'not-logged-in';
        return;
      }
      const info = await getCfApiInfo();

      // Detect CF target changes (different org, space, or API endpoint).
      // When the target changes, stale resolver caches must be purged so that
      // the next dest:// or mdk:// request uses credentials for the new target.
      const targetChanged =
        this.cfStatus === 'ok' && (
          info.apiEndpoint !== this.cfApiEndpoint ||
          info.org !== this.cfOrg ||
          info.space !== this.cfSpace
        );

      if (targetChanged) {
        Logger.info(
          `CF target changed → ${info.apiEndpoint} / ${info.org} / ${info.space}. ` +
          'Clearing resolver caches.',
        );
        clearDestinationCache();
        await clearMobileServicesCache();
        vscode.window.showInformationMessage(
          `Destination Anywhere: CF target changed to ${info.org} › ${info.space}. Caches cleared.`,
        );
      }

      this.cfApiEndpoint = info.apiEndpoint;
      this.cfOrg = info.org;
      this.cfSpace = info.space;
      this.cfStatus = 'ok';
    } catch (err) {
      Logger.warn('CF status check failed: ' + String(err));
      this.cfStatus = 'not-logged-in';
    }
  }

  private async loadAllDestinations(): Promise<void> {
    if (this.destinationsLoading) { return; }
    this.destinationsLoading = true;
    try {
      await Promise.all([
        this.loadBtpDestinations(),
        this.loadMsApps(),
        this.loadProxyAppStatus(),
      ]);
    } finally {
      this.destinationsLoading = false;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  private async loadBtpDestinations(): Promise<void> {
    try {
      // Use the scan-only variant so the sidebar controls the creation flow
      const instanceName = await findDestinationServiceInstanceOrNull();

      if (!instanceName) {
        this.btpServiceStatus = 'missing';
        this.btpDestinations = [];
        return;
      }

      this.btpServiceName = instanceName;
      const creds = await getServiceKeyCredentials(instanceName);

      // Get oauth token (uses shared cache from destination resolver)
      const token = await getDestinationServiceToken(creds);

      // Fetch both subaccount-level and instance-level destinations
      type DestEntry = { Name: string; ProxyType?: string; Authentication?: string };
      const headers = { 'Authorization': `Bearer ${token}` };
      const [subaccountResp, instanceResp] = await Promise.all([
        fetch(
          `${creds.uri}/destination-configuration/v1/subaccountDestinations`,
          { headers, signal: AbortSignal.timeout(15_000) },
        ).then(async (r) => {
          if (!r.ok) { throw new Error(`${r.status} ${r.statusText}`); }
          return r.json() as Promise<DestEntry[]>;
        }),
        fetch(
          `${creds.uri}/destination-configuration/v1/instanceDestinations`,
          { headers, signal: AbortSignal.timeout(15_000) },
        ).then(async (r) => {
          if (!r.ok) { return [] as DestEntry[]; }
          return r.json() as Promise<DestEntry[]>;
        }).catch(() => [] as DestEntry[]),
      ]);

      // Merge: instance destinations override subaccount ones with the same name
      const destMap = new Map<string, { name: string; proxyType: string; authType: string; scope: string }>();
      for (const d of subaccountResp) {
        destMap.set(d.Name, {
          name: d.Name,
          proxyType: d.ProxyType ?? 'Internet',
          authType: d.Authentication ?? 'Unknown',
          scope: 'subaccount',
        });
      }
      for (const d of instanceResp) {
        destMap.set(d.Name, {
          name: d.Name,
          proxyType: d.ProxyType ?? 'Internet',
          authType: d.Authentication ?? 'Unknown',
          scope: 'instance',
        });
      }

      this.btpDestinations = [...destMap.values()];
      this.btpServiceStatus = 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.warn('Failed to load BTP destinations: ' + msg);
      this.btpServiceStatus = 'error';
      this.btpServiceError = msg;
      this.btpDestinations = [];
    }
  }

  /**
   * Called by the `destinationAnywhere.createDestService` command.
   * Asks for confirmation, creates the service instance, then refreshes.
   */
  async createDestinationService(): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      'No Destination Service instance was found in this CF space.\n\n' +
      'The SAP BTP Destination Service API requires an instance to read subaccount destinations.\n\n' +
      'You can create one manually in the BTP cockpit or via the CF CLI — ' +
      'Destination Anywhere will pick it up automatically on the next refresh.\n\n' +
      'Or let Destination Anywhere create one for you now (free lite plan, named "dest-anywhere-dest").',
      { modal: true },
      'Create automatically',
    );
    if (answer !== 'Create automatically') { return; }

    this.btpServiceStatus = 'creating';
    this._onDidChangeTreeData.fire(undefined);

    try {
      const name = await createDestinationServiceInstance();
      Logger.info(`Destination Service instance "${name}" created successfully.`);
      vscode.window.showInformationMessage(
        `Destination Anywhere: Created Destination Service instance "${name}". Loading destinations…`,
      );
      // Full refresh so service key is created and destinations are fetched
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.warn('Failed to create Destination Service instance: ' + msg);
      this.btpServiceStatus = 'error';
      this.btpServiceError = msg;
      this._onDidChangeTreeData.fire(undefined);
      vscode.window.showErrorMessage('Destination Anywhere: ' + msg);
    }
  }

  /** Check if the on-premise router app is deployed and auth status. */
  private async loadProxyAppStatus(): Promise<void> {
    try {
      this.proxyAppDeployed = await isProxyAppDeployed();
      this.proxyAppUrl = getProxyAppUrl();
      if (this.proxyAppDeployed) {
        this.proxyLoggedIn = await hasProxyToken();
      }
    } catch {
      this.proxyAppDeployed = false;
      this.proxyAppUrl = undefined;
      this.proxyLoggedIn = false;
    }
  }

  /**
   * Deploy the on-premise Express router to the current CF space.
   * Called by the `destinationAnywhere.deployProxyApp` command.
   */
  async deployProxyApp(): Promise<void> {
    if (this.proxyDeploying) {
      vscode.window.showInformationMessage('Destination Anywhere: Router deployment is already in progress.');
      return;
    }
    if (this.proxyAppDeployed) {
      vscode.window.showInformationMessage(
        `Destination Anywhere: On-premise router is already deployed at ${this.proxyAppUrl ?? 'unknown URL'}.`,
      );
      return;
    }
    if (!this.btpServiceName) {
      vscode.window.showWarningMessage(
        'Destination Anywhere: No Destination Service instance found. Create one first.',
      );
      return;
    }

    const answer = await vscode.window.showInformationMessage(
      'Deploy a lightweight Express router to your CF space?\n\n' +
      'This open-source router app enables Destination Anywhere to reach on-premise backends through Cloud Connector.\n\n' +
      'See the full details in the README: https://github.com/aydin-ozcan/destination-anywhere#on-premise-destinations',
      { modal: true },
      'Deploy',
    );
    if (answer !== 'Deploy') { return; }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Deploying on-premise router app…',
        cancellable: false,
      },
      async (progress) => {
        this.proxyDeploying = true;
        try {
          progress.report({ message: 'Pushing to Cloud Foundry…' });
          const url = await deployProxyApp(this.btpServiceName);
          this.proxyAppDeployed = true;
          this.proxyAppUrl = url;
          this._onDidChangeTreeData.fire(undefined);
          vscode.window.showInformationMessage(
            `Destination Anywhere: On-premise router deployed at ${url}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          Logger.error('Failed to deploy router app: ' + msg);
          vscode.window.showErrorMessage('Destination Anywhere: Failed to deploy router — ' + msg);
        } finally {
          this.proxyDeploying = false;
        }
      },
    );
  }

  /**
   * Trigger the on-premise proxy XSUAA login flow.
   * Called by the `destinationAnywhere.proxyLogin` command.
   */
  async loginToProxy(): Promise<void> {
    if (!this.proxyAppDeployed) {
      vscode.window.showWarningMessage(
        'Destination Anywhere: On-premise router is not deployed. Deploy it first.',
      );
      return;
    }

    try {
      await getProxyAuthToken();
      this.proxyLoggedIn = true;
      this._onDidChangeTreeData.fire(undefined);
      vscode.window.showInformationMessage('Destination Anywhere: Logged in to on-premise router.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.error('Proxy login failed: ' + msg);
      vscode.window.showErrorMessage('Destination Anywhere: Proxy login failed — ' + msg);
    }
  }


  private async loadMsApps(): Promise<void> {
    try {
      this.msApps = await listMobileServicesApps();
      // After loading apps, check if we already have tokens stored
      if (this.msApps.size > 0) {
        await this.checkMsLoginStatus();
      }
    } catch (err) {
      Logger.warn('Failed to load Mobile Services apps: ' + String(err));
      this.msApps = new Map();
    }
  }

  /** Check if we have a valid token for at least one MS app (without triggering login). */
  private async checkMsLoginStatus(): Promise<void> {
    if (!this.msApps || this.msApps.size === 0) { return; }

    for (const instanceName of this.msApps.keys()) {
      try {
        const creds = await getMobileServicesCredentials(instanceName);
        const valid = await hasMobileServicesToken(creds.instanceId, {
          clientid: creds.clientid,
          clientsecret: creds.clientsecret,
          url: creds.url,
        });
        if (valid) {
          this.msLoggedIn = true;
          return;
        }
      } catch {
        // Skip — credentials not yet available
      }
    }
    this.msLoggedIn = false;
  }

  /**
   * Trigger browser OAuth login for Mobile Services.
   * Authenticates with the first app, then silently exchanges tokens for the rest.
   * Called by the `destinationAnywhere.msLogin` command.
   */
  async loginToMobileServices(): Promise<void> {
    if (!this.msApps || this.msApps.size === 0) {
      vscode.window.showWarningMessage('Destination Anywhere: No Mobile Services apps found in this CF space.');
      return;
    }

    const firstApp = [...this.msApps.keys()][0];
    try {
      // Get credentials for the first app → triggers browser login
      const creds = await getMobileServicesCredentials(firstApp);
      await getMobileServicesToken(creds.instanceId, {
        clientid: creds.clientid,
        clientsecret: creds.clientsecret,
        url: creds.url,
      });

      this.msLoggedIn = true;
      this.msDestinations.clear();
      this._onDidChangeTreeData.fire(undefined);

      vscode.window.showInformationMessage('Destination Anywhere: Logged in to Mobile Services.');

      // Silently get tokens for remaining apps (browser session should still be active)
      const remaining = [...this.msApps.keys()].slice(1);
      for (const appName of remaining) {
        try {
          const appCreds = await getMobileServicesCredentials(appName);
          await getMobileServicesToken(appCreds.instanceId, {
            clientid: appCreds.clientid,
            clientsecret: appCreds.clientsecret,
            url: appCreds.url,
          });
        } catch (err) {
          Logger.warn(`Failed to silently authenticate for MS app "${appName}": ${err}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.error('Mobile Services login failed: ' + msg);
      vscode.window.showErrorMessage('Destination Anywhere: Mobile Services login failed — ' + msg);
    }
  }

  private async loadMsDestinations(appId: string): Promise<void> {
    try {
      const destinations = await listMobileServicesDestinations(appId);
      this.msDestinations.set(appId, destinations);
    } catch (err) {
      Logger.warn(`Failed to load MS destinations for "${appId}": ${err}`);
      this.msDestinations.set(appId, []);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  // ---------------------------------------------------------------------------
  // Utility nodes
  // ---------------------------------------------------------------------------

  private loadingNode(msg: string): DestinationNode {
    const n = new DestinationNode('loading', msg, vscode.TreeItemCollapsibleState.None);
    n.iconPath = new vscode.ThemeIcon('loading~spin');
    return n;
  }

  private emptyNode(msg: string): DestinationNode {
    const n = new DestinationNode('error', msg, vscode.TreeItemCollapsibleState.None);
    n.iconPath = new vscode.ThemeIcon('info');
    return n;
  }

  // ---------------------------------------------------------------------------
  // Snippet insertion (called by command)
  // ---------------------------------------------------------------------------

  static async insertSnippet(node: DestinationNode): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    let snippet: string;

    if (node.kind === 'btp-destination' && node.data?.destinationName) {
      const name = node.data.destinationName;
      snippet = `\n### ${name}\nGET dest://${name}/\nAccept: application/json\n`;
    } else if (node.kind === 'ms-destination' && node.data?.appId) {
      const app = node.data.appId;
      if (node.data.destinationName) {
        // Known destination name
        const dest = node.data.destinationName;
        snippet = `\n### ${dest} via ${app}\nGET mdk://${app}/${dest}/\nAccept: application/json\n`;
      } else {
        // Template — user fills in destination name
        snippet = `\n### Mobile Services request via ${app}\nGET mdk://${app}/DESTINATION_NAME/\nAccept: application/json\n`;
      }
    } else {
      return;
    }

    if (!editor || editor.document.languageId !== 'dest') {
      // Open a new untitled .dest file with the snippet
      const doc = await vscode.workspace.openTextDocument({
        language: 'dest',
        content: snippet.trimStart(),
      });
      await vscode.window.showTextDocument(doc);
      return;
    }

    // Insert at end of document
    const doc = editor.document;
    const lastLine = doc.lineAt(doc.lineCount - 1);
    const insertPos = lastLine.range.end;

    await editor.edit((editBuilder) => {
      editBuilder.insert(insertPos, snippet);
    });

    // Move cursor to end of inserted text
    const newLastLine = editor.document.lineAt(editor.document.lineCount - 1);
    const newPos = newLastLine.range.end;
    editor.selection = new vscode.Selection(newPos, newPos);
    editor.revealRange(new vscode.Range(newPos, newPos));
  }
}
