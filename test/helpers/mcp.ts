/**
 * Test helpers: start the MCP HTTP server in-process and talk to it over HTTP.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../src/config.js";
import { NetBoxClient } from "../../src/netbox/client.js";
import { loadSpecIndex } from "../../src/netbox/spec.js";
import { computeToolCount, createHttpServer, type ServerContext } from "../../src/server.js";

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePromise(port));
    });
  });
}

/** Start the MCP server with the given environment overrides. */
export async function startTestServer(env: Record<string, string>): Promise<TestServer> {
  const port = await getFreePort();
  const settings: Record<string, string> = {
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
    ...env,
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(settings)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  const config = loadConfig();
  const index = await loadSpecIndex(config);
  const client = new NetBoxClient(config.netbox);
  const context: ServerContext = {
    config,
    index,
    client,
    specPath: config.specPath ?? "(test)",
    toolCount: computeToolCount(config),
  };
  const server = createHttpServer(context);
  await new Promise<void>((resolvePromise) => server.listen(port, "127.0.0.1", () => resolvePromise()));

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/* ------------------------------ MCP client ------------------------------- */

interface RpcResponse<T = unknown> {
  status: number;
  sid: string | undefined;
  json: T | undefined;
  text: string;
}

function extractJson(text: string): unknown {
  if (!text) return undefined;
  if (text.trimStart().startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to SSE parsing */
    }
  }
  const payloads = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return payloads.length ? JSON.parse(payloads[payloads.length - 1]!) : undefined;
}

async function post(base: string, sid: string | undefined, payload: unknown, token?: string): Promise<RpcResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sid) headers["mcp-session-id"] = sid;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get("mcp-session-id") ?? undefined, json: extractJson(text), text };
}

export interface McpClient {
  base: string;
  sid: string;
  call<T = unknown>(method: string, params?: unknown): Promise<RpcResponse<T>>;
  callTool(name: string, args?: Record<string, unknown>): Promise<RpcResponse>;
  listTools(): Promise<Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>>;
  readResource(uri: string): Promise<string>;
  toolText(response: RpcResponse): string;
  toolJson<T = unknown>(response: RpcResponse): T;
  toolError(response: RpcResponse): boolean;
  close(): Promise<void>;
}

/** Perform the MCP handshake and return a small helper client. */
export async function connectMcp(base: string, token?: string): Promise<McpClient> {
  const init = await post(base, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
  }, token);
  if (init.status !== 200 || !init.sid) {
    throw new Error(`initialize failed (status ${init.status})`);
  }
  const sid = init.sid;
  await post(base, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, token);

  let id = 2;
  return {
    base,
    sid,
    call: <T>(method: string, params?: unknown) =>
      post(base, sid, { jsonrpc: "2.0", id: id++, method, params }, token) as Promise<RpcResponse<T>>,
    callTool: (name: string, args: Record<string, unknown> = {}) =>
      post(base, sid, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, token),
    listTools: async () => {
      const res = await post(base, sid, { jsonrpc: "2.0", id: id++, method: "tools/list", params: {} }, token);
      const json = res.json as { result?: { tools?: Array<{ name: string }> } } | undefined;
      return json?.result?.tools ?? [];
    },
    readResource: async (uri: string) => {
      const res = await post(base, sid, { jsonrpc: "2.0", id: id++, method: "resources/read", params: { uri } }, token);
      const json = res.json as { result?: { contents?: Array<{ text?: string }> } } | undefined;
      return json?.result?.contents?.[0]?.text ?? "";
    },
    toolText: (response: RpcResponse) =>
      (response.json as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text ?? "",
    toolJson: <T>(response: RpcResponse) =>
      JSON.parse(
        (response.json as { result?: { content?: Array<{ text?: string }> } } | undefined)?.result?.content?.[0]?.text ?? "null",
      ) as T,
    toolError: (response: RpcResponse) =>
      (response.json as { result?: { isError?: boolean } } | undefined)?.result?.isError === true,
    close: async () => {
      await fetch(`${base}/mcp`, { method: "DELETE", headers: sid ? { "mcp-session-id": sid } : {} });
    },
  };
}