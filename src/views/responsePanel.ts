import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HttpResponse } from '../parser/types';

/**
 * Manages a singleton WebView panel that renders HTTP response details.
 */
export class ResponsePanel {
  private static instance: ResponsePanel | undefined;
  private static readonly viewType = 'destinationAnywhere.response';

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /* ── public API ──────────────────────────────────────────── */

  static show(response: HttpResponse, extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (ResponsePanel.instance) {
      ResponsePanel.instance.panel.reveal(column);
      ResponsePanel.instance.update(response, extensionUri);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ResponsePanel.viewType,
      'Response',
      column,
      { enableScripts: true },
    );

    ResponsePanel.instance = new ResponsePanel(panel);
    ResponsePanel.instance.update(response, extensionUri);
  }

  /* ── internals ───────────────────────────────────────────── */

  private update(response: HttpResponse, extensionUri: vscode.Uri): void {
    this.panel.title = `Response  ${response.statusCode}`;
    this.panel.webview.html = this.buildHtml(response, extensionUri);
  }

  private dispose(): void {
    ResponsePanel.instance = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  /* ── HTML builder ────────────────────────────────────────── */

  private buildHtml(response: HttpResponse, extensionUri: vscode.Uri): string {
    const css = this.loadCss(extensionUri);
    const statusClass = this.statusClass(response.statusCode);
    const bodyHtml = this.formatBody(response);
    const headersHtml = this.buildHeadersTable(response.headers);
    const elapsed = response.elapsedTime < 1000
      ? `${response.elapsedTime} ms`
      : `${(response.elapsedTime / 1000).toFixed(2)} s`;
    const size = this.formatBytes(response.contentLength);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>${css}</style>
</head>
<body>

  <!-- Status bar -->
  <div class="status-bar">
    <span class="status-badge ${statusClass}">${response.statusCode}</span>
    <span class="status-message">${this.escapeHtml(response.statusMessage)}</span>
    <span class="status-meta">${elapsed}</span>
    <span class="status-meta">${size}</span>
  </div>

  <!-- Tabs -->
  <div class="tab-bar">
    <button class="tab active" data-tab="body">Body</button>
    <button class="tab" data-tab="headers">Headers</button>
    <div class="tab-actions">
      <button class="copy-btn" id="copyBtn" title="Copy body to clipboard">Copy Body</button>
    </div>
  </div>

  <!-- Body -->
  <div id="tab-body" class="tab-content active">
    <pre class="body-content">${bodyHtml}</pre>
  </div>

  <!-- Headers -->
  <div id="tab-headers" class="tab-content">
    ${headersHtml}
  </div>

  <script>
    (function() {
      const tabs = document.querySelectorAll('.tab[data-tab]');
      tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
          tabs.forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          tab.classList.add('active');
          var target = document.getElementById('tab-' + tab.getAttribute('data-tab'));
          if (target) { target.classList.add('active'); }
        });
      });

      document.getElementById('copyBtn').addEventListener('click', function() {
        var body = document.querySelector('.body-content');
        if (!body) { return; }
        var text = body.innerText || body.textContent || '';
        navigator.clipboard.writeText(text).then(function() {
          var btn = document.getElementById('copyBtn');
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy Body'; }, 1500);
        });
      });
    })();
  </script>

</body>
</html>`;
  }

  /* ── helpers ─────────────────────────────────────────────── */

  private static cachedCss: string | undefined;

  private loadCss(extensionUri: vscode.Uri): string {
    if (ResponsePanel.cachedCss !== undefined) {
      return ResponsePanel.cachedCss;
    }
    const cssPath = path.join(extensionUri.fsPath, 'media', 'response.css');
    try {
      ResponsePanel.cachedCss = fs.readFileSync(cssPath, 'utf-8');
    } catch {
      ResponsePanel.cachedCss = '/* response.css not found */';
    }
    return ResponsePanel.cachedCss;
  }

  private statusClass(code: number): string {
    if (code < 300) { return 'status-2xx'; }
    if (code < 400) { return 'status-3xx'; }
    if (code < 500) { return 'status-4xx'; }
    return 'status-5xx';
  }

  private formatBody(response: HttpResponse): string {
    const ct = response.contentType.toLowerCase();
    const raw = response.body;

    if (ct.includes('json') || ct.includes('application/hal+json')) {
      return this.highlightJson(raw);
    }
    if (ct.includes('xml') || ct.includes('text/xml') || ct.includes('application/atom+xml')) {
      return this.escapeHtml(this.indentXml(raw));
    }
    return this.escapeHtml(raw);
  }

  /** Syntax-highlight JSON with span classes */
  private highlightJson(raw: string): string {
    let pretty: string;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return this.escapeHtml(raw);
    }

    // Tokenise the already-pretty-printed JSON for colouring.
    return pretty.replace(
      /("(?:\\.|[^"\\])*")\s*:/g,
      (_, key: string) => `<span class="json-key">${this.escapeHtml(key)}</span>:`,
    ).replace(
      /:\s*("(?:\\.|[^"\\])*")/g,
      (m, val: string) => m.replace(val, `<span class="json-string">${this.escapeHtml(val)}</span>`),
    ).replace(
      /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, num: string) => m.replace(num, `<span class="json-number">${num}</span>`),
    ).replace(
      /:\s*(true|false)/g,
      (m, bool: string) => m.replace(bool, `<span class="json-boolean">${bool}</span>`),
    ).replace(
      /:\s*(null)/g,
      (m, n: string) => m.replace(n, `<span class="json-null">${n}</span>`),
    );
  }

  /** Naive XML indentation (best-effort) */
  private indentXml(xml: string): string {
    let formatted = '';
    let indent = 0;
    const parts = xml.replace(/>\s*</g, '><').split(/(<[^>]+>)/);

    for (const part of parts) {
      if (!part.trim()) { continue; }

      if (part.startsWith('</')) {
        indent = Math.max(indent - 1, 0);
        formatted += '  '.repeat(indent) + part + '\n';
      } else if (part.startsWith('<') && part.endsWith('/>')) {
        formatted += '  '.repeat(indent) + part + '\n';
      } else if (part.startsWith('<?')) {
        formatted += part + '\n';
      } else if (part.startsWith('<') && !part.startsWith('</')) {
        formatted += '  '.repeat(indent) + part + '\n';
        indent++;
      } else {
        formatted += '  '.repeat(indent) + part + '\n';
      }
    }
    return formatted.trimEnd();
  }

  private buildHeadersTable(headers: Record<string, string>): string {
    const entries = Object.entries(headers);
    if (entries.length === 0) {
      return '<div class="empty">No headers</div>';
    }

    const rows = entries
      .map(([k, v]) =>
        `<tr><td>${this.escapeHtml(k)}</td><td>${this.escapeHtml(v)}</td></tr>`)
      .join('\n');

    return `<table class="headers-table">
  <thead><tr><th>Header</th><th>Value</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
