/**
 * On-Premise Router App management.
 *
 * Deploys and manages a lightweight Express application in the user's
 * CF space that routes requests to on-premise destinations via the
 * SAP Cloud SDK and Cloud Connector.
 *
 * The router app uses a single catch-all route so that all on-premise
 * destinations are accessible through one deployed app:
 *   https://<router-url>/<DestinationName>/<path>
 */

import { execFile } from 'child_process';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import {
  findConnectivityServiceInstanceOrNull,
  createConnectivityServiceInstance,
  findXsuaaInstanceOrNull,
  createXsuaaInstance,
  getXsuaaCredentials,
} from './cfCliAuth';
import type { XsuaaCredentials } from './cfCliAuth';

const PROXY_APP_NAME = 'dest-anywhere-router';
const CF_PUSH_TIMEOUT_MS = 300_000; // 5 minutes for cf push (npm install + staging)
const CF_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let proxyAppUrl: string | undefined;
let proxyDeployed: boolean | undefined;
/** Cached XSUAA credentials for the proxy app */
let cachedXsuaaCreds: XsuaaCredentials | undefined;

/** Extension install path — set via initProxyLogin. */
let extensionPath: string | undefined;

// ---------------------------------------------------------------------------
// SecretStorage for user token persistence
// ---------------------------------------------------------------------------

let secrets: vscode.SecretStorage | undefined;
const SECRET_KEY = 'proxy_user_token';
const BUFFER_MS = 60_000;
const LOGIN_TIMEOUT_MS = 120_000;

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  access_token: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  refresh_token: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  expires_in: number;
}

/**
 * Initialise the proxy login module with VS Code SecretStorage.
 * Must be called at extension activation.
 */
export function initProxyLogin(storage: vscode.SecretStorage, extPath?: string): void {
  secrets = storage;
  if (extPath) {
    extensionPath = extPath;
  }
}

/** Promisified wrapper around execFile. */
function runCf(
  args: string[],
  timeoutMs: number = CF_TIMEOUT_MS,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('cf', args, { timeout: timeoutMs, cwd, shell: process.platform === 'win32' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check whether the proxy app is deployed and running in the current CF space.
 * Caches the result and the app URL.
 */
export async function isProxyAppDeployed(): Promise<boolean> {
  if (proxyDeployed !== undefined) {
    return proxyDeployed;
  }

  try {
    const { stdout } = await runCf(['app', PROXY_APP_NAME]);

    // Verify the app is actually running — not crashed or stopped.
    // `cf app` exits 0 even for crashed apps, so we must inspect the output.
    const stateMatch = /requested state:\s+(\S+)/i.exec(stdout);
    if (stateMatch && stateMatch[1].toLowerCase() !== 'started') {
      Logger.warn(`On-premise proxy app exists but is ${stateMatch[1]}, not started.`);
      proxyDeployed = false;
      proxyAppUrl = undefined;
      return false;
    }

    // Check that at least one instance is running (not all crashed)
    const instanceMatch = /instances:\s+(\d+)\/(\d+)/i.exec(stdout);
    if (instanceMatch && parseInt(instanceMatch[1], 10) === 0) {
      Logger.warn('On-premise proxy app exists but has 0 running instances (crashed).');
      proxyDeployed = false;
      proxyAppUrl = undefined;
      return false;
    }

    // Parse the route from cf app output. The "routes:" line contains the URL.
    const routeMatch = /routes:\s+(\S+)/i.exec(stdout);
    if (routeMatch) {
      const route = routeMatch[1];
      proxyAppUrl = route.startsWith('http') ? route : `https://${route}`;
    }

    proxyDeployed = true;
    Logger.info(`On-premise proxy app detected at ${proxyAppUrl}`);
    return true;
  } catch {
    proxyDeployed = false;
    proxyAppUrl = undefined;
    return false;
  }
}

/**
 * Return the cached proxy app URL, or undefined if not deployed.
 */
export function getProxyAppUrl(): string | undefined {
  return proxyAppUrl;
}

/**
 * Clear cached proxy app state (called when destination cache is cleared).
 */
export async function clearProxyAppCache(): Promise<void> {
  proxyDeployed = undefined;
  proxyAppUrl = undefined;
  cachedXsuaaCreds = undefined;
  if (secrets) {
    await secrets.delete(SECRET_KEY);
  }
}

/**
 * Delete the on-premise router app and its dedicated service instances
 * (connectivity + xsuaa) from the current CF space.
 * Only deletes instances with our exact names. The Destination Service
 * instance is kept — it's needed for resolving dest:// URLs.
 */
export async function uninstallProxyApp(): Promise<void> {
  // 1. Delete the app (and routes)
  await runCf(['delete', PROXY_APP_NAME, '-f', '-r'], 60_000);
  Logger.info(`Deleted app "${PROXY_APP_NAME}".`);

  // 2. Delete XSUAA service key + instance (only our exact names)
  const xsuaaKey = 'dest-anywhere-xsuaa-key';
  const xsuaaInstance = 'dest-anywhere-xsuaa';
  try {
    await runCf(['delete-service-key', xsuaaInstance, xsuaaKey, '-f'], 30_000);
    Logger.info(`Deleted service key "${xsuaaKey}".`);
  } catch { /* key may not exist */ }
  try {
    await runCf(['delete-service', xsuaaInstance, '-f'], 60_000);
    Logger.info(`Deleted service instance "${xsuaaInstance}".`);
  } catch { /* instance may not exist */ }

  // 3. Delete Connectivity service key + instance (only our exact names)
  const connKey = 'dest-anywhere-connectivity-key';
  const connInstance = 'dest-anywhere-connectivity';
  try {
    await runCf(['delete-service-key', connInstance, connKey, '-f'], 30_000);
    Logger.info(`Deleted service key "${connKey}".`);
  } catch { /* key may not exist */ }
  try {
    await runCf(['delete-service', connInstance, '-f'], 60_000);
    Logger.info(`Deleted service instance "${connInstance}".`);
  } catch { /* instance may not exist */ }

  proxyDeployed = false;
  proxyAppUrl = undefined;
  cachedXsuaaCreds = undefined;
  Logger.info('On-premise router app and related services cleaned up.');
}

// ---------------------------------------------------------------------------
// Proxy auth token (Authorization Code flow for user identity propagation)
// ---------------------------------------------------------------------------

const XSUAA_INSTANCE_NAME = 'dest-anywhere-xsuaa';

/**
 * Check whether a valid proxy token exists (without triggering login).
 * Returns true if a stored token is still valid or can be silently refreshed.
 */
export async function hasProxyToken(): Promise<boolean> {
  if (!secrets) { return false; }

  const stored = await loadStoredToken();
  if (!stored) { return false; }

  // Still valid
  if (Date.now() < stored.expiresAt) { return true; }

  // Expired — try silent refresh
  try {
    if (!cachedXsuaaCreds) {
      cachedXsuaaCreds = await getXsuaaCredentials(XSUAA_INSTANCE_NAME);
    }
    const refreshed = await refreshTokenFlow(cachedXsuaaCreds, stored.refreshToken);
    await saveStoredToken(refreshed);
    return true;
  } catch {
    Logger.debug('Proxy token expired and refresh failed.');
    return false;
  }
}

/**
 * Obtain a user-level access token for the proxy app's XSUAA instance.
 *
 * Uses an Authorization Code flow so the resulting JWT carries the real
 * user identity  which the approuter can then
 * forward as a principal for PrincipalPropagation destinations.
 *
 * Tokens are persisted in VS Code SecretStorage and refreshed silently.
 */
export async function getProxyAuthToken(): Promise<string> {
  if (!secrets) {
    throw new Error('Proxy login not initialised — call initProxyLogin() first.');
  }

  // Get or cache XSUAA credentials
  if (!cachedXsuaaCreds) {
    cachedXsuaaCreds = await getXsuaaCredentials(XSUAA_INSTANCE_NAME);
  }

  // Try stored token
  const stored = await loadStoredToken();
  if (stored) {
    if (Date.now() < stored.expiresAt) {
      return stored.accessToken;
    }
    // Try silent refresh
    try {
      const refreshed = await refreshTokenFlow(cachedXsuaaCreds, stored.refreshToken);
      await saveStoredToken(refreshed);
      Logger.debug('Proxy XSUAA token refreshed silently.');
      return refreshed.accessToken;
    } catch {
      Logger.warn('Proxy XSUAA token refresh failed, re-authenticating via browser.');
    }
  }

  // Full browser login
  return runProxyAuthCodeFlow(cachedXsuaaCreds);
}

// ---------------------------------------------------------------------------
// Authorization Code Flow
// ---------------------------------------------------------------------------

async function runProxyAuthCodeFlow(creds: XsuaaCredentials): Promise<string> {
  const { port, server } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomHex(16);

  // Build the query with percent-encoding, then use Uri.from() so that
  // openExternal preserves the encoding.  Uri.parse() would decode %7C (|)
  // and %3A%2F%2F (://) causing XSUAA to reject the request with HTTP 400.
  const query =
    `response_type=code` +
    `&client_id=${encodeURIComponent(creds.clientid)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=openid` +
    `&prompt=login` +
    `&state=${state}`;
  const base = new URL(creds.url);
  const authUri = vscode.Uri.from({
    scheme: base.protocol.replace(':', ''),
    authority: base.host,
    path: '/oauth/authorize',
    query,
  });

  Logger.info('Opening browser for on-premise proxy login…');

  await vscode.env.openExternal(authUri);
  vscode.window.showInformationMessage(
    'Destination Anywhere: A browser window has opened. Please log in to access on-premise destinations.',
  );

  let code: string;
  try {
    code = await waitForCode(server, state, LOGIN_TIMEOUT_MS);
  } finally {
    server.close();
  }

  Logger.debug('Proxy authorization code received, exchanging for token…');

  const tokenData = await exchangeCode(creds, code, redirectUri);
  await saveStoredToken(tokenData);
  Logger.info('Proxy user token obtained and stored.');
  return tokenData.accessToken;
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

function startCallbackServer(): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start proxy login callback server.'));
        return;
      }
      resolve({ port: addr.port, server });
    });
    server.on('error', reject);
  });
}

function waitForCode(
  server: http.Server,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('On-premise proxy login timed out. Please try again.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginResultPage(false, `Authentication failed: ${error}`));
          clearTimeout(timer);
          reject(new Error(`Proxy login failed: ${error}`));
          return;
        }

        if (!code || returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginResultPage(false, 'Invalid callback parameters.'));
          clearTimeout(timer);
          reject(new Error('Proxy login: invalid state or missing code.'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginResultPage(true, 'You can close this tab and return to VS Code.'));
        clearTimeout(timer);
        resolve(code);
      } catch (err) {
        res.writeHead(500);
        res.end();
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function loginResultPage(success: boolean, message: string): string {
  const safeMessage = escapeHtml(message);
  const title = success ? 'Login Successful' : 'Login Failed';
  const color = success ? '#1a7f37' : '#cf222e';
  const bgColor = success ? '#dafbe1' : '#ffebe9';
  const borderColor = success ? '#2da44e' : '#ff8182';
  const icon = success ? `
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="12" fill="#2da44e"/>
      <path d="M6 12.5l4 4 8-8" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>` : `
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="12" fill="#cf222e"/>
      <path d="M8 8l8 8M16 8l-8 8" stroke="white" stroke-width="2.2" stroke-linecap="round"/>
    </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Destination Anywhere — ${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #f6f8fa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; color: #24292f;
    }
    .card {
      background: white; border: 1px solid #d0d7de; border-radius: 12px;
      padding: 48px 56px; text-align: center; max-width: 440px; width: 100%;
      box-shadow: 0 1px 3px rgba(27,31,36,0.12);
    }
    .icon { margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 600; color: ${color}; margin-bottom: 12px; }
    .message { font-size: 15px; color: #57606a; line-height: 1.5; margin-bottom: 24px; }
    .banner {
      background: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 6px;
      padding: 10px 16px; font-size: 13px; color: ${color};
    }
    .app-name { font-size: 12px; color: #8c959f; margin-top: 32px; letter-spacing: 0.02em; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p class="message">${safeMessage}</p>
    <div class="banner">${success
      ? 'Your session token has been saved. You can now close this window.'
      : 'Please return to VS Code and try again.'
    }</div>
    <p class="app-name">Destination Anywhere for VS Code</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

async function exchangeCode(
  creds: XsuaaCredentials,
  code: string,
  redirectUri: string,
): Promise<StoredToken> {
  const params = new URLSearchParams({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    grant_type: 'authorization_code',
    code,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    redirect_uri: redirectUri,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_id: creds.clientid,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_secret: creds.clientsecret,
  });

  const response = await fetch(
    `${creds.url}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Proxy token exchange failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as TokenResponse;
  return toStoredToken(data);
}

async function refreshTokenFlow(
  creds: XsuaaCredentials,
  token: string,
): Promise<StoredToken> {
  const params = new URLSearchParams({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    grant_type: 'refresh_token',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    refresh_token: token,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_id: creds.clientid,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_secret: creds.clientsecret,
  });

  const response = await fetch(
    `${creds.url}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Proxy token refresh failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as TokenResponse;
  return toStoredToken(data);
}

function toStoredToken(data: TokenResponse): StoredToken {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - BUFFER_MS,
  };
}

// ---------------------------------------------------------------------------
// SecretStorage helpers
// ---------------------------------------------------------------------------

async function loadStoredToken(): Promise<StoredToken | undefined> {
  if (!secrets) { throw new Error('ProxyLogin not initialised — call initProxyLogin() first.'); }
  const raw = await secrets.get(SECRET_KEY);
  if (!raw) { return undefined; }
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return undefined;
  }
}

async function saveStoredToken(token: StoredToken): Promise<void> {
  if (!secrets) { throw new Error('ProxyLogin not initialised — call initProxyLogin() first.'); }
  await secrets.store(SECRET_KEY, JSON.stringify(token));
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploy the on-premise router app to the current CF space.
 *
 * Copies the pre-built router-app/ from the extension directory, generates
 * a manifest.yml with the correct service bindings, and runs `cf push`.
 *
 * The router source code is fully visible in the repository under `router-app/`.
 *
 * @param destServiceInstanceName The name of the existing destination service
 *   instance to bind to (e.g. "destination-anywhere-dest").
 * @returns The URL of the deployed router app.
 */
export async function deployProxyApp(
  destServiceInstanceName: string,
): Promise<string> {
  if (!extensionPath) {
    throw new Error('Extension path not set — call initProxyLogin() first.');
  }

  const routerAppSrc = path.join(extensionPath, 'router-app');
  if (!fs.existsSync(path.join(routerAppSrc, 'server.js'))) {
    throw new Error(`Router app source not found at ${routerAppSrc}. The extension may be corrupted.`);
  }

  const tmpDir = path.join(os.tmpdir(), PROXY_APP_NAME);

  // Ensure clean temp directory
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Copy router-app source files
    fs.copyFileSync(path.join(routerAppSrc, 'package.json'), path.join(tmpDir, 'package.json'));
    fs.copyFileSync(path.join(routerAppSrc, 'server.js'), path.join(tmpDir, 'server.js'));

    // 2. Find or create a connectivity service instance
    Logger.info('Looking for existing connectivity service instance…');
    let connectivityInstanceName = await findConnectivityServiceInstanceOrNull();
    if (connectivityInstanceName) {
      Logger.info(`Reusing existing connectivity service instance: ${connectivityInstanceName}`);
    } else {
      Logger.info('No connectivity service instance found — creating one…');
      connectivityInstanceName = await createConnectivityServiceInstance();
      Logger.info(`Created connectivity service instance: ${connectivityInstanceName}`);
    }

    // 3. Find or create an XSUAA instance for the router app
    Logger.info('Looking for existing XSUAA instance…');
    let xsuaaInstanceName = await findXsuaaInstanceOrNull();
    if (xsuaaInstanceName) {
      Logger.info(`Reusing existing XSUAA instance: ${xsuaaInstanceName}`);
    } else {
      Logger.info('No XSUAA instance found — creating one…');
      xsuaaInstanceName = await createXsuaaInstance();
      Logger.info(`Created XSUAA instance: ${xsuaaInstanceName}`);
    }

    // 4. Generate manifest.yml with dynamic service bindings
    const manifest = [
      '---',
      'applications:',
      `  - name: ${PROXY_APP_NAME}`,
      '    memory: 256M',
      '    disk_quota: 512M',
      '    instances: 1',
      '    random-route: true',
      '    buildpacks:',
      '      - nodejs_buildpack',
      '    services:',
      `      - ${destServiceInstanceName}`,
      `      - ${connectivityInstanceName}`,
      `      - ${xsuaaInstanceName}`,
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'manifest.yml'), manifest);

    // 5. cf push
    Logger.info(`Deploying ${PROXY_APP_NAME} from ${tmpDir}…`);
    const { stdout } = await runCf(['push'], CF_PUSH_TIMEOUT_MS, tmpDir);

    // Parse the route from cf push output
    const routeMatch = /routes:\s+(\S+)/i.exec(stdout);
    let url: string;
    if (routeMatch) {
      const route = routeMatch[1];
      url = route.startsWith('http') ? route : `https://${route}`;
    } else {
      // Fallback — query the app directly
      const { stdout: appOutput } = await runCf(['app', PROXY_APP_NAME]);
      const appRouteMatch = /routes:\s+(\S+)/i.exec(appOutput);
      if (appRouteMatch) {
        const route = appRouteMatch[1];
        url = route.startsWith('http') ? route : `https://${route}`;
      } else {
        throw new Error('Router app deployed but could not determine its URL.');
      }
    }

    // Update cache
    proxyAppUrl = url;
    proxyDeployed = true;
    Logger.info(`On-premise router app deployed at ${url}`);

    return url;
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
