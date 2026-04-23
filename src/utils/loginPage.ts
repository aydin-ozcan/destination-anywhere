/**
 * Shared HTML page rendered after an OAuth login callback.
 */

/** Escape special HTML characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render a styled HTML result page shown in the browser after an OAuth callback. */
export function loginResultPage(success: boolean, message: string): string {
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
