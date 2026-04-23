/**
 * SAP BTP Destination Service resolver.
 *
 * Resolves `dest://<DestinationName>/path?query` URLs by calling the
 * Destination Service REST API.
 *
 * Default flow (auto-discovery):
 *   1. Discover the destination service instance from `cf services`.
 *   2. Obtain service-key credentials (client_credentials grant).
 *   3. Fetch an OAuth token from the XSUAA endpoint.
 *   4. Call the Destination Service API with that token.
 *
 * Fallback: if `destinationAnywhere.destinationServiceUrl` is configured, use it
 * together with the `cf oauth-token` (legacy behaviour).
 *
 * Configuration (VS Code settings):
 *   - `destinationAnywhere.destinationServiceUrl`  – optional override URL.
 *   - `destinationAnywhere.destinationCacheTTL`    – cache TTL in seconds (default 300).
 */

import * as vscode from 'vscode';
import {
  getCfOAuthToken,
  findDestinationServiceInstance,
  getServiceKeyCredentials,
  findConnectivityServiceInstance,
  getConnectivityServiceCredentials,
} from './cfCliAuth';
import { isProxyAppDeployed, getProxyAppUrl, getProxyAuthToken } from './proxyApp';
import type { DestServiceCredentials, ConnectivityServiceCredentials } from './cfCliAuth';
import type {
  ResolvedDestination,
  DestinationServiceResponse,
} from '../parser/types';
import { parseDestinationUrl } from '../parser/httpFileParser';
import { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Destination resolution cache (per destination name)
// ---------------------------------------------------------------------------

const cache = new Map<string, ResolvedDestination>();

function getCacheTTL(): number {
  return (
    vscode.workspace
      .getConfiguration('destinationAnywhere')
      .get<number>('destinationCacheTTL') ?? 300
  );
}

function getCached(name: string): ResolvedDestination | undefined {
  const entry = cache.get(name);
  if (!entry) {
    return undefined;
  }
  const ageSeconds = (Date.now() - entry.resolvedAt) / 1000;
  if (ageSeconds > getCacheTTL()) {
    cache.delete(name);
    return undefined;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Service credentials cache (session-scoped)
// ---------------------------------------------------------------------------

let cachedCredentials: DestServiceCredentials | undefined;
let cachedConnectivityCredentials: ConnectivityServiceCredentials | undefined;

/**
 * Auto-discover Destination Service credentials from the CF environment.
 *
 * Results are cached for the lifetime of the session (cleared by
 * `clearDestinationCache`).
 */
async function getDestinationServiceCredentials(): Promise<DestServiceCredentials> {
  if (cachedCredentials) {
    return cachedCredentials;
  }
  const instanceName = await findDestinationServiceInstance();
  cachedCredentials = await getServiceKeyCredentials(instanceName);
  return cachedCredentials;
}

// ---------------------------------------------------------------------------
// OAuth token cache (auto-refreshes on expiry)
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | undefined;
let cachedConnectivityToken: { token: string; expiresAt: number } | undefined;

/**
 * Obtain an OAuth access token for the Destination Service via the
 * `client_credentials` grant.
 *
 * Tokens are cached and refreshed 60 seconds before they expire.
 */
export async function getDestinationServiceToken(
  credentials: DestServiceCredentials,
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const tokenUrl = `${credentials.url}/oauth/token`;
  const basicAuth = Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString('base64');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  if (!data.access_token) {
    throw new Error('OAuth token response did not contain an access_token.');
  }

  const bufferMs = 60_000;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - bufferMs,
  };

  return cachedToken.token;
}

/**
 * Auto-discover Connectivity Service credentials from the CF environment.
 * Cached for the lifetime of the session.
 */
async function getConnectivityServiceCredentialsCached(): Promise<ConnectivityServiceCredentials> {
  if (cachedConnectivityCredentials) {
    return cachedConnectivityCredentials;
  }
  const instanceName = await findConnectivityServiceInstance();
  cachedConnectivityCredentials = await getConnectivityServiceCredentials(instanceName);
  return cachedConnectivityCredentials;
}

/**
 * Obtain an OAuth access token for the Connectivity Service via client_credentials grant.
 * Cached and refreshed 60 seconds before expiry.
 */
async function getConnectivityServiceToken(
  credentials: ConnectivityServiceCredentials,
): Promise<string> {
  if (cachedConnectivityToken && Date.now() < cachedConnectivityToken.expiresAt) {
    return cachedConnectivityToken.token;
  }

  const tokenUrl = `${credentials.url}/oauth/token`;
  const basicAuth = Buffer.from(`${credentials.clientid}:${credentials.clientsecret}`).toString('base64');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Connectivity Service OAuth token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  if (!data.access_token) {
    throw new Error('Connectivity Service OAuth token response did not contain an access_token.');
  }

  const bufferMs = 60_000;
  cachedConnectivityToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - bufferMs,
  };

  return cachedConnectivityToken.token;
}

/** Remove all cached destination resolutions, credentials, and tokens. */
export function clearDestinationCache(): void {
  cache.clear();
  cachedCredentials = undefined;
  cachedConnectivityCredentials = undefined;
  cachedToken = undefined;
  cachedConnectivityToken = undefined;
}

// ---------------------------------------------------------------------------
// Auth-header construction
// ---------------------------------------------------------------------------

/**
 * Build authentication headers from the Destination Service response.
 *
 * The `authTokens` array may contain pre-computed tokens.  If a token entry
 * provides an explicit `http_header`, we use its key/value directly.
 * Otherwise we fall back to `Authorization: {type} {value}`.
 */
export function buildAuthHeaders(
  response: DestinationServiceResponse,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!response.authTokens || response.authTokens.length === 0) {
    return headers;
  }

  for (const token of response.authTokens) {
    if (token.error) {
      throw new Error(
        `Destination auth token error: ${token.error}`,
      );
    }

    if (token.http_header) {
      headers[token.http_header.key] = token.http_header.value;
    } else if (token.type && token.value) {
      headers['Authorization'] = `${token.type} ${token.value}`;
    }
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Internal: call the destination service API
// ---------------------------------------------------------------------------

/**
 * Obtain the bearer token and service base URI for the Destination Service.
 *
 * If `destinationAnywhere.destinationServiceUrl` is configured, fall back to the
 * legacy flow (`cf oauth-token` + that URL).  Otherwise auto-discover
 * everything from the CF environment.
 */
export async function getServiceAccess(): Promise<{ serviceUrl: string; token: string }> {
  const configuredUrl = vscode.workspace
    .getConfiguration('destinationAnywhere')
    .get<string>('destinationServiceUrl');

  if (configuredUrl) {
    // Legacy fallback — use the manually configured URL + cf oauth-token.
    const token = await getCfOAuthToken();
    return { serviceUrl: configuredUrl.replace(/\/+$/, ''), token };
  }

  // Auto-discovery path.
  const credentials = await getDestinationServiceCredentials();
  const token = await getDestinationServiceToken(credentials);
  return { serviceUrl: credentials.uri, token };
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single SAP BTP destination by name.
 *
 * Calls `GET {serviceUrl}/destination-configuration/v1/destinations/{name}`
 * with the appropriate bearer token and returns a {@link ResolvedDestination}.
 */
export async function resolveDestination(
  destinationName: string,
): Promise<ResolvedDestination> {
  // Check cache first
  const cached = getCached(destinationName);
  if (cached) {
    return cached;
  }

  const { serviceUrl, token } = await getServiceAccess();

  const url = `${serviceUrl}/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Destination Service returned ${response.status} ${response.statusText} for "${destinationName}".`);
  }

  const data = await response.json() as DestinationServiceResponse;

  const destConfig = data.destinationConfiguration ?? {};
  const baseUrl = (destConfig['URL'] ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(
      `Destination "${destinationName}" does not contain a URL property.`,
    );
  }

  Logger.debug(`Destination "${destinationName}" ProxyType="${destConfig['ProxyType']}" URL="${baseUrl}"`);

  const authHeaders = buildAuthHeaders(data);

  // Collect any additional headers stored in the destination configuration
  // (keys that start with "URL.headers." are custom headers).
  const additionalHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(destConfig)) {
    if (key.startsWith('URL.headers.')) {
      const headerName = key.slice('URL.headers.'.length);
      additionalHeaders[headerName] = value;
    }
  }

  // Build proxy config for OnPremise destinations using the BTP Connectivity Service.
  // The Connectivity Service acts as an HTTP proxy that tunnels through the Cloud Connector.
  // We fetch its credentials and a bearer token, then route requests through its proxy endpoint.
  //
  // When the on-premise router app is deployed, it handles connectivity internally via
  // Cloud SDK, so we skip the proxy config entirely.
  // When no router is deployed, we attempt to build the proxy config but don't fail if
  // the Connectivity Service is unavailable — the user may have a local Cloud Connector
  // or VPN that can reach the backend directly.
  let proxyConfig: ResolvedDestination['proxyConfig'];
  const routerDeployed = await isProxyAppDeployed();
  if (destConfig['ProxyType'] === 'OnPremise' && !routerDeployed) {
    try {
    const connectivityCreds = await getConnectivityServiceCredentialsCached();
    const connectivityToken = await getConnectivityServiceToken(connectivityCreds);

    const proxyHost = connectivityCreds.onpremise_proxy_host;
    const proxyPort = parseInt(connectivityCreds.onpremise_proxy_port, 10);

    const proxyHeaders: Record<string, string> = {};
    if (destConfig['CloudConnectorLocationId']) {
      proxyHeaders['SAP-Connectivity-SCC-Location_ID'] =
        destConfig['CloudConnectorLocationId'];
    }

    proxyConfig = {
      host: proxyHost,
      port: proxyPort,
      bearerToken: connectivityToken,
      headers: Object.keys(proxyHeaders).length > 0 ? proxyHeaders : undefined,
    };
    } catch (err) {
      // Connectivity Service not available — proceed without proxy config.
      // The request will be sent directly to the destination URL, which works
      // if the user has a local Cloud Connector or VPN.
      Logger.warn(
        `Connectivity Service unavailable for on-premise destination "${destinationName}". ` +
        `Sending request directly. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const resolved: ResolvedDestination = {
    baseUrl,
    authHeaders,
    additionalHeaders,
    proxyConfig,
    isOnPremise: destConfig['ProxyType'] === 'OnPremise',
    resolvedAt: Date.now(),
  };

  cache.set(destinationName, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// List all subaccount destinations (useful for autocomplete)
// ---------------------------------------------------------------------------

/**
 * Retrieve all destinations defined in the subaccount.
 *
 * Calls `GET {uri}/destination-configuration/v1/subaccountDestinations`.
 */
export async function listDestinations(): Promise<Array<{ Name: string; URL: string }>> {
  const { serviceUrl, token } = await getServiceAccess();

  const url = `${serviceUrl}/destination-configuration/v1/subaccountDestinations`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to list destinations: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as Array<Record<string, string>>;

  return data.map((d) => ({ Name: d['Name'] ?? '', URL: d['URL'] ?? '' }));
}

/**
 * Fetch the raw destination configuration from the BTP Destination Service.
 * Returns all key-value pairs as-is (Name, URL, ProxyType, Authentication, etc.).
 */
export async function getDestinationDetails(
  destinationName: string,
): Promise<Record<string, string>> {
  const { serviceUrl, token } = await getServiceAccess();
  const url = `${serviceUrl}/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Destination Service returned ${response.status} for "${destinationName}".`);
  }

  const data = await response.json() as DestinationServiceResponse;
  return data.destinationConfiguration ?? {};
}

/**
 * Resolve a raw `dest://` URL to a concrete HTTP URL, the headers needed
 * to authenticate against the target system, and optional proxy configuration
 * for OnPremise destinations.
 */
export async function resolveDestinationUrl(
  rawUrl: string,
): Promise<{ url: string; headers: Record<string, string>; proxyConfig?: ResolvedDestination['proxyConfig']; viaProxy?: boolean }> {
  const { destinationName, path, queryString } = parseDestinationUrl(rawUrl);
  const destination = await resolveDestination(destinationName);

  const headers: Record<string, string> = {
    ...destination.additionalHeaders,
    ...destination.authHeaders,
  };

  const qs = queryString ? `?${queryString}` : '';

  // On-premise destinations: route through the router app if deployed.
  // The router runs inside CF and can reach the backend via Cloud Connector.
  if (destination.isOnPremise && (await isProxyAppDeployed())) {
    const proxyBaseUrl = getProxyAppUrl()!;
    const proxyToken = await getProxyAuthToken();
    const url = `${proxyBaseUrl}/${encodeURIComponent(destinationName)}${path}${qs}`;
    Logger.info(`Routing on-premise destination "${destinationName}" through router: ${proxyBaseUrl}`);
    // Pass XSUAA token via Authorization header — the Express router extracts the JWT
    // and passes it to Cloud SDK's executeHttpRequest for principal propagation.
    const proxyHeaders: Record<string, string> = {
      ...destination.additionalHeaders,
      'Authorization': `Bearer ${proxyToken}`,
    };
    return { url, headers: proxyHeaders, viaProxy: true };
  }

  const url = `${destination.baseUrl}${path}${qs}`;
  return { url, headers, proxyConfig: destination.proxyConfig };
}
