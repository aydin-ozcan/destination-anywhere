/**
 * SAP Mobile Services URL resolver.
 *
 * Resolves `mdk://AppId/DestinationName/path?query` URLs by routing through
 * the Mobile Services backend proxy.
 *
 * Auth flow (OAuth2 Authorization Code):
 *   1. On first use, open a browser window → user logs in via corporate IdP
 *   2. XSUAA redirects to localhost callback with an authorization code
 *   3. Exchange code for access_token + refresh_token (stored in SecretStorage)
 *   4. Subsequent requests use the stored token (silently refreshed on expiry)
 *
 * URL format:
 *   mdk://AppId/DestinationName/relative/path?query
 * Resolved to:
 *   https://<proxy-uri>/<DestinationName>/relative/path?query
 *
 * Configuration (VS Code settings):
 *   - `destinationAnywhere.mobileServicesUrl` – optional override for the MS base URL.
 */

import * as vscode from 'vscode';
import {
  getMobileServicesCredentials,
  getMobileServicesProxyUri,
} from './mobileServicesAuth';
import type { MobileServicesCredentials } from './mobileServicesAuth';
import { getMobileServicesToken, getMobileServicesTokenSilent, clearMobileServicesToken } from './mobileServicesLogin';
import { parseMobileServicesUrl } from '../parser/httpFileParser';
import { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const cachedUris = new Map<string, string>();
const cachedCredentials = new Map<string, MobileServicesCredentials>();

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Clear all cached Mobile Services data (URIs, credentials, and stored tokens). */
export async function clearMobileServicesCache(): Promise<void> {
  for (const creds of cachedCredentials.values()) {
    await clearMobileServicesToken(creds.instanceId);
  }
  cachedUris.clear();
  cachedCredentials.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getProxyUri(appId: string): Promise<string> {
  const cached = cachedUris.get(appId);
  if (cached) { return cached; }

  const configuredUrl = vscode.workspace
    .getConfiguration('destinationAnywhere')
    .get<string>('mobileServicesUrl');

  const uri = configuredUrl
    ? configuredUrl.replace(/\/+$/, '')
    : await getMobileServicesProxyUri(appId);

  cachedUris.set(appId, uri);
  return uri;
}

async function getCredentials(appId: string): Promise<MobileServicesCredentials> {
  const cached = cachedCredentials.get(appId);
  if (cached) { return cached; }
  const creds = await getMobileServicesCredentials(appId);
  cachedCredentials.set(appId, creds);
  return creds;
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw `mdk://` URL to a concrete HTTPS URL and the Bearer auth header
 * needed to call the Mobile Services proxy.
 */
export async function resolveMobileServicesUrl(
  rawUrl: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const { appId, destinationName, path, queryString } = parseMobileServicesUrl(rawUrl);

  const [uri, creds] = await Promise.all([
    getProxyUri(appId),
    getCredentials(appId),
  ]);

  const token = await getMobileServicesToken(creds.instanceId, {
    clientid: creds.clientid,
    clientsecret: creds.clientsecret,
    url: creds.url,
  });

  // URL format from DevTools: /<DestinationName>/<path> (no AppId in path)
  const url = `${uri}/${encodeURIComponent(destinationName)}${path}${queryString}`;

  Logger.debug(`mdk:// resolved → ${url}`);

  return {
    url,
    headers: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      Authorization: `Bearer ${token}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Destination discovery via OData Endpoints API
// ---------------------------------------------------------------------------

/**
 * List configured destination names for a Mobile Services app by calling the
 * OData Application Connections API:
 *   GET /odata/applications/v1/<applicationId>/Endpoints
 *
 * Uses the silent token getter — will NOT trigger a browser login.
 * Throws if the user is not authenticated.
 */
export async function listMobileServicesDestinations(appId: string): Promise<string[]> {
  const [uri, creds] = await Promise.all([
    getProxyUri(appId),
    getCredentials(appId),
  ]);

  const token = await getMobileServicesTokenSilent(creds.instanceId, {
    clientid: creds.clientid,
    clientsecret: creds.clientsecret,
    url: creds.url,
  });

  // Use the Mobile Services Application ID (sap.cloud.service, e.g. "SAM2405.SAM.WIN")
  // — NOT the CF instance name (e.g. "SAM2405-SAM-WIN").
  const msAppId = creds.applicationId;
  const endpointsUrl = `${uri}/odata/applications/v1/${encodeURIComponent(msAppId)}/Endpoints`;
  Logger.debug(`mdk:// Fetching endpoints from ${endpointsUrl}`);

  try {
    const resp = await fetch(endpointsUrl, {
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Authorization': `Bearer ${token}`,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }

    const respData = await resp.json() as { d?: { results?: Array<{ EndpointName?: string }> }; value?: Array<{ EndpointName?: string }> };

    // OData v2 responses wrap results in { d: { results: [...] } }
    const results: Array<{ EndpointName?: string }> =
      respData?.d?.results ?? respData?.value ?? [];

    const names = results
      .map((e) => e.EndpointName)
      .filter((n): n is string => !!n);

    Logger.info(`mdk:// Found ${names.length} destinations for "${msAppId}": ${names.join(', ')}`);
    return names;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Logger.warn(`mdk:// Failed to list destinations for "${msAppId}": ${msg}`);
    throw new Error(`Failed to list Mobile Services destinations: ${msg}`);
  }
}
