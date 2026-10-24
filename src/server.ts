/**
 * HTTP server construction: builds the MCP server (tools + resources) and the
 * Streamable HTTP transport wiring. Kept separate from the CLI entry point so it
 * can be exercised directly by tests.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { NetBoxClient } from "./netbox/client.js";
import type { SpecIndex } from "./netbox/spec.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "netbox-mcp";
export const SERVER_VERSION = readPackageVersion();
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Version from package.json so it tracks release-please bumps. */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface ServerContext {
  config: Config;
  index: SpecIndex;
  client: NetBoxClient;
  specPath: string;
  toolCount: number;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function log(message: string): void {
  console.error(`[${SERVER_NAME}] ${message}`);
}

/** Number of tools registered for a given configuration. */
export function computeToolCount(config: Config): number {
  return 7 + (config.netbox.allowWrites ? 7 : 0);
}

export function buildMcpServer(context: ServerContext): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Access the NetBox REST API. Use netbox_list_object_types to discover endpoints. " +
        "Prefer the CRUD tools (netbox_list_objects, netbox_get_object, and when writes are enabled " +
        "netbox_create_object/netbox_update_object/netbox_delete_object) and use netbox_request only " +
        "for endpoints those tools do not cover. " +
        "To stage changes safely, create a branch with netbox_create_branch, pass `branch` on every write, " +
        "review with netbox_list_branch_changes, then publish with netbox_merge_branch (or discard with " +
        "netbox_revert_branch). Omitting `branch` targets main. " +
        "Consult the netbox://endpoints resource for an index of available endpoints and netbox://openapi for full schemas.",
    },
  );

  registerTools(server, { client: context.client, index: context.index, config: context.config });
  registerResources(server, {
    index: context.index,
    config: context.config,
    baseUrl: context.client.baseUrl,
    toolCount: context.toolCount,
    specPath: context.specPath,
  });

  return { server, toolCount: context.toolCount };
}

/* --------------------------------- helpers -------------------------------- */

function applyCors(req: IncomingMessage, res: ServerResponse, config: Config): void {
  const origin = req.headers.origin;
  const allowed = config.http.allowedOrigins;
  if (typeof origin === "string" && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (allowed.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function isAuthorized(req: IncomingMessage, config: Config): boolean {
  const expected = config.http.authToken;
  if (!expected) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]!);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

function isHostAllowed(req: IncomingMessage, config: Config): boolean {
  const allowed = config.http.allowedHosts;
  if (allowed.length === 0) return true;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  const normalized = host.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === normalized);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ------------------------------ HTTP handling ----------------------------- */

export function createHttpServer(context: ServerContext): Server {
  const { config } = context;
  const sessions = new Map<string, Session>();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    if (pathname !== config.http.path) {
      sendJson(res, 404, { error: "not_found", message: `Not found. MCP endpoint is ${config.http.path}.` });
      return;
    }

    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        jsonRpcError(res, 413, -32000, "Request body too large.");
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: invalid JSON body.");
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const session = sessions.get(sessionId);
        if (!session) {
          jsonRpcError(res, 404, -32001, "Session not found.");
          return;
        }
        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (!isInitializeRequest(parsedBody)) {
        jsonRpcError(res, 400, -32000, "Bad Request: no valid session ID, and body is not an initialize request.");
        return;
      }

      if (config.http.stateless) {
        const { server } = buildMcpServer(context);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      let session: Session;
      const server = buildMcpServer(context).server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          void server.close();
        },
      });
      session = { server, transport };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: `${req.method} requires a valid mcp-session-id header.`,
        });
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    sendJson(res, 405, { error: "method_not_allowed" });
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        applyCors(req, res, config);

        if (url.pathname === "/healthz") {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "method_not_allowed" });
            return;
          }
          sendJson(res, 200, {
            status: "ok",
            server: SERVER_NAME,
            version: SERVER_VERSION,
            netbox: context.client.baseUrl,
            resources: context.index.resources.size,
            tools: context.toolCount,
          });
          return;
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (!isHostAllowed(req, config)) {
          sendJson(res, 403, { error: "forbidden", message: "Host header not allowed." });
          return;
        }

        if (!isAuthorized(req, config)) {
          sendJson(
            res,
            401,
            { error: "unauthorized", message: "A valid bearer token is required." },
            { "WWW-Authenticate": "Bearer" },
          );
          return;
        }

        await handleMcp(req, res, url.pathname);
      } catch (error) {
        log(`Unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
        else res.end();
      }
    })();
  });
}