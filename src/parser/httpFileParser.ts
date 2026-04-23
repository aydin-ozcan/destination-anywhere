import { HttpMethod, RequestBlock, DestinationUrl, MobileServicesUrl } from './types';

const SEPARATOR_RE = /^###(?!#)(.*)$/;
const COMMENT_RE = /^(?:#(?!##)|\/\/)/;
const HEADER_RE = /^([\w-]+)\s*:\s*(.*)$/;
const REQUEST_LINE_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i;
const DEST_URL_RE = /^dest:\/\//;
const MDK_URL_RE = /^mdk:\/\//;

/** Parse the full text of an .http file into request blocks. */
export function parseHttpFile(text: string): RequestBlock[] {
  const lines = text.split(/\r?\n/);
  const rawBlocks = splitBlocks(lines);
  const blocks: RequestBlock[] = [];

  for (const raw of rawBlocks) {
    const block = parseBlock(raw.lines, raw.startLine, raw.name);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks;
}

/** Find the request block that contains the given 0-based line number. */
export function getRequestBlockAtLine(
  blocks: RequestBlock[],
  line: number,
): RequestBlock | undefined {
  return blocks.find((b) => line >= b.startLine && line <= b.endLine);
}

/** Check whether a URL uses the dest:// scheme. */
export function isDestinationUrl(url: string): boolean {
  return DEST_URL_RE.test(url);
}

/** Check whether a URL uses the mdk:// scheme. */
export function isMobileServicesUrl(url: string): boolean {
  return MDK_URL_RE.test(url);
}

/** Extract destination name, path, and query string from a dest:// URL. */
export function parseDestinationUrl(url: string): DestinationUrl {
  const withoutScheme = url.replace(DEST_URL_RE, '');
  const slashIdx = withoutScheme.indexOf('/');

  let destinationName: string;
  let rest: string;

  if (slashIdx === -1) {
    destinationName = withoutScheme;
    rest = '';
  } else {
    destinationName = withoutScheme.substring(0, slashIdx);
    rest = withoutScheme.substring(slashIdx);
  }

  const queryIdx = rest.indexOf('?');
  let path: string;
  let queryString: string;

  if (queryIdx === -1) {
    path = rest || '/';
    queryString = '';
  } else {
    path = rest.substring(0, queryIdx) || '/';
    queryString = rest.substring(queryIdx + 1);
  }

  return { destinationName, path, queryString };
}

/**
 * Parse an mdk:// URL into its constituent parts.
 *
 * Format: `mdk://AppId/DestinationName/optional/path?optional=query`
 */
export function parseMobileServicesUrl(url: string): MobileServicesUrl {
  const withoutScheme = url.replace(MDK_URL_RE, '');
  // First segment = AppId, second = DestinationName, rest = path
  const match = /^([^/]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(withoutScheme);
  if (!match) {
    throw new Error(
      `Invalid mdk:// URL: "${url}". ` +
        'Expected format: mdk://AppId/DestinationName/path?query',
    );
  }
  return {
    appId: decodeURIComponent(match[1]),
    destinationName: decodeURIComponent(match[2]),
    path: match[3] ?? '/',
    queryString: match[4] ?? '',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawBlock {
  lines: string[];
  startLine: number;
  name?: string;
}

/** Split the file lines into raw blocks separated by `###`. */
function splitBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let currentLines: string[] = [];
  let startLine = 0;
  let currentName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const match = SEPARATOR_RE.exec(lines[i]);
    if (match) {
      if (currentLines.length > 0) {
        blocks.push({ lines: currentLines, startLine, name: currentName });
      }
      currentLines = [];
      startLine = i + 1;
      const nameText = match[1].trim();
      currentName = nameText || undefined;
    } else {
      if (currentLines.length === 0) {
        startLine = i;
      }
      currentLines.push(lines[i]);
    }
  }

  if (currentLines.length > 0) {
    blocks.push({ lines: currentLines, startLine, name: currentName });
  }

  return blocks;
}

/** Parse a single raw block into a RequestBlock, or undefined if invalid. */
function parseBlock(
  lines: string[],
  startLine: number,
  name?: string,
): RequestBlock | undefined {
  let method: HttpMethod | undefined;
  let rawUrl: string | undefined;
  const headers: Record<string, string> = {};
  const bodyLines: string[] = [];
  let phase: 'request' | 'headers' | 'body' = 'request';

  for (const line of lines) {
    if (phase === 'body') {
      bodyLines.push(line);
      continue;
    }

    // Skip comments in request/headers phase
    if (COMMENT_RE.test(line)) {
      continue;
    }

    // Skip blank lines before the request line
    if (phase === 'request' && line.trim() === '') {
      continue;
    }

    if (phase === 'request') {
      const reqMatch = REQUEST_LINE_RE.exec(line.trim());
      if (!reqMatch) {
        continue;
      }
      method = reqMatch[1].toUpperCase() as HttpMethod;
      rawUrl = reqMatch[2];
      phase = 'headers';
      continue;
    }

    // Headers phase
    if (line.trim() === '') {
      phase = 'body';
      continue;
    }

    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch) {
      headers[headerMatch[1]] = headerMatch[2].trim();
    }
  }

  if (!method || !rawUrl) {
    return undefined;
  }

  const endLine = startLine + lines.length - 1;
  const body = bodyLines.length > 0 ? bodyLines.join('\n') : undefined;
  // Trim trailing whitespace from body but keep internal structure
  const trimmedBody = body?.replace(/\s+$/, '') || undefined;

  return {
    method,
    rawUrl,
    headers,
    body: trimmedBody || undefined,
    startLine,
    endLine,
    name,
  };
}
