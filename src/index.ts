#!/usr/bin/env node
/**
 * NetBox MCP server entry point.
 *
 * Exposes the NetBox REST API as Model Context Protocol tools and resources
 * over the Streamable HTTP transport.
 */
import { ConfigError, loadConfig } from "./config.js";
import { NetBoxClient } from "./netbox/client.js";
import { loadSpecIndex } from "./netbox/spec.js";
import { SERVER_NAME, computeToolCount, createHttpServer, type ServerContext } from "./server.js";

function log(message: string): void {
  console.error(`[${SERVER_NAME}] ${message}`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const index = await loadSpecIndex(config);
  const client = new NetBoxClient(config.netbox);
  const toolCount = computeToolCount(config);

  const context: ServerContext = {
    config,
    index,
    client,
    specPath: config.specPath ?? "(bundled)",
    toolCount,
  };

  log(`Loaded ${index.title} ${index.version}: ${index.resources.size} resources indexed.`);
  log(`Write operations: ${config.netbox.allowWrites ? "ENABLED" : "read-only"}.`);
  log(
    `Branch enforcement: ${config.netbox.requireBranch ? "writes require a branch" : "off"}` +
      (config.netbox.defaultBranch ? `, default branch: ${config.netbox.defaultBranch}` : "") +
      ".",
  );
  log(`Exposing ${toolCount} tools.`);

  const httpServer = createHttpServer(context);
  httpServer.listen(config.http.port, config.http.host, () => {
    log(`Listening on http://${config.http.host}:${config.http.port}${config.http.path}`);
    log(`Health check: http://${config.http.host}:${config.http.port}/healthz`);
    if (!config.http.authToken) {
      log("Warning: no MCP_AUTH_TOKEN set; the MCP endpoint is unauthenticated.");
    }
  });

  const shutdown = (signal: string): void => {
    log(`Received ${signal}, shutting down.`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});