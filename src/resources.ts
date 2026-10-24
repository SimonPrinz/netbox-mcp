/**
 * MCP resources exposing NetBox discovery metadata and the OpenAPI spec.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { SpecIndex } from "./netbox/spec.js";

export interface ResourceDependencies {
  index: SpecIndex;
  config: Config;
  baseUrl: string;
  toolCount: number;
  specPath: string;
}

function buildEndpointIndex(index: SpecIndex): string {
  const resources = [...index.resources.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({
      key: entry.key,
      app: entry.app,
      resource: entry.resource,
      collection: entry.path,
      detail: entry.detailPath,
      operations: Object.keys(entry.operations),
      actionCount: entry.actions.length,
      summary: entry.summary,
    }));

  const apps = new Map<string, number>();
  for (const entry of index.resources.values()) {
    apps.set(entry.app, (apps.get(entry.app) ?? 0) + 1);
  }

  return JSON.stringify(
    {
      title: index.title,
      version: index.version,
      resourceCount: index.resources.size,
      apps: Object.fromEntries([...apps.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      resources,
    },
    null,
    2,
  );
}

function buildHealth(index: SpecIndex, config: Config, baseUrl: string, specPath: string, toolCount: number): string {
  return JSON.stringify(
    {
      status: "ok",
      netbox: {
        baseUrl,
        tokenType: config.netbox.tokenType,
        verifyTls: config.netbox.verifyTls,
        timeoutMs: config.netbox.timeoutMs,
        allowWrites: config.netbox.allowWrites,
      },
      spec: { title: index.title, version: index.version, path: specPath, resources: index.resources.size },
      tools: toolCount,
    },
    null,
    2,
  );
}

export function registerResources(server: McpServer, deps: ResourceDependencies): void {
  const { index, config, baseUrl, toolCount, specPath } = deps;

  server.registerResource(
    "netbox-endpoints",
    "netbox://endpoints",
    {
      title: "NetBox endpoint index",
      description:
        "Machine-readable index of every NetBox REST resource exposed by this server: canonical keys, " +
        "collection/detail paths, supported operations and action endpoints.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: buildEndpointIndex(index),
        },
      ],
    }),
  );

  server.registerResource(
    "netbox-openapi",
    "netbox://openapi",
    {
      title: "NetBox OpenAPI specification",
      description:
        `The complete NetBox OpenAPI specification (${index.title} ${index.version}) as YAML. ` +
        "Use it to look up request/response schemas and custom action endpoints.",
      mimeType: "application/yaml",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/yaml",
          text: index.raw,
        },
      ],
    }),
  );

  server.registerResource(
    "netbox-health",
    "netbox://health",
    {
      title: "NetBox MCP status",
      description: "Current server configuration (token redacted), write mode and spec information.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: buildHealth(index, config, baseUrl, specPath, toolCount),
        },
      ],
    }),
  );
}