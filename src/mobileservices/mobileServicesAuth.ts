/**
 * SAP Mobile Services CF authentication helpers.
 *
 * Reads credentials from the mobile-services CF service key's own `uaa` section —
 * this is the "clone" client registered against the shared Mobile Services XSUAA
 * app and supports the OAuth2 Authorization Code flow.
 *
 * All CF CLI interactions use `child_process.execFile` (no shell).
 */

import { runCf } from '../utils/cf';

const CF_SERVICE_KEY_TIMEOUT_MS = 30_000;
const MS_KEY_NAME = 'destination-anywhere-ms-key';

/** Credentials returned by resolving a Mobile Services app. */
export interface MobileServicesCredentials {
  clientid: string;
  clientsecret: string;
  /** XSUAA base URL (from the mobile-services service key's uaa.url) */
  url: string;
  /** Mobile Services App Router base URL (from the mobile-services service key) */
  uri: string;
  /** CF service instance ID, used as the SecretStorage key for tokens */
  instanceId: string;
  /** Mobile Services Application ID (sap.cloud.service), e.g. "SAM2405.SAM.WIN" */
  applicationId: string;
}

/** Ensure CF CLI is installed and the user is logged in. */
async function ensureCfReady(): Promise<void> {
  try { await runCf(['version']); } catch {
    throw new Error(
      'Cloud Foundry CLI is not installed. ' +
        'Install it from https://github.com/cloudfoundry/cli/releases and try again.',
    );
  }
  try { await runCf(['oauth-token']); } catch {
    throw new Error('You are not logged in to Cloud Foundry. Run `cf login` first.');
  }
}

/** Extract JSON credentials block from `cf service-key` output. */
function parseServiceKeyJson(output: string): Record<string, unknown> {
  const jsonStart = output.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('Could not find JSON credentials in `cf service-key` output.');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output.slice(jsonStart));
  } catch {
    throw new Error('Failed to parse JSON credentials from `cf service-key` output.');
  }
  if (parsed['credentials'] && typeof parsed['credentials'] === 'object') {
    return parsed['credentials'] as Record<string, unknown>;
  }
  return parsed;
}

/** Get or create a service key and return its raw JSON credentials. */
async function getOrCreateServiceKey(
  instanceName: string,
  keyName: string,
): Promise<Record<string, unknown>> {
  const { stdout: keysOutput } = await runCf(
    ['service-keys', instanceName],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  const hasKey = keysOutput.split(/\r?\n/).some((l) => l.trim().startsWith(keyName));

  if (!hasKey) {
    try {
      await runCf(
        ['create-service-key', instanceName, keyName],
        CF_SERVICE_KEY_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to create service key "${keyName}" for instance "${instanceName}": ${msg}`,
      );
    }
  }

  const { stdout: keyOutput } = await runCf(
    ['service-key', instanceName, keyName],
    CF_SERVICE_KEY_TIMEOUT_MS,
  );

  return parseServiceKeyJson(keyOutput);
}

/**
 * Scan `cf services` and return all mobile-services instance names.
 *
 * Returns a Map where keys are mobile-services instance names.
 * Values are the paired xsuaa instance name if one exists (convention:
 * `<ms-instance>-xsuaa`), or an empty string if none is found.
 */
export async function listMobileServicesApps(): Promise<Map<string, string>> {
  await ensureCfReady();
  const { stdout } = await runCf(['services']);

  const msInstances = new Set<string>();
  const xsuaaInstances = new Set<string>();

  let pastHeader = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    if (/^name\s+/i.test(trimmed)) { pastHeader = true; continue; }
    if (!pastHeader) { continue; }

    const columns = trimmed.split(/\s{2,}/);
    if (columns.length < 2) { continue; }
    if (columns[1] === 'mobile-services') { msInstances.add(columns[0]); }
    if (columns[1] === 'xsuaa') { xsuaaInstances.add(columns[0]); }
  }

  // Return all mobile-services instances, noting which ones have a paired xsuaa
  const result = new Map<string, string>();
  for (const ms of msInstances) {
    const xsuaa = `${ms}-xsuaa`;
    result.set(ms, xsuaaInstances.has(xsuaa) ? xsuaa : '');
  }
  return result;
}

/**
 * Find the mobile-services CF instance name that corresponds to the given
 * Mobile Services Application ID (e.g. "SAM2405.SAM.WIN").
 *
 * The CF instance name uses hyphens instead of dots/spaces, so
 * "SAM2405.SAM.WIN" matches CF instance "SAM2405-SAM-WIN".
 */
export async function findMobileServicesInstance(appId: string): Promise<string> {
  const apps = await listMobileServicesApps();

  // Normalise: replace dots and spaces with hyphens for comparison
  const normalise = (s: string) => s.replace(/[.\s]/g, '-').toLowerCase();
  const needle = normalise(appId);

  for (const instanceName of apps.keys()) {
    if (normalise(instanceName) === needle) {
      return instanceName;
    }
  }

  const available = [...apps.keys()].join(', ');
  throw new Error(
    `No Mobile Services CF instance found matching AppId "${appId}". ` +
      `Available instances: ${available || '(none)'}`,
  );
}

/**
 * Get the Mobile Services App Router proxy base URI for the given AppId.
 * Only the mobile-services service key is needed — no XSUAA key required,
 * since authentication is handled via `cf oauth-token`.
 */
export async function getMobileServicesProxyUri(appId: string): Promise<string> {
  await ensureCfReady();

  const msInstanceName = await findMobileServicesInstance(appId);
  const msRaw = await getOrCreateServiceKey(msInstanceName, MS_KEY_NAME);

  const endpoints = msRaw['endpoints'] as Record<string, unknown> | undefined;
  const mobileEndpoint = endpoints?.['mobileservices'] as Record<string, string> | undefined;
  const uri = mobileEndpoint?.['url'];

  if (!uri) {
    throw new Error(
      `Could not find endpoints.mobileservices.url in service key for "${msInstanceName}". ` +
        `Got keys: ${Object.keys(msRaw).join(', ')}`,
    );
  }

  return uri.replace(/\/+$/, '');
}

/**
 * Resolve full credentials for a Mobile Services app (proxy URI + OAuth info).
 * Reads clientid/clientsecret/url from the mobile-services service key's
 * own `uaa` section — this is the "clone" client registered against the
 * shared Mobile Services XSUAA app, which supports the authorization code flow.
 */
export async function getMobileServicesCredentials(
  appId: string,
): Promise<MobileServicesCredentials> {
  await ensureCfReady();

  const msInstanceName = await findMobileServicesInstance(appId);

  // All credentials come from the mobile-services service key
  const msRaw = await getOrCreateServiceKey(msInstanceName, MS_KEY_NAME);

  const endpoints = msRaw['endpoints'] as Record<string, unknown> | undefined;
  const mobileEndpoint = endpoints?.['mobileservices'] as Record<string, string> | undefined;
  const uri = mobileEndpoint?.['url'];

  if (!uri) {
    throw new Error(
      `Could not find endpoints.mobileservices.url in service key for "${msInstanceName}". ` +
        `Got keys: ${Object.keys(msRaw).join(', ')}`,
    );
  }

  // Extract OAuth credentials from the mobile-services key's own uaa section
  const uaa = msRaw['uaa'] as Record<string, string> | undefined;
  const clientid = uaa?.['clientid'];
  const clientsecret = uaa?.['clientsecret'];
  const url = uaa?.['url'];
  const instanceId = uaa?.['serviceInstanceId'] ?? msInstanceName;

  // The Mobile Services Application ID (e.g. "SAM2405.SAM.WIN")
  const applicationId = (msRaw['sap.cloud.service'] as string) ?? msInstanceName;

  if (!clientid || !clientsecret || !url) {
    throw new Error(
      `Could not find uaa.clientid/clientsecret/url in service key for "${msInstanceName}". ` +
        `Got keys: ${Object.keys(msRaw).join(', ')}`,
    );
  }

  return {
    clientid,
    clientsecret,
    url: url.replace(/\/+$/, ''),
    uri: uri.replace(/\/+$/, ''),
    instanceId,
    applicationId,
  };
}

