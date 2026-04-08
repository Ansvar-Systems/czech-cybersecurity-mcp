#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchGuidance,
  getGuidance,
  searchAdvisories,
  getAdvisory,
  listFrameworks,
  getDataFreshness,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "czech-cybersecurity-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "cz_cyber_search_guidance",
    description:
      "Full-text search across NUKIB guidelines and technical standards. Covers national cybersecurity recommendations, NIS2 implementation guidance, ISMS standards, and critical infrastructure protection requirements. Returns matching documents with reference, title, series, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'kybernetická bezpečnost', 'NIS2', 'ISMS', 'kryptografie')" },
        type: {
          type: "string",
          enum: ["guideline", "standard", "recommendation", "regulation"],
          description: "Filter by document type. Optional.",
        },
        series: {
          type: "string",
          enum: ["NUKIB", "NIS2", "ISMS"],
          description: "Filter by framework series. Optional.",
        },
        status: {
          type: "string",
          enum: ["current", "superseded", "draft"],
          description: "Filter by document status. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cz_cyber_get_guidance",
    description:
      "Get a specific NUKIB guidance document by reference (e.g., 'NUKIB-REK-2024-01', 'NUKIB-GUIDE-2023-02').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "NUKIB document reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "cz_cyber_search_advisories",
    description:
      "Search NUKIB security advisories and alerts. Returns advisories with severity, affected products, and CVE references where available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'kritická zranitelnost', 'ransomware', 'VPN')" },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cz_cyber_get_advisory",
    description: "Get a specific NUKIB security advisory by reference (e.g., 'NUKIB-ADV-2024-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "NUKIB advisory reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "cz_cyber_list_frameworks",
    description:
      "List all NUKIB frameworks and standard series covered in this MCP, including National Cybersecurity Framework, NIS2 implementation, and ISMS guidance.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_cyber_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_cyber_list_sources",
    description:
      "List all data sources used by this server with provenance metadata. Returns source name, authority, URL, scope, license, and record counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cz_cyber_check_data_freshness",
    description:
      "Check data freshness for each source. Reports record counts and the most recent document date to help identify stale data.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchGuidanceArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guideline", "standard", "recommendation", "regulation"]).optional(),
  series: z.enum(["NUKIB", "NIS2", "ISMS"]).optional(),
  status: z.enum(["current", "superseded", "draft"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidanceArgs = z.object({
  reference: z.string().min(1),
});

const SearchAdvisoriesArgs = z.object({
  query: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetAdvisoryArgs = z.object({
  reference: z.string().min(1),
});

// --- Meta block --------------------------------------------------------------

const META = {
  disclaimer:
    "This data is provided for research purposes only and is not legal or regulatory advice. Verify all references against primary NUKIB sources before making compliance decisions.",
  source_url: "https://www.nukib.cz/",
  copyright: "Official NUKIB publications — Czech government public domain",
};

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload = typeof data === "object" && data !== null
        ? { ...data as object, _meta: META }
        : { data, _meta: META };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "cz_cyber_search_guidance": {
          const parsed = SearchGuidanceArgs.parse(args);
          const results = searchGuidance({
            query: parsed.query,
            type: parsed.type,
            series: parsed.series,
            status: parsed.status,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "cz_cyber_get_guidance": {
          const parsed = GetGuidanceArgs.parse(args);
          const doc = getGuidance(parsed.reference);
          if (!doc) {
            return errorContent(`Guidance document not found: ${parsed.reference}`);
          }
          return textContent(doc);
        }

        case "cz_cyber_search_advisories": {
          const parsed = SearchAdvisoriesArgs.parse(args);
          const results = searchAdvisories({
            query: parsed.query,
            severity: parsed.severity,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "cz_cyber_get_advisory": {
          const parsed = GetAdvisoryArgs.parse(args);
          const advisory = getAdvisory(parsed.reference);
          if (!advisory) {
            return errorContent(`Advisory not found: ${parsed.reference}`);
          }
          return textContent(advisory);
        }

        case "cz_cyber_list_frameworks": {
          const frameworks = listFrameworks();
          return textContent({ frameworks, count: frameworks.length });
        }

        case "cz_cyber_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "NUKIB (Národní úřad pro kybernetickou a informační bezpečnost — Czech National Cyber and Information Security Agency) MCP server. Provides access to NUKIB guidelines, technical standards, NIS2 implementation guidance, and security advisories.",
            data_source: "NUKIB (https://www.nukib.cz/)",
            coverage: {
              guidance: "NUKIB technical guidelines, recommendations, NIS2 implementation standards",
              advisories: "NUKIB security advisories and vulnerability alerts",
              frameworks: "National Cybersecurity Framework, NIS2, ISMS guidance",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        case "cz_cyber_list_sources": {
          return textContent({
            sources: [
              {
                id: "nukib-guidance",
                name: "NUKIB Guidance Documents",
                authority: "NUKIB (Národní úřad pro kybernetickou a informační bezpečnost)",
                url: "https://www.nukib.cz/cs/kyberneticka-bezpecnost/",
                scope: "Czech national cybersecurity guidelines, technical standards, recommendations, NIS2 implementation guidance",
                license: "Public domain — official Czech government publications",
                retrieval: "Periodic ingestion via NUKIB website crawler",
              },
              {
                id: "nukib-advisories",
                name: "NUKIB Security Advisories",
                authority: "NUKIB (Národní úřad pro kybernetickou a informační bezpečnost)",
                url: "https://www.nukib.cz/cs/infoservis/hrozby/",
                scope: "Security advisories, vulnerability alerts, threat intelligence, CVE references",
                license: "Public domain — official Czech government publications",
                retrieval: "Periodic ingestion via NUKIB website crawler",
              },
              {
                id: "nukib-frameworks",
                name: "NUKIB Cybersecurity Frameworks",
                authority: "NUKIB (Národní úřad pro kybernetickou a informační bezpečnost)",
                url: "https://www.nukib.cz/",
                scope: "National Cybersecurity Framework, ISMS guidance, NIS2 implementation framework",
                license: "Public domain — official Czech government publications",
                retrieval: "Curated metadata — framework series index",
              },
            ],
          });
        }

        case "cz_cyber_check_data_freshness": {
          const freshness = getDataFreshness();
          const staleThresholdDays = 30;
          const now = new Date();
          const results = freshness.map((f) => {
            let staleness: string;
            if (!f.latest_date) {
              staleness = "no_data";
            } else {
              const latest = new Date(f.latest_date);
              const diffDays = Math.floor((now.getTime() - latest.getTime()) / (1000 * 60 * 60 * 24));
              staleness = diffDays > staleThresholdDays ? "stale" : "ok";
            }
            return { ...f, staleness };
          });
          return textContent({
            checked_at: now.toISOString(),
            stale_threshold_days: staleThresholdDays,
            sources: results,
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
