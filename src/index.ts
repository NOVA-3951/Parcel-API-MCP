import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PARCEL_API_BASE = "https://api.parcel.app/external";

const DELIVERY_STATUS_CODES: Record<number, string> = {
  0: "Completed delivery",
  1: "Frozen delivery (no recent updates)",
  2: "Delivery in transit",
  3: "Delivery expecting a pickup by the recipient",
  4: "Out for delivery",
  5: "Delivery not found",
  6: "Failed delivery attempt",
  7: "Delivery exception (requires attention)",
  8: "Carrier has received information but not the physical package yet",
};

async function makeParcelRequest(
  apiKey: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${PARCEL_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    "api-key": apiKey,
    "Content-Type": "application/json",
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body && method === "POST") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    const errorData = data as { error_message?: string };
    throw new Error(
      `Parcel API error: ${errorData.error_message || response.statusText}`
    );
  }

  return data;
}

function createServer(parcelApiKey: string) {
  const server = new McpServer({
    name: "parcel-tracking",
    version: "1.0.0",
  });

  server.tool(
    "add_delivery",
    "Add a new delivery to Parcel for tracking",
    {
      tracking_number: z
        .string()
        .describe("Tracking number for the delivery"),
      carrier_code: z
        .string()
        .describe(
          "Carrier code (e.g., 'ups', 'fedex', 'usps', 'pholder' for placeholder). See supported_carriers.json for full list"
        ),
      description: z.string().describe("Description for the delivery"),
      language: z
        .string()
        .optional()
        .describe("Language code (ISO 639-1, e.g., 'en', 'es'). Default: en"),
      send_push_confirmation: z
        .boolean()
        .optional()
        .describe(
          "Set to true to receive a push notification when delivery is added. Default: false"
        ),
    },
    async ({
      tracking_number,
      carrier_code,
      description,
      language,
      send_push_confirmation,
    }) => {
      try {
        const requestBody: Record<string, unknown> = {
          tracking_number,
          carrier_code,
          description,
        };

        if (language) {
          requestBody.language = language;
        }

        if (send_push_confirmation !== undefined) {
          requestBody.send_push_confirmation = send_push_confirmation;
        }

        const result = await makeParcelRequest(
          parcelApiKey,
          "/add-delivery/",
          "POST",
          requestBody
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error adding delivery: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_deliveries",
    "Get your recent or active deliveries from Parcel",
    {
      filter_mode: z
        .enum(["active", "recent"])
        .optional()
        .describe(
          "Filter mode: 'active' for active deliveries, 'recent' for recent ones. Default: 'recent'"
        ),
    },
    async ({ filter_mode }) => {
      try {
        const queryParam = filter_mode ? `?filter_mode=${filter_mode}` : "";
        const result = await makeParcelRequest(
          parcelApiKey,
          `/deliveries/${queryParam}`
        );

        const data = result as { deliveries?: unknown[] };

        if (data.deliveries && Array.isArray(data.deliveries)) {
          const formattedDeliveries = data.deliveries.map((delivery: any) => {
            const status = DELIVERY_STATUS_CODES[delivery.status_code] || "Unknown status";
            return {
              ...delivery,
              status_description: status,
            };
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...data, deliveries: formattedDeliveries },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching deliveries: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_supported_carriers",
    "Get the list of supported carriers and their codes",
    {},
    async () => {
      try {
        const response = await fetch(
          "https://api.parcel.app/external/supported_carriers.json"
        );
        const carriers = await response.json();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(carriers, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching supported carriers: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_delivery_status_codes",
    "Get the meaning of delivery status codes",
    {},
    async () => {
      const statusInfo = Object.entries(DELIVERY_STATUS_CODES).map(
        ([code, description]) => ({
          code: parseInt(code),
          description,
        })
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(statusInfo, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

async function main() {
  const apiKey = process.env.PARCEL_API_KEY;
  
  if (!apiKey) {
    console.error("Error: PARCEL_API_KEY environment variable is required");
    process.exit(1);
  }

  const server = createServer(apiKey);
  const transport = new StdioServerTransport();
  
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
