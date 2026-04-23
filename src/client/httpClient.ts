import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { HttpRequest, HttpResponse, RequestBlock } from '../parser/types';
import { Logger } from '../utils/logger';

const MAX_REDIRECTS = 5;

/** Headers that must be stripped on cross-origin redirects. */
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/**
 * Send an HTTP request and return a structured HttpResponse.
 */
export async function sendRequest(
  request: HttpRequest,
  cancellationToken?: vscode.CancellationToken
): Promise<HttpResponse> {
  const abortController = new AbortController();
  let disposable: vscode.Disposable | undefined;

  if (cancellationToken) {
    if (cancellationToken.isCancellationRequested) {
      throw new Error('Request was cancelled');
    }
    disposable = cancellationToken.onCancellationRequested(() => {
      abortController.abort();
    });
  }

  const startTime = Date.now();

  try {
    const result = request.proxyConfig
      ? await sendViaProxy(request, abortController.signal)
      : await sendNodeRequest(request, abortController.signal);

    const elapsedTime = Date.now() - startTime;

    return { ...result, elapsedTime };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request was cancelled');
    }
    throw error;
  } finally {
    disposable?.dispose();
  }
}

/**
 * Build an HttpRequest from a parsed RequestBlock, a resolved URL,
 * and any additional headers (e.g. auth headers from destination resolution).
 */
export function buildHttpRequest(
  block: RequestBlock,
  resolvedUrl: string,
  additionalHeaders: Record<string, string>,
  proxyConfig?: HttpRequest['proxyConfig'],
): HttpRequest {
  const config = vscode.workspace.getConfiguration('destinationAnywhere');
  const timeout = config.get<number>('timeout', 30000);
  const followRedirects = config.get<boolean>('followRedirects', true);
  const rejectUnauthorized = config.get<boolean>('rejectUnauthorized', true);
  const defaultHeaders = config.get<Record<string, string>>('defaultHeaders', {});

  const headers: Record<string, string> = {
    ...defaultHeaders,
    ...additionalHeaders,
    ...block.headers,
  };

  return {
    method: block.method,
    url: resolvedUrl,
    headers,
    body: block.body,
    timeout,
    followRedirects,
    rejectUnauthorized,
    proxyConfig,
  };
}

// ---------------------------------------------------------------------------
// Internal response shape (without elapsedTime — added by sendRequest)
// ---------------------------------------------------------------------------

type NodeResponse = Omit<HttpResponse, 'elapsedTime'>;

// ---------------------------------------------------------------------------
// Direct request (no proxy)
// ---------------------------------------------------------------------------

async function sendNodeRequest(
  request: HttpRequest,
  signal: AbortSignal,
  redirectCount = 0,
): Promise<NodeResponse> {
  const url = new URL(request.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<NodeResponse>((resolve, reject) => {
    const headers = { ...request.headers };
    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf-8'));
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: request.method,
      headers,
      timeout: request.timeout,
      signal,
    };

    if (isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = request.rejectUnauthorized;
    }

    const req = transport.request(options, (res) => {
      // Handle redirects
      if (
        request.followRedirects &&
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`Maximum redirects (${MAX_REDIRECTS}) exceeded`));
          res.resume();
          return;
        }

        const redirectUrl = new URL(res.headers.location, request.url);
        const originalUrl = new URL(request.url);
        const crossOrigin = redirectUrl.origin !== originalUrl.origin;

        // Strip sensitive headers on cross-origin redirect
        const redirectHeaders = crossOrigin
          ? stripSensitiveHeaders(request.headers)
          : request.headers;

        // 301/302/303 change method to GET (except HEAD)
        const method = [301, 302, 303].includes(res.statusCode!) && request.method !== 'HEAD'
          ? 'GET' as const
          : request.method;

        res.resume();
        sendNodeRequest(
          {
            ...request,
            url: redirectUrl.toString(),
            method,
            headers: redirectHeaders,
            body: method === 'GET' ? undefined : request.body,
          },
          signal,
          redirectCount + 1,
        ).then(resolve, reject);
        return;
      }

      collectResponse(res).then(resolve, reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${request.timeout}ms`));
    });

    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      req.write(request.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Proxy request (OnPremise destinations via BTP Connectivity Service)
// ---------------------------------------------------------------------------

async function sendViaProxy(
  request: HttpRequest,
  signal: AbortSignal,
): Promise<NodeResponse> {
  const { proxyConfig } = request;
  if (!proxyConfig) {
    throw new Error('proxyConfig is required for proxy requests');
  }

  const targetUrl = new URL(request.url);
  const isHttps = targetUrl.protocol === 'https:';

  Logger.debug(`OnPremise proxy: ${proxyConfig.host}:${proxyConfig.port} (token length: ${proxyConfig.bearerToken?.length ?? 0})`);

  if (isHttps) {
    Logger.debug('Establishing CONNECT tunnel for HTTPS target');
    return sendHttpsViaConnectProxy(request, signal);
  } else {
    Logger.debug('Using forward proxy for HTTP target');
    return sendHttpViaProxy(request, signal);
  }
}

/**
 * Send an HTTP request via a forward proxy.
 * The full target URL is used as the request path.
 */
async function sendHttpViaProxy(
  request: HttpRequest,
  signal: AbortSignal,
): Promise<NodeResponse> {
  const { proxyConfig } = request;
  const targetUrl = new URL(request.url);

  return new Promise<NodeResponse>((resolve, reject) => {
    const headers: Record<string, string> = {
      ...request.headers,
      host: targetUrl.host,
      'proxy-authorization': `Bearer ${proxyConfig!.bearerToken}`,
      ...(proxyConfig!.headers || {}),
    };

    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf-8'));
    }

    const req = http.request(
      {
        hostname: proxyConfig!.host,
        port: proxyConfig!.port,
        path: request.url,
        method: request.method,
        headers,
        timeout: request.timeout,
        signal,
      },
      (res) => { collectResponse(res).then(resolve, reject); },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${request.timeout}ms`));
    });

    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      req.write(request.body);
    }
    req.end();
  });
}

/**
 * Send an HTTPS request through a CONNECT proxy tunnel.
 *
 * 1. Open an HTTP CONNECT tunnel to the proxy
 * 2. Establish TLS over the tunnel socket
 * 3. Send the actual HTTPS request through the TLS connection
 */
async function sendHttpsViaConnectProxy(
  request: HttpRequest,
  signal: AbortSignal,
): Promise<NodeResponse> {
  const { proxyConfig } = request;
  const targetUrl = new URL(request.url);
  const targetHost = targetUrl.hostname;
  const targetPort = parseInt(targetUrl.port || '443', 10);

  // Step 1: Establish CONNECT tunnel
  const socket = await new Promise<import('net').Socket>((resolve, reject) => {
    const connectReq = http.request({
      hostname: proxyConfig!.host,
      port: proxyConfig!.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        host: `${targetHost}:${targetPort}`,
        'proxy-authorization': `Bearer ${proxyConfig!.bearerToken}`,
        ...(proxyConfig!.headers || {}),
      },
      timeout: request.timeout,
      signal,
    });

    connectReq.on('connect', (_res, sock) => {
      if (_res.statusCode === 200) {
        resolve(sock);
      } else {
        reject(new Error(`CONNECT proxy returned ${_res.statusCode}`));
      }
    });

    connectReq.on('error', reject);
    connectReq.on('timeout', () => {
      connectReq.destroy(new Error('CONNECT proxy timeout'));
    });

    connectReq.end();
  });

  // Step 2 & 3: TLS over tunnel, then send request
  return new Promise<NodeResponse>((resolve, reject) => {
    const headers = { ...request.headers };
    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf-8'));
    }

    const req = https.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: targetUrl.pathname + targetUrl.search,
        method: request.method,
        headers,
        timeout: request.timeout,
        createConnection: () => {
          return tls.connect({
            socket,
            servername: targetHost,
            rejectUnauthorized: request.rejectUnauthorized,
          });
        },
      },
      (res) => { collectResponse(res).then(resolve, reject); },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${request.timeout}ms`));
    });

    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      req.write(request.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect an http.IncomingMessage into a NodeResponse. */
function collectResponse(res: http.IncomingMessage): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
      resolve({
        statusCode: res.statusCode ?? 0,
        statusMessage: res.statusMessage ?? '',
        headers,
        body,
        contentType: headers['content-type'] ?? '',
        contentLength: Buffer.byteLength(body, 'utf-8'),
      });
    });
    res.on('error', reject);
  });
}

/** Strip sensitive headers (used for cross-origin redirect safety). */
function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}
