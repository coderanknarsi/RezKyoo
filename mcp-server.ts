// src/mcp-server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const app = express();

// Allow browser-based MCP clients to read the Mcp-Session-Id header
app.use(cors({
  origin: true,
  exposedHeaders: ["Mcp-Session-Id"],
}));
app.use(express.json());

// ---------------- MCP server & tools ----------------
const server = new McpServer({ name: "rezkyoo-mcp", version: "1.0.0" });

server.tool(
  "get_reservation_status",
  { reservationId: z.string() },
  async ({ reservationId }) => ({ status: "unknown", reservationId }),
  { description: "Return reservation status for a given reservationId." }
);

server.tool(
  "find_restaurants",
  { location: z.string(), cuisine: z.string().optional(), limit: z.number().min(1).max(20).optional() },
  async ({ location, cuisine, limit = 5 }) => ({ location, cuisine: cuisine ?? null, results: [], limit }),
  { description: "Search restaurants near a location with optional cuisine filter." }
);

server.tool(
  "call_restaurant",
  { phone: z.string(), partySize: z.number().int().positive(), datetime: z.string(), name: z.string() },
  async ({ phone, partySize, datetime, name }) => ({ initiated: true, phone, partySize, datetime, name }),
  { description: "Initiate a call to a restaurant to request a reservation." }
);

// ---------------- Streamable HTTP endpoint (/mcp) ----------------
// Per the official SDK example: create a transport PER request and pass it the req/res.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true, // lets simple GET/POST checks return JSON
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// (Nice for quick checks; spec allows a single endpoint path — usually POST, but this avoids 404s.)
app.get("/mcp", (_req, res) => {
  res.status(200).json({ ok: true, hint: "Use POST /mcp for MCP messages" });
});

// ---------------- Health & well-known ----------------
app.get("/health", (_req, res) => res.json({ ok: true, at: Date.now() }));

// Serve /.well-known (ai-plugin.json & openapi.json)
app.use("/.well-known", express.static(".well-known", { extensions: ["json"] }));

// Dynamically ensure the OpenAPI server URL matches your tunnel
app.get("/.well-known/openapi.json", (req, res, next) => {
  try {
    const spec = require("../.well-known/openapi.json");
    spec.servers = [{ url: PUBLIC_BASE }];
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(spec);
  } catch (err) { next(err); }
});

// Dynamically ensure the manifest’s api.url points at your tunnel
app.get("/.well-known/ai-plugin.json", (req, res, next) => {
  try {
    const manifest = require("../.well-known/ai-plugin.json");
    if (manifest?.api?.type === "openapi" && manifest.api.url) {
      const u = new URL(manifest.api.url, "http://placeholder");
      manifest.api.url = `${PUBLIC_BASE}${u.pathname}`;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(manifest);
  } catch (err) { next(err); }
});

// ---------------- Start ----------------
const httpServer = app.listen(PORT, () => {
  console.log(`✅ MCP server running at ${PUBLIC_BASE}`);
  console.log(`---`);
  console.log(`Connector (MCP) URL: ${PUBLIC_BASE}/mcp`);
  console.log(`Manifest:            ${PUBLIC_BASE}/.well-known/ai-plugin.json`);
  console.log(`OpenAPI:             ${PUBLIC_BASE}/.well-known/openapi.json`);
  console.log(`Health:              ${PUBLIC_BASE}/health`);
  console.log(`---`);
});

// Longer keep-alives help with streaming stability
httpServer.keepAliveTimeout = 120_000;
httpServer.headersTimeout = 125_000;
