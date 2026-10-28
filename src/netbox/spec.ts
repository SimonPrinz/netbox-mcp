/**
 * Parses the bundled NetBox OpenAPI specification and builds an index of
 * REST resources (collection/detail endpoints) plus their operations.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ResourceOperation =
  | "list"
  | "create"
  | "retrieve"
  | "update"
  | "partial_update"
  | "delete";

export const RESOURCE_OPERATIONS: ResourceOperation[] = [
  "list",
  "create",
  "retrieve",
  "update",
  "partial_update",
  "delete",
];

export interface EndpointOperation {
  kind: ResourceOperation | "action";
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
}

export interface ResourceEntry {
  /** Canonical key, e.g. `dcim/devices`. */
  key: string;
  app: string;
  resource: string;
  /** Collection endpoint, e.g. `/api/dcim/devices/`. */
  path: string;
  detailPath?: string;
  operations: Partial<Record<ResourceOperation, EndpointOperation>>;
  actions: EndpointOperation[];
  tag?: string;
  summary?: string;
}

export interface SpecIndex {
  title: string;
  version: string;
  raw: string;
  resources: Map<string, ResourceEntry>;
  /** alias (canonical key, dotted key, bare name, api path) -> canonical key */
  aliases: Map<string, string>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
}

type OpenApiDoc = {
  info?: { title?: string; version?: string };
  paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>> | undefined>;
};

function isParamSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function summaryFor(op: OpenApiOperation | undefined): string | undefined {
  if (!op) return undefined;
  const summary = op.summary?.trim();
  if (summary) return summary;
  const description = op.description?.trim();
  if (!description) return undefined;
  return description.split("\n")[0]?.trim();
}

function classify(
  category: "collection" | "detail" | "action",
  method: HttpMethod,
): ResourceOperation | "action" {
  if (category === "collection") {
    if (method === "get") return "list";
    if (method === "post") return "create";
    return "action";
  }
  if (category === "detail") {
    if (method === "get") return "retrieve";
    if (method === "put") return "update";
    if (method === "patch") return "partial_update";
    if (method === "delete") return "delete";
    return "action";
  }
  return "action";
}

function getOrCreateResource(
  resources: Map<string, ResourceEntry>,
  key: string,
  app: string,
  resource: string,
  path: string,
): ResourceEntry {
  const existing = resources.get(key);
  if (existing) return existing;
  const entry: ResourceEntry = {
    key,
    app,
    resource,
    path,
    operations: {},
    actions: [],
  };
  resources.set(key, entry);
  return entry;
}

export function buildIndex(raw: string): SpecIndex {
  const doc = parseYaml(raw) as OpenApiDoc;
  const paths = doc.paths ?? {};
  const resources = new Map<string, ResourceEntry>();

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!apiPath.startsWith("/api/") || !pathItem) continue;

    const rel = apiPath.replace(/^\/api\//, "").replace(/\/+$/, "");
    const segments = rel.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    const paramIndex = segments.findIndex(isParamSegment);
    let category: "collection" | "detail" | "action";
    let baseSegments: string[];

    if (paramIndex === -1) {
      category = "collection";
      baseSegments = segments;
    } else if (paramIndex === segments.length - 1) {
      category = "detail";
      baseSegments = segments.slice(0, -1);
    } else {
      category = "action";
      baseSegments = segments.slice(0, paramIndex);
    }

    if (baseSegments.length === 0) continue;

    const key = baseSegments.join("/");
    const resource = baseSegments[baseSegments.length - 1]!;
    const app = baseSegments.slice(0, -1).join("/");
    const entry = getOrCreateResource(resources, key, app, resource, apiPath);

    if (category === "detail") {
      entry.detailPath = apiPath;
    }

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const kind = classify(category, method);
      const endpoint: EndpointOperation = {
        kind,
        method: method.toUpperCase(),
        path: apiPath,
        operationId: op.operationId,
        summary: summaryFor(op),
      };
      if (kind === "action") {
        entry.actions.push(endpoint);
      } else {
        if (!entry.operations[kind]) entry.operations[kind] = endpoint;
        if (op.tags?.[0]) entry.tag = entry.tag ?? op.tags[0];
        if (!entry.summary && endpoint.summary) entry.summary = endpoint.summary;
      }
    }
  }

  const aliases = buildAliases(resources);
  return {
    title: doc.info?.title ?? "NetBox REST API",
    version: doc.info?.version ?? "unknown",
    raw,
    resources,
    aliases,
  };
}

function buildAliases(resources: Map<string, ResourceEntry>): Map<string, string> {
  const aliases = new Map<string, string>();
  const resourceNameCounts = new Map<string, number>();

  for (const entry of resources.values()) {
    resourceNameCounts.set(entry.resource, (resourceNameCounts.get(entry.resource) ?? 0) + 1);
  }

  const add = (alias: string, key: string): void => {
    if (!alias) return;
    if (!aliases.has(alias)) aliases.set(alias, key);
  };

  for (const entry of resources.values()) {
    const key = entry.key;
    add(key, key);
    add(key.toLowerCase(), key);
    add(key.replace(/\//g, "."), key);
    add(key.replace(/\//g, ".").toLowerCase(), key);
    add(entry.path, key);
    add(entry.path.replace(/\/+$/, ""), key);
    add(entry.path.replace(/^\/api\//, ""), key);
    add(entry.path.replace(/^\/api\//, "").replace(/\/+$/, ""), key);
    if (resourceNameCounts.get(entry.resource) === 1) {
      add(entry.resource, key);
      add(entry.resource.toLowerCase(), key);
    }
  }
  return aliases;
}

const SPEC_FILENAME = "netbox-openapi.yaml";

/** Locate the OpenAPI spec, honoring an explicit override first. */
export function resolveSpecPath(config: Pick<Config, "specPath">): string {
  const candidates: string[] = [];
  if (config.specPath) candidates.push(resolve(config.specPath));
  candidates.push(join(__dirname, "..", "spec", SPEC_FILENAME));
  candidates.push(join(process.cwd(), SPEC_FILENAME));
  candidates.push(join(__dirname, "..", "..", SPEC_FILENAME));
  candidates.push(join(__dirname, "..", SPEC_FILENAME));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate the NetBox OpenAPI specification. Tried:\n  ${candidates.join("\n  ")}\n` +
      "Set NETBOX_SPEC_PATH to an explicit path.",
  );
}

export async function loadSpecIndex(config: Pick<Config, "specPath">): Promise<SpecIndex> {
  const path = resolveSpecPath(config);
  const raw = await readFile(path, "utf8");
  return buildIndex(raw);
}