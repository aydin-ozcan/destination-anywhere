'use strict';

const express = require('express');
const passport = require('passport');
const { XssecPassportStrategy, XsuaaService } = require('@sap/xssec');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// XSUAA Authentication — fail closed if credentials are missing
// ---------------------------------------------------------------------------

const services = JSON.parse(process.env.VCAP_SERVICES || '{}');
const xsuaaCreds = (services.xsuaa || [])[0]?.credentials;

if (!xsuaaCreds) {
  console.error('FATAL: No XSUAA service binding found. Cannot enforce authentication.');
  process.exit(1);
}

const xsuaaService = new XsuaaService(xsuaaCreds);
passport.use('JWT', new XssecPassportStrategy(xsuaaService));

// Health check (unauthenticated — required for CF health monitoring)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// All other routes require a valid JWT
app.use(passport.initialize());
app.use(passport.authenticate('JWT', { session: false }));

// ---------------------------------------------------------------------------
// Destination proxy route
// ---------------------------------------------------------------------------

// Route: /<DestinationName>/<path...>
app.all('/:destinationName/*', async (req, res) => {
  const { destinationName } = req.params;
  // Everything after the destination name
  const targetPath = '/' + req.params[0] + (req._parsedUrl.search || '');

  // Extract JWT from Authorization header (already validated by passport)
  const authHeader = req.headers['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  try {
    const response = await executeHttpRequest(
      { destinationName, jwt },
      {
        method: req.method.toLowerCase(),
        url: targetPath,
        headers: filterHeaders(req.headers),
        data: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : req,
        timeout: 300000,
      }
    );

    // Forward status + headers + body
    const excludeHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive']);
    if (response.headers) {
      for (const [key, value] of Object.entries(response.headers)) {
        if (!excludeHeaders.has(key.toLowerCase()) && value != null) {
          res.setHeader(key, value);
        }
      }
    }
    res.status(response.status).send(response.data);
  } catch (error) {
    const status = error.response?.status || error.cause?.response?.status || 502;
    const message = error.message || 'Unknown error';
    console.error(`[${destinationName}] ${req.method} ${targetPath} -> ${status}: ${message}`);
    if (error.response?.data || error.cause?.response?.data) {
      res.status(status).send(error.response?.data || error.cause?.response?.data);
    } else {
      res.status(status).json({ error: message });
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterHeaders(headers) {
  const skip = new Set([
    'host', 'connection', 'content-length', 'authorization',
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-path',
  ]);
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase()) && value != null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

app.listen(PORT, () => console.log(`dest-anywhere-router listening on port ${PORT}`));
