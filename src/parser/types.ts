/**
 * Shared type definitions for Destination Anywhere extension.
 */

/** Supported HTTP methods */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** A parsed request block from an .http file */
export interface RequestBlock {
  /** The HTTP method (GET, POST, etc.) */
  method: HttpMethod;
  /** The raw URL as written (may contain dest:// or {{variables}}) */
  rawUrl: string;
  /** Parsed headers as key-value pairs */
  headers: Record<string, string>;
  /** Request body (if any) */
  body?: string;
  /** Line number in the source file where this block starts */
  startLine: number;
  /** Line number in the source file where this block ends */
  endLine: number;
  /** Optional name from ### comment */
  name?: string;
}

/** A fully resolved HTTP request ready to send */
export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
  followRedirects: boolean;
  rejectUnauthorized: boolean;
  /** Set when the target is an OnPremise destination (routes via BTP Connectivity Service) */
  proxyConfig?: ProxyConfig;
}

/** HTTP response from an executed request */
export interface HttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string;
  /** Content type from response headers */
  contentType: string;
  /** Response time in milliseconds */
  elapsedTime: number;
  /** Response body size in bytes */
  contentLength: number;
}

/** SAP BTP Destination configuration returned by the Destination Service */
export interface DestinationConfig {
  name: string;
  url: string;
  authenticationType: DestinationAuthType;
  user?: string;
  password?: string;
  tokenServiceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  proxyType: 'Internet' | 'OnPremise';
}

/** Resolved destination with auth token ready to use */
export interface ResolvedDestination {
  /** The base URL of the destination (e.g., https://my-s4.example.com:443) */
  baseUrl: string;
  /** Auth headers to add to the request */
  authHeaders: Record<string, string>;
  /** Additional headers from destination config */
  additionalHeaders: Record<string, string>;
  /** Proxy configuration (for OnPremise destinations) */
  proxyConfig?: ProxyConfig;
  /** Whether this is an on-premise destination (ProxyType: OnPremise) */
  isOnPremise: boolean;
  /** When this resolution was cached */
  resolvedAt: number;
}

export interface ProxyConfig {
  host: string;
  port: number;
  /** Bearer token for Proxy-Authorization header (BTP Connectivity Service) */
  bearerToken: string;
  headers?: Record<string, string>;
}

/** Supported BTP destination authentication types */
export type DestinationAuthType =
  | 'NoAuthentication'
  | 'BasicAuthentication'
  | 'OAuth2ClientCredentials'
  | 'OAuth2SAMLBearerAssertion'
  | 'OAuth2UserTokenExchange'
  | 'PrincipalPropagation'
  | 'SAMLAssertion'
  | 'ClientCertificateAuthentication';

/** A variable definition */
export interface Variable {
  name: string;
  value: string;
  source: VariableSource;
}

export type VariableSource = 'file' | 'environment' | 'settings' | 'dotenv';

/** An environment configuration */
export interface Environment {
  name: string;
  variables: Record<string, string>;
}

/** Result of parsing a dest:// URL */
export interface DestinationUrl {
  destinationName: string;
  path: string;
  queryString: string;
}

/** Result of parsing an mdk:// URL */
export interface MobileServicesUrl {
  /** The Mobile Services application ID (e.g. SAM2405.SAM.WIN) */
  appId: string;
  /** The Mobile Destination name configured in Mobile Services Connectivity (e.g. DEST_SAM2405_PPROP) */
  destinationName: string;
  /** Relative path to append (e.g. /sap/opu/odata/MERP/SAP_SRV_ASSET_MANAGER_2405/MyEquipments) */
  path: string;
  /** Query string including leading ? (e.g. ?$top=10) */
  queryString: string;
}

/** Raw response from the BTP Destination Service API */
export interface DestinationServiceResponse {
  owner: {
    SubaccountId: string;
    InstanceId: string;
  };
  destinationConfiguration: Record<string, string>;
  authTokens?: Array<{
    type: string;
    value: string;
    http_header?: {
      key: string;
      value: string;
    };
    expires_in?: string;
    error?: string;
  }>;
  certificates?: Array<{
    Name: string;
    Content: string;
    Type: string;
  }>;
}
