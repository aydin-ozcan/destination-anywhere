# Changelog

All notable changes to the "Destination Anywhere" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.15] - 2026-04-23

### Added
- `.dest` file format with syntax highlighting
- HTTP request sending (GET, POST, PUT, PATCH, DELETE)
- Response viewer with status, headers, and formatted body
- Keyboard shortcut `Cmd+Alt+R` / `Ctrl+Alt+R` to send requests
- `dest://` protocol for SAP BTP Destination resolution
- `mdk://` protocol for SAP Mobile Services integration
- OAuth2 token caching with automatic refresh
- Response panel with JSON/XML pretty-printing
- Variable resolution from `.env` files and VS Code settings
- Environment switching via command palette
- Default headers configuration
- Sidebar tree view for browsing BTP destinations
- Context menu to insert sample request snippets
- CodeLens "▶ Send Request" above each request block
- On-premise routing through Cloud Connector with automatic router app deployment
- CF login/logout from sidebar with status bar indicator
- Destination info panel with full configuration details
- Destination cache with configurable TTL
