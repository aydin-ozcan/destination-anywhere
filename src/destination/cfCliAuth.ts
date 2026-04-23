/**
 * Cloud Foundry CLI authentication helpers.
 *
 * All CF CLI interactions use `child_process.execFile` (no shell) to avoid
 * shell-injection risks.
 */

import { runCf } from '../utils/cf';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CF_SERVICE_KEY_TIMEOUT_MS = 30_000;

/** Credentials returned by a Destination Service service-key. */
export interface DestServiceCredentials {
  clientid: string;
  clientsecret: string;
  /** Destination Service API base URL */
  uri: string;
  /** UAA/XSUAA token endpoint base URL */
  url: string;
}

/** Credentials returned by a Connectivity Service service-key. */
export interface ConnectivityServiceCredentials {
  clientid: string;
  clientsecret: string;
  /** UAA/XSUAA token endpoint base URL */
  url: string;
  /** Connectivity Service on-premise proxy host */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  onpremise_proxy_host: string;
  /** Connectivity Service on-premise proxy port */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  onpremise_proxy_port: string;
}

/** Credentials returned by an XSUAA service-key. */
export interface XsuaaCredentials {
  clientid: string;
  clientsecret: string;
  /** XSUAA token endpoint base URL */
  url: string;
}

/**
 * Check whether the `cf` CLI binary is available on the user's PATH.
 */
export async function isCfCliInstalled(): Promise<boolean> {
  try {
    await runCf(['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the user is currently logged in to Cloud Foundry.
 */
export async function isCfLoggedIn(): Promise<boolean> {
  try {
    // `cf oauth-token` validates/refreshes the token, unlike `cf target`
    // which only reads the local config file and succeeds with stale tokens.
    await runCf(['oauth-token']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve the current OAuth bearer token from the CF CLI.
 *
 * `cf oauth-token` returns a string like `bearer eyJhbGci…`.
 * We strip the "bearer " prefix and return only the JWT.
 *
 * @throws If the CF CLI is not installed or the user is not logged in.
 */
export async function getCfOAuthToken(): Promise<string> {
  if (!(await isCfCliInstalled())) {
    throw new Error(
      'Cloud Foundry CLI is not installed. ' +
        'Install it from https://github.com/cloudfoundry/cli/releases and try again.',
    );
  }

  if (!(await isCfLoggedIn())) {
    throw new Error(
      'You are not logged in to Cloud Foundry. Run `cf login` first.',
    );
  }

  const { stdout } = await runCf(['oauth-token']);
  const token = stdout.trim().replace(/^bearer\s+/i, '');
  if (!token) {
    throw new Error('Failed to obtain an OAuth token from `cf oauth-token`.');
  }
  return token;
}

/** Information returned by `cf target`. */
export interface CfApiInfo {
  apiEndpoint: string;
  org: string;
  space: string;
}

/**
 * Parse the output of `cf target` to extract the API endpoint, org, and space.
 */
export async function getCfApiInfo(): Promise<CfApiInfo> {
  if (!(await isCfCliInstalled())) {
    throw new Error(
      'Cloud Foundry CLI is not installed. ' +
        'Install it from https://github.com/cloudfoundry/cli/releases and try again.',
    );
  }

  if (!(await isCfLoggedIn())) {
    throw new Error(
      'You are not logged in to Cloud Foundry. Run `cf login` first.',
    );
  }

  const { stdout } = await runCf(['target']);

  const extract = (label: string): string => {
    const regex = new RegExp(`^${label}:\\s+(.+)$`, 'mi');
    const match = regex.exec(stdout);
    return match ? match[1].trim() : '';
  };

  const apiEndpoint = extract('API endpoint') || extract('api endpoint');
  const org = extract('org');
  const space = extract('space');

  if (!apiEndpoint) {
    throw new Error('Could not parse API endpoint from `cf target` output.');
  }

  return { apiEndpoint, org, space };
}

// ---------------------------------------------------------------------------
// Destination service auto-discovery
// ---------------------------------------------------------------------------

/** Ensure the CF CLI is installed and the user is logged in. */
async function ensureCfReady(): Promise<void> {
  if (!(await isCfCliInstalled())) {
    throw new Error(
      'Cloud Foundry CLI is not installed. ' +
        'Install it from https://github.com/cloudfoundry/cli/releases and try again.',
    );
  }
  if (!(await isCfLoggedIn())) {
    throw new Error(
      'You are not logged in to Cloud Foundry. Run `cf login` first.',
    );
  }
}

const SERVICE_KEY_NAME = 'dest-anywhere-dest-key';

/**
 * Parse `cf services` output to find a service instance with the `destination`
 * service label.
 *
 * If no instance exists, automatically creates one (`dest-anywhere-dest`
 * with the `lite` plan) so that subaccount-level destinations are accessible.
 *
 * @returns The instance name.
 */
export async function findDestinationServiceInstance(): Promise<string> {
  const found = await findDestinationServiceInstanceOrNull();
  if (found) { return found; }

  // No destination service instance exists — auto-create one.
  // This is required even for subaccount-level destinations because the
  // Destination Service REST API needs a service-key for OAuth credentials.
  return createDestinationServiceInstance();
}

/**
 * Scan `cf services` for an existing Destination Service instance.
 * Returns the instance name if found, or `null` if none exists.
 * Does NOT auto-create — safe to call for status checks.
 */
export async function findDestinationServiceInstanceOrNull(): Promise<string | null> {
  await ensureCfReady();

  const { stdout } = await runCf(['services']);

  const lines = stdout.split(/\r?\n/);
  let pastHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    if (/^name\s+/i.test(trimmed)) { pastHeader = true; continue; }
    if (!pastHeader) { continue; }
    const columns = trimmed.split(/\s{2,}/);
    if (columns.length >= 2 && columns[1] === 'destination') {
      return columns[0];
    }
  }

  return null;
}

/**
 * Create a minimal Destination Service instance (`dest-anywhere-dest`, lite plan).
 * Returns the instance name on success or throws with a descriptive error.
 */
export async function createDestinationServiceInstance(
  instanceName = 'dest-anywhere-dest',
): Promise<string> {
  await ensureCfReady();
  try {
    await runCf(
      ['create-service', 'destination', 'lite', instanceName],
      CF_SERVICE_KEY_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create Destination Service instance "${instanceName}": ${msg}. ` +
        'You can create one manually with `cf create-service destination lite my-dest`.',
    );
  }
  return instanceName;
}


/**
 * Extract the JSON credentials from `cf service-key` output.
 *
 * The output contains leading text lines followed by a JSON object.
 * Credentials may be at the top level or nested under a `"credentials"` key.
 */
function parseServiceKeyJson(output: string): Record<string, string> {
  const jsonStart = output.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(
      'Could not find JSON credentials in `cf service-key` output.',
    );
  }
  const jsonStr = output.slice(jsonStart);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      'Failed to parse JSON credentials from `cf service-key` output.',
    );
  }

  // Credentials may be nested under a "credentials" key
  if (parsed['credentials'] && typeof parsed['credentials'] === 'object') {
    return parsed['credentials'] as Record<string, string>;
  }
  return parsed as Record<string, string>;
}

/**
 * Get (or create) a service key for the given destination service instance and
 * return the parsed credentials.
 */
export async function getServiceKeyCredentials(
  instanceName: string,
): Promise<DestServiceCredentials> {
  await ensureCfReady();

  // List existing keys and check for our key.
  const { stdout: keysOutput } = await runCf(
    ['service-keys', instanceName],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const hasKey = keysOutput
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(SERVICE_KEY_NAME));

  if (!hasKey) {
    // Create the key.
    try {
      await runCf(
        ['create-service-key', instanceName, SERVICE_KEY_NAME],
        CF_SERVICE_KEY_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to create service key "${SERVICE_KEY_NAME}" for ` +
          `instance "${instanceName}": ${msg}`,
      );
    }
  }

  // Fetch the key credentials.
  const { stdout: keyOutput } = await runCf(
    ['service-key', instanceName, SERVICE_KEY_NAME],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const raw = parseServiceKeyJson(keyOutput);

  const clientid = raw['clientid'];
  const clientsecret = raw['clientsecret'];
  const uri = raw['uri'];
  const url = raw['url'];

  if (!clientid || !clientsecret || !uri || !url) {
    throw new Error(
      'Destination service-key credentials are incomplete. ' +
        `Expected clientid, clientsecret, uri, and url but got keys: ${Object.keys(raw).join(', ')}`,
    );
  }

  return { clientid, clientsecret, uri: uri.replace(/\/+$/, ''), url: url.replace(/\/+$/, '') };
}

// ---------------------------------------------------------------------------
// Connectivity Service auto-discovery
// ---------------------------------------------------------------------------

const CONNECTIVITY_SERVICE_KEY_NAME = 'dest-anywhere-connectivity-key';

/**
 * Parse `cf services` output to find a service instance with the `connectivity`
 * service label.
 *
 * Unlike the Destination Service, we do NOT auto-create a Connectivity Service
 * instance because it requires a paid plan and specific entitlements.
 *
 * @returns The instance name.
 * @throws If no connectivity service instance is found.
 */
export async function findConnectivityServiceInstance(): Promise<string> {
  const found = await findConnectivityServiceInstanceOrNull();
  if (found) { return found; }

  throw new Error(
    'No Connectivity Service instance found in the current CF space. ' +
      'Create one with `cf create-service connectivity lite my-connectivity-service` ' +
      '(requires the connectivity entitlement in your subaccount).',
  );
}

/**
 * Scan `cf services` for an existing Connectivity Service instance.
 * Returns the instance name if found, or `null` if none exists.
 * Does NOT auto-create — safe to call for status checks.
 */
export async function findConnectivityServiceInstanceOrNull(): Promise<string | null> {
  await ensureCfReady();

  const { stdout } = await runCf(['services']);

  const lines = stdout.split(/\r?\n/);
  let pastHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^name\s+/i.test(trimmed)) {
      pastHeader = true;
      continue;
    }
    if (!pastHeader) {
      continue;
    }
    const columns = trimmed.split(/\s{2,}/);
    if (columns.length >= 2 && columns[1] === 'connectivity') {
      return columns[0];
    }
  }

  return null;
}

/**
 * Create a Connectivity Service instance with the `lite` plan.
 * Returns the instance name on success or throws with a descriptive error.
 */
export async function createConnectivityServiceInstance(
  instanceName = 'dest-anywhere-connectivity',
): Promise<string> {
  await ensureCfReady();
  try {
    await runCf(
      ['create-service', 'connectivity', 'lite', instanceName],
      CF_SERVICE_KEY_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create Connectivity Service instance "${instanceName}": ${msg}.`,
    );
  }
  return instanceName;
}

/**
 * Get (or create) a service key for the given Connectivity Service instance
 * and return the parsed credentials.
 */
export async function getConnectivityServiceCredentials(
  instanceName: string,
): Promise<ConnectivityServiceCredentials> {
  await ensureCfReady();

  const { stdout: keysOutput } = await runCf(
    ['service-keys', instanceName],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const hasKey = keysOutput
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(CONNECTIVITY_SERVICE_KEY_NAME));

  if (!hasKey) {
    try {
      await runCf(
        ['create-service-key', instanceName, CONNECTIVITY_SERVICE_KEY_NAME],
        CF_SERVICE_KEY_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to create service key "${CONNECTIVITY_SERVICE_KEY_NAME}" for ` +
          `instance "${instanceName}": ${msg}`,
      );
    }
  }

  const { stdout: keyOutput } = await runCf(
    ['service-key', instanceName, CONNECTIVITY_SERVICE_KEY_NAME],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const raw = parseServiceKeyJson(keyOutput);

  const clientid = raw['clientid'];
  const clientsecret = raw['clientsecret'];
  const url = raw['url'];
  /* eslint-disable @typescript-eslint/naming-convention */
  const onpremise_proxy_host = raw['onpremise_proxy_host'];
  const onpremise_proxy_port = raw['onpremise_proxy_port'];
  /* eslint-enable @typescript-eslint/naming-convention */

  if (!clientid || !clientsecret || !url || !onpremise_proxy_host || !onpremise_proxy_port) {
    throw new Error(
      'Connectivity service-key credentials are incomplete. ' +
        'Expected clientid, clientsecret, url, onpremise_proxy_host, onpremise_proxy_port ' +
        `but got: ${JSON.stringify(raw)}`,
    );
  }

  /* eslint-disable @typescript-eslint/naming-convention */
  return { clientid, clientsecret, url: url.replace(/\/+$/, ''), onpremise_proxy_host, onpremise_proxy_port };
  /* eslint-enable @typescript-eslint/naming-convention */
}

// ---------------------------------------------------------------------------
// XSUAA Service auto-discovery (for proxy app)
// ---------------------------------------------------------------------------

const XSUAA_INSTANCE_NAME = 'dest-anywhere-xsuaa';
const XSUAA_SERVICE_KEY_NAME = 'dest-anywhere-xsuaa-key';

/**
 * Scan `cf services` for the proxy-specific XSUAA instance.
 * Returns the instance name if found, or `null` if none exists.
 */
export async function findXsuaaInstanceOrNull(): Promise<string | null> {
  await ensureCfReady();

  const { stdout } = await runCf(['services']);

  const lines = stdout.split(/\r?\n/);
  let pastHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    if (/^name\s+/i.test(trimmed)) { pastHeader = true; continue; }
    if (!pastHeader) { continue; }
    const columns = trimmed.split(/\s{2,}/);
    if (columns.length >= 1 && columns[0] === XSUAA_INSTANCE_NAME) {
      return columns[0];
    }
  }

  return null;
}

/**
 * Create a minimal XSUAA instance for the proxy app.
 * Uses the `application` plan with a bare-minimum xs-security.json.
 */
export async function createXsuaaInstance(
  instanceName = XSUAA_INSTANCE_NAME,
): Promise<string> {
  await ensureCfReady();

  const xsSecurity = {
    xsappname: 'dest-anywhere-proxy',
    'tenant-mode': 'dedicated',
    scopes: [],
    'role-templates': [],
    'oauth2-configuration': {
      'redirect-uris': ['http://localhost:*/**'],
      'grant-types': ['authorization_code', 'refresh_token', 'client_credentials'],
    },
  };

  // Write config to a temp file to avoid shell-quoting issues across platforms.
  const tmpFile = path.join(os.tmpdir(), `dest-anywhere-xsuaa-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(xsSecurity));
    await runCf(
      ['create-service', 'xsuaa', 'application', instanceName, '-c', tmpFile],
      CF_SERVICE_KEY_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to create XSUAA instance "${instanceName}": ${msg}.`,
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
  return instanceName;
}

/**
 * Get (or create) a service key for the given XSUAA instance and return
 * the parsed credentials (clientid, clientsecret, url).
 */
export async function getXsuaaCredentials(
  instanceName: string,
): Promise<XsuaaCredentials> {
  await ensureCfReady();

  const { stdout: keysOutput } = await runCf(
    ['service-keys', instanceName],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const hasKey = keysOutput
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(XSUAA_SERVICE_KEY_NAME));

  if (!hasKey) {
    try {
      await runCf(
        ['create-service-key', instanceName, XSUAA_SERVICE_KEY_NAME],
        CF_SERVICE_KEY_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to create service key "${XSUAA_SERVICE_KEY_NAME}" for ` +
          `instance "${instanceName}": ${msg}`,
      );
    }
  }

  const { stdout: keyOutput } = await runCf(
    ['service-key', instanceName, XSUAA_SERVICE_KEY_NAME],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const raw = parseServiceKeyJson(keyOutput);

  const clientid = raw['clientid'];
  const clientsecret = raw['clientsecret'];
  const url = raw['url'];

  if (!clientid || !clientsecret || !url) {
    throw new Error(
      'XSUAA service-key credentials are incomplete. ' +
        `Expected clientid, clientsecret, and url but got: ${JSON.stringify(raw)}`,
    );
  }

  return { clientid, clientsecret, url: url.replace(/\/+$/, '') };
}

