# Parcel MCP Server - Replit Project

## Overview
This project is an HTTP MCP (Model Context Protocol) server for the Parcel delivery tracking API. It's designed to be deployed on Smithery, allowing AI assistants to interact with the Parcel API to manage and track deliveries.

## Purpose
- Enable AI assistants to add new deliveries to Parcel
- Allow AI assistants to query delivery status (active or recent)
- Provide information about supported carriers and status codes

## Architecture

### Project Structure
```
/
├── src/
│   └── index.ts          # Main MCP server implementation
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Project dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── smithery.yaml         # Smithery deployment configuration
└── README.md             # Documentation
```

### Technology Stack
- **Runtime**: Node.js 20
- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk v1.23.0
- **Validation**: Zod v3
- **Deployment**: Smithery

### API Integration
The server integrates with the Parcel API:
- Base URL: `https://api.parcel.app/external`
- Authentication: API key via header
- Endpoints:
  - POST `/add-delivery/` - Add new deliveries
  - GET `/deliveries/` - Get deliveries (with optional filter_mode)
  - GET `https://api.parcel.app/external/supported_carriers.json` - Get carriers list

## Recent Changes
- 2025-11-30: Initial project setup
- Created MCP server with 4 tools (add_delivery, get_deliveries, get_supported_carriers, get_delivery_status_codes)
- Configured for Smithery deployment with API key management via configSchema
- Set up TypeScript build pipeline

## Configuration

### User Configuration
Users must provide their Parcel API key when installing the server. This is handled through the `configSchema` export in `src/index.ts`.

### Development
Run `npm run dev` to start the development server with hot-reload.

### Production
The server is deployed on Smithery and accessible via WebSocket transport.

## Rate Limits
- Add Delivery: 20 requests per day
- Get Deliveries: 20 requests per hour

## Security Notes
- API keys are passed ephemerally through Smithery's config system
- No API keys are stored in the codebase or version control
- Users manage their own API keys through Smithery's installation process
