/**
 * Formatting utilities for response bodies, file sizes, and durations.
 */

/**
 * Pretty-print a JSON string with 2-space indentation.
 * Returns the original text if parsing fails.
 */
export function formatJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Basic XML pretty-printing with indentation.
 * Adds newlines after closing tags and indents nested elements.
 * Returns the original text if it doesn't look like XML.
 */
export function formatXml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<')) {
    return text;
  }

  let formatted = '';
  let indent = 0;
  const pad = (level: number) => '  '.repeat(level);

  // Normalize: collapse whitespace between tags
  const xml = trimmed.replace(/>\s+</g, '><');

  // Split into tokens: tags and text content
  const tokens = xml.match(/(<[^>]+>)|([^<]+)/g);
  if (!tokens) {
    return text;
  }

  for (const token of tokens) {
    if (token.startsWith('</')) {
      // Closing tag — decrease indent first
      indent = Math.max(0, indent - 1);
      formatted += pad(indent) + token + '\n';
    } else if (token.startsWith('<?') || token.startsWith('<!')) {
      // Processing instruction or declaration
      formatted += pad(indent) + token + '\n';
    } else if (token.endsWith('/>')) {
      // Self-closing tag
      formatted += pad(indent) + token + '\n';
    } else if (token.startsWith('<')) {
      // Opening tag — print then increase indent
      formatted += pad(indent) + token + '\n';
      indent++;
    } else {
      // Text content
      const trimmedContent = token.trim();
      if (trimmedContent) {
        formatted += pad(indent) + trimmedContent + '\n';
      }
    }
  }

  return formatted.trimEnd();
}

/**
 * Auto-detect format from content type and apply the appropriate formatter.
 */
export function formatBody(body: string, contentType: string): string {
  const ct = contentType.toLowerCase();

  if (ct.includes('json')) {
    return formatJson(body);
  }

  if (ct.includes('xml') || ct.includes('html')) {
    return formatXml(body);
  }

  return body;
}

/**
 * Format bytes to a human-readable string (e.g., "1.2 KB", "3.4 MB").
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  if (unitIndex === 0) {
    return `${size} B`;
  }

  return `${size.toFixed(2).replace(/\.?0+$/, '')} ${units[unitIndex]}`;
}

/**
 * Format milliseconds to a human-readable string (e.g., "123 ms", "1.23 s").
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1).replace(/\.?0+$/, '');
  return `${minutes} m ${seconds} s`;
}
