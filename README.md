[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/nova-3951-parcel-api-mcp-badge.png)](https://mseep.ai/app/nova-3951-parcel-api-mcp)

# Parcel MCP Server

[![smithery badge](https://smithery.ai/badge/@NOVA-3951/parcel-api-mcp)](https://smithery.ai/server/@NOVA-3951/parcel-api-mcp)

An MCP (Model Context Protocol) server for the Parcel delivery tracking API. This server allows AI assistants to interact with your Parcel account to add deliveries and track their status.

## Features

This MCP server provides four tools:

### 1. `add_delivery`
Add a new delivery to Parcel for tracking.

**Parameters:**
- `tracking_number` (required): Tracking number for the delivery
- `carrier_code` (required): Carrier code (e.g., 'ups', 'fedex', 'usps', 'pholder' for placeholder)
- `description` (required): Description for the delivery
- `language` (optional): Language code (ISO 639-1, e.g., 'en', 'es'). Default: en
- `send_push_confirmation` (optional): Set to true to receive a push notification. Default: false

**Note:** Rate limit is 20 requests per day.

### 2. `get_deliveries`
Get your recent or active deliveries from Parcel.

**Parameters:**
- `filter_mode` (optional): 'active' for active deliveries or 'recent' for recent ones. Default: 'recent'

**Note:** Rate limit is 20 requests per hour.

### 3. `get_supported_carriers`
Get the list of supported carriers and their codes.

**No parameters required.**

### 4. `get_delivery_status_codes`
Get the meaning of delivery status codes (0-8).

**No parameters required.**

## Installation

### Prerequisites
- A Parcel premium account
- An API key from [web.parcelapp.net](https://web.parcelapp.net/)

### Using Smithery (Recommended)

1. Install the server using Smithery CLI:
```bash
smithery install parcel-mcp-server --client <your-client>
```

2. You'll be prompted to enter your Parcel API key during the installation flow.

The API key is securely passed to the server via Smithery's configuration system.

### Local Testing

For local development and testing, the server supports environment variables:

1. Clone this repository
2. Build the server:
```bash
npm install
npm run build
```

3. Add to your MCP client configuration (e.g., Claude Desktop):
```json
{
  "mcpServers": {
    "parcel": {
      "command": "node",
      "args": ["/path/to/parcel-mcp-server/dist/index.js"],
      "env": {
        "PARCEL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

**Note:** The `PARCEL_API_KEY` environment variable is intended for testing only. Production deployments should use Smithery's configuration flow.

## Development

### Local Development
```bash
npm install
npm run dev
```

This will start the server with hot-reload using Smithery's development mode.

### Building
```bash
npm run build
```

## API Rate Limits

- **Add Delivery**: 20 requests per day
- **Get Deliveries**: 20 requests per hour

## Delivery Status Codes

- 0: Completed delivery
- 1: Frozen delivery (no recent updates)
- 2: Delivery in transit
- 3: Delivery expecting a pickup by the recipient
- 4: Out for delivery
- 5: Delivery not found
- 6: Failed delivery attempt
- 7: Delivery exception (requires attention)
- 8: Carrier has received information but not the physical package yet

## Resources

- [Parcel API Documentation - Add Delivery](https://parcelapp.net/help/api-add-delivery.html)
- [Parcel API Documentation - View Deliveries](https://parcelapp.net/help/api-view-deliveries.html)
- [Supported Carriers List](https://api.parcel.app/external/supported_carriers.json)

## License

MIT