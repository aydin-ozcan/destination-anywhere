# On-Premise Router App

This is the lightweight Express application that the **Destination Anywhere** VS Code extension deploys to your Cloud Foundry space. It acts as a proxy that routes HTTP requests to on-premise SAP systems through the SAP BTP Cloud Connector.

## What does it do?

When you have on-premise destinations in SAP BTP (ProxyType: OnPremise), those systems are only reachable from inside Cloud Foundry via the Cloud Connector. This router app runs in your CF space and forwards your requests through the Cloud Connector tunnel using the SAP Cloud SDK.

**Request flow:**

```
VS Code → Router App (CF) → Cloud Connector → On-Premise System
```

## Security

- **XSUAA authentication is enforced** — every request (except `/health`) must include a valid JWT token issued by the XSUAA instance bound to this app.
- The extension obtains the JWT via an OAuth2 Authorization Code flow (browser login), so the token carries your real user identity.
- The JWT is forwarded to the SAP Cloud SDK for **principal propagation** to the on-premise system.

## Architecture

```
router-app/
  package.json   — Dependencies: Express, SAP Cloud SDK, @sap/xssec, Passport
  server.js      — Single-file Express app with JWT auth guard + catch-all proxy route
```

The app is bound to three CF service instances at deploy time:
- **Destination Service** — resolves destination configurations
- **Connectivity Service** — provides the Cloud Connector tunnel
- **XSUAA** — validates JWT tokens

## Manual deployment

If you prefer to deploy this yourself instead of using the extension's one-click deploy:

```bash
# 1. Make sure you have the required service instances in your CF space:
#    - A Destination Service instance (any plan)
#    - A Connectivity Service instance (lite plan)
#    - An XSUAA instance (application plan)

# 2. Create a manifest.yml in this directory:
cat > manifest.yml << EOF
---
applications:
  - name: dest-anywhere-router
    memory: 256M
    disk_quota: 512M
    instances: 1
    random-route: true
    buildpacks:
      - nodejs_buildpack
    services:
      - YOUR_DESTINATION_SERVICE_INSTANCE
      - YOUR_CONNECTIVITY_SERVICE_INSTANCE
      - YOUR_XSUAA_INSTANCE
EOF

# 3. Deploy
cf push
```

After deployment, the Destination Anywhere extension will automatically detect the router app in your CF space and route on-premise requests through it.

## Uninstalling

Use the **Destination Anywhere: Uninstall On-Premise Router** command, or manually:

```bash
cf delete dest-anywhere-router -f -r
```
