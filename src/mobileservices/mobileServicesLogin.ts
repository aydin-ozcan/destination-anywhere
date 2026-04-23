/**
 * OAuth2 Authorization Code flow for SAP Mobile Services.
 *
 * Because the Mobile Services App Router requires a user-level token
 * (role collections are assigned to users, not service accounts),
 * we use the Authorization Code flow:
 *   1. Start a local HTTP server on a random port
 *   2. Open the XSUAA login URL in the browser
 *   3. User authenticates via the corporate IdP (SAP IAS)
 *   4. XSUAA redirects to localhost:/callback?code=...
 *   5. Exchange the code for access_token + refresh_token
 *   6. Store in VS Code SecretStorage; refresh silently on expiry
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  // eslint-disable-next-line @typescript-eslint/naming-convention
  token_type: string;
}

export interface OAuthCredentials {
  clientid: string;
  clientsecret: string;
  /** XSUAA base URL (without trailing slash), e.g. https://<zone>.authentication.us10... */
  url: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let secrets: vscode.SecretStorage | undefined;

const BUFFER_MS = 60_000;
const LOGIN_TIMEOUT_MS = 120_000;
const SECRET_KEY_PREFIX = 'mdk_token_';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initMobileServicesLogin(storage: vscode.SecretStorage): void {
  secrets = storage;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a valid access token for the Mobile Services proxy.
 * Reads from SecretStorage, refreshes silently, or triggers browser login.
 */
export async function getMobileServicesToken(
  instanceId: string,
  creds: OAuthCredentials,
): Promise<string> {
  if (!secrets) {
    throw new Error('MobileServicesLogin not initialised — call initMobileServicesLogin() first.');
  }

  // Try stored token
  const stored = await loadStoredToken(instanceId);
  if (stored) {
    if (Date.now() < stored.expiresAt) {
      return stored.accessToken;
    }
    // Try silent refresh
    try {
      const refreshed = await refreshToken(creds, stored.refreshToken);
      await saveStoredToken(instanceId, refreshed);
      return refreshed.accessToken;
    } catch {
      Logger.warn('Mobile Services token refresh failed, re-authenticating.');
    }
  }

  // Full browser login
  return runAuthCodeFlow(instanceId, creds);
}

/**
 * Get a valid access token **without** triggering a browser login.
 * Returns the token if valid or silently refreshable, otherwise throws.
 */
export async function getMobileServicesTokenSilent(
  instanceId: string,
  creds: OAuthCredentials,
): Promise<string> {
  if (!secrets) {
    throw new Error('MobileServicesLogin not initialised — call initMobileServicesLogin() first.');
  }

  const stored = await loadStoredToken(instanceId);
  if (!stored) {
    throw new Error('No Mobile Services token stored. Login required.');
  }

  if (Date.now() < stored.expiresAt) {
    return stored.accessToken;
  }

  // Try silent refresh
  try {
    const refreshed = await refreshToken(creds, stored.refreshToken);
    await saveStoredToken(instanceId, refreshed);
    return refreshed.accessToken;
  } catch {
    throw new Error('Mobile Services token expired and refresh failed. Login required.');
  }
}

/**
 * Check whether a valid token exists for the given instance,
 * **without** triggering a browser login.
 *
 * Returns true only if the token is still valid or can be silently refreshed.
 */
export async function hasMobileServicesToken(
  instanceId: string,
  creds: OAuthCredentials,
): Promise<boolean> {
  if (!secrets) { return false; }
  const stored = await loadStoredToken(instanceId);
  if (!stored) { return false; }

  // Still valid
  if (Date.now() < stored.expiresAt) { return true; }

  // Expired — try silent refresh
  try {
    const refreshed = await refreshToken(creds, stored.refreshToken);
    await saveStoredToken(instanceId, refreshed);
    return true;
  } catch {
    Logger.debug('Mobile Services token expired and refresh failed.');
    return false;
  }
}

/** Remove stored token so the next request triggers a new login. */
export async function clearMobileServicesToken(instanceId: string): Promise<void> {
  if (secrets) {
    await secrets.delete(SECRET_KEY_PREFIX + instanceId);
  }
}

// ---------------------------------------------------------------------------
// Authorization Code Flow
// ---------------------------------------------------------------------------

async function runAuthCodeFlow(instanceId: string, creds: OAuthCredentials): Promise<string> {
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

  Logger.info(`mdk:// Opening browser for Mobile Services login…`);
  Logger.debug(`Auth URL: ${authUri.toString(true)}`);

  await vscode.env.openExternal(authUri);

  vscode.window.showInformationMessage(
    'SAP Mobile Services: A browser window has opened. Please log in to continue.',
  );

  let code: string;
  try {
    code = await waitForCode(server, state, LOGIN_TIMEOUT_MS);
  } finally {
    server.close();
  }

  Logger.debug('mdk:// Authorization code received, exchanging for token…');

  const tokenData = await exchangeCode(creds, code, redirectUri);
  await saveStoredToken(instanceId, tokenData);
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
        reject(new Error('Failed to start callback server.'));
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
      reject(new Error('Mobile Services login timed out. Please try again.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginResultPage(false, `Authentication failed: ${error}`));
          clearTimeout(timer);
          reject(new Error(`Mobile Services login failed: ${error}`));
          return;
        }

        if (!code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginResultPage(false, 'Invalid callback parameters.'));
          clearTimeout(timer);
          reject(new Error('Mobile Services login: invalid state or missing code.'));
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
      background: #f6f8fa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #24292f;
    }
    .card {
      background: white;
      border: 1px solid #d0d7de;
      border-radius: 12px;
      padding: 48px 56px;
      text-align: center;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 1px 3px rgba(27,31,36,0.12);
    }
    .icon { margin-bottom: 20px; }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: ${color};
      margin-bottom: 12px;
    }
    .message {
      font-size: 15px;
      color: #57606a;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .banner {
      background: ${bgColor};
      border: 1px solid ${borderColor};
      border-radius: 6px;
      padding: 10px 16px;
      font-size: 13px;
      color: ${color};
    }
    .app-name {
      font-size: 12px;
      color: #8c959f;
      margin-top: 32px;
      letter-spacing: 0.02em;
    }
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
  creds: OAuthCredentials,
  code: string,
  redirectUri: string,
): Promise<StoredToken> {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: creds.clientid,
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
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as TokenResponse;

  return toStoredToken(data);
}

async function refreshToken(creds: OAuthCredentials, token: string): Promise<StoredToken> {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: creds.clientid,
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
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
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

async function loadStoredToken(instanceId: string): Promise<StoredToken | undefined> {
  if (!secrets) { throw new Error('MobileServicesLogin not initialised — call initMobileServicesLogin() first.'); }
  const raw = await secrets.get(SECRET_KEY_PREFIX + instanceId);
  if (!raw) { return undefined; }
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return undefined;
  }
}

async function saveStoredToken(instanceId: string, token: StoredToken): Promise<void> {
  if (!secrets) { throw new Error('MobileServicesLogin not initialised — call initMobileServicesLogin() first.'); }
  await secrets.store(SECRET_KEY_PREFIX + instanceId, JSON.stringify(token));
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
