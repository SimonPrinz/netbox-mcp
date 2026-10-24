/**
 * MCP tool registrations backed by the NetBox REST API.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { BranchSummary, NetBoxClient, QueryParams } from "./netbox/client.js";
import { BranchResolutionError, NetBoxRequestError } from "./netbox/client.js";
import { resolveOrSuggest } from "./netbox/registry.js";
import type { ResourceEntry, SpecIndex } from "./netbox/spec.js";

const MAX_OUTPUT_CHARS = 200_000;
const BRANCH_POLL_INTERVAL_MS = 2_000;
const BRANCH_POLL_TIMEOUT_MS = 120_000;

export interface ToolDependencies {
  client: NetBoxClient;
  index: SpecIndex;
  config: Config;
}

const filterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

const filtersSchema = z
  .record(z.string(), filterValueSchema)
  .optional()
  .describe(
    "NetBox query filters, passed through as query parameters (e.g. {\"site\":\"dc1\",\"status\":\"active\"}). " +
      "Array values are sent as repeated parameters.",
  );

const endpointSchema = z
  .string()
  .min(1)
  .describe(
    "NetBox endpoint identifier. Accepts `app/resource` (e.g. `dcim/devices`), a dotted form " +
      "(`dcim.devices`), a bare resource name when unambiguous (`devices`), or a full API path " +
      "(`/api/dcim/devices/`). Use `netbox_list_object_types` to discover valid values.",
  );

const branchSchema = z
  .string()
  .optional()
  .describe(
    "NetBox branch to operate within, identified by schema ID (e.g. `td5smq0f`) or branch name. " +
      "Omit to target main (the live database). Use `netbox_list_branches` to discover branches.",
  );

function stringify(data: unknown): string {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data, null, 2);
    } catch {
      text = String(data);
    }
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n… output truncated at ${MAX_OUTPUT_CHARS} characters. Refine the query with filters/limit/fields.`;
  }
  return text;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: stringify(data) }] };
}

function fail(message: string, hint?: string): CallToolResult {
  const text = hint ? `${message}\n\n${hint}` : message;
  return { content: [{ type: "text", text }], isError: true };
}

function operationsOf(entry: ResourceEntry): string[] {
  return Object.keys(entry.operations).sort();
}

function describeResource(entry: ResourceEntry): string {
  const ops = operationsOf(entry);
  const detail = entry.detailPath ? `  detail: ${entry.detailPath}` : "";
  const actionNote = entry.actions.length > 0 ? `  (+${entry.actions.length} action endpoint(s) via netbox_request)` : "";
  return [
    `${entry.key}  [${ops.join(", ") || "no operations"}]`,
    `  collection: ${entry.path}${detail}`,
    entry.summary ? `  ${entry.summary}` : "",
    actionNote,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

class ResolveError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "ResolveError";
    this.hint = hint;
  }
}

/** Resolve an endpoint or throw a CallToolResult-friendly error. */
function requireResource(index: SpecIndex, endpoint: string): ResourceEntry {
  const { entry, suggestions } = resolveOrSuggest(index, endpoint);
  if (entry) return entry;
  const hint =
    suggestions.length > 0
      ? `Did you mean one of: ${suggestions.join(", ")}? Use netbox_list_object_types to browse all endpoints.`
      : "Use netbox_list_object_types to browse valid endpoints.";
  throw new ResolveError(`Unknown NetBox endpoint "${endpoint}".`, hint);
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Wrap a handler so failures become clean tool errors. */
function guarded(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ResolveError) {
        return fail(error.message, error.hint);
      }
      if (error instanceof BranchResolutionError) {
        const hint =
          error.candidates.length > 0
            ? `Available branches: ${error.candidates.join(", ")}.`
            : "No branches exist yet; create one with netbox_create_branch.";
        return fail(error.message, hint);
      }
      if (error instanceof NetBoxRequestError) {
        const status = error.status !== undefined ? ` (HTTP ${error.status})` : "";
        return fail(`NetBox request failed${status}: ${error.message}`);
      }
      return fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the branch context for a request. Returns the schema ID to send in the
 * `X-NetBox-Branch` header, or undefined for main.
 */
async function resolveBranchContext(
  deps: ToolDependencies,
  branchValue: unknown,
  forWrite: boolean,
): Promise<string | undefined> {
  const provided =
    typeof branchValue === "string" && branchValue.trim().length > 0 ? branchValue.trim() : undefined;
  const raw = provided ?? deps.config.netbox.defaultBranch;

  if (forWrite && deps.config.netbox.requireBranch) {
    const targetsMain = !raw || ["main", "default", "-"].includes(raw.toLowerCase());
    if (targetsMain) {
      throw new ResolveError(
        "This server requires writes to target a branch (NETBOX_REQUIRE_BRANCH is enabled), but no branch was given.",
        "Create or pick a branch (netbox_list_branches / netbox_create_branch), pass it via `branch`, then review with netbox_list_branch_changes and publish with netbox_merge_branch.",
      );
    }
  }

  if (!raw) return undefined;
  return await deps.client.resolveBranch(raw);
}

/** Wait for a branch to reach one of the terminal statuses. */
async function waitForBranch(
  client: NetBoxClient,
  id: number,
  terminal: string[],
  timeoutMs = BRANCH_POLL_TIMEOUT_MS,
): Promise<{ branch: BranchSummary; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.request<BranchSummary>("GET", `/api/plugins/branching/branches/${id}/`);
    const branch = response.data;
    if (terminal.includes(branch.status)) return { branch, timedOut: false };
    if (Date.now() >= deadline) return { branch, timedOut: true };
    await sleep(BRANCH_POLL_INTERVAL_MS);
  }
}

function projectBranch(branch: BranchSummary): Record<string, unknown> {
  return {
    id: branch.id,
    name: branch.name,
    status: branch.status,
    schema_id: branch.schema_id,
    description: branch.description,
    owner: branch.owner?.username ?? branch.owner?.display ?? null,
    last_sync: branch.last_sync ?? null,
    merged_time: branch.merged_time ?? null,
    created: branch.created ?? null,
  };
}

/** Turn a 409 conflict response into a readable tool error. */
function conflictResult(action: string, error: NetBoxRequestError): CallToolResult {
  const parsed = parseJson(error.body) as { detail?: string; conflicts?: unknown } | undefined;
  const detail = parsed?.detail ?? "Conflicting changes must be acknowledged before proceeding.";
  const conflicts = parsed?.conflicts ?? [];
  return fail(
    `${action} aborted (HTTP 409): ${detail}`,
    `Conflicts:\n${stringify(conflicts)}\n\nReview them, then retry with acknowledge_conflicts: true to let the branch version win.`,
  );
}

export function registerTools(server: McpServer, deps: ToolDependencies): void {
  const { client, index, config } = deps;

  server.registerTool(
    "netbox_list_object_types",
    {
      title: "List NetBox object types",
      description:
        "Discover the NetBox REST resources available through this server, including their endpoint keys " +
        "and the operations supported (list, create, retrieve, update, partial_update, delete).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter applied to endpoint keys, e.g. `device` or `ipam`."),
        app: z
          .string()
          .optional()
          .describe("Restrict results to a single NetBox app, e.g. `dcim`, `ipam`, `tenancy`."),
      },
    },
    guarded(async (args) => {
      const query = String(args.query ?? "").trim().toLowerCase();
      const app = String(args.app ?? "").trim().toLowerCase();
      const entries = [...index.resources.values()]
        .filter((entry) => (app ? entry.app.toLowerCase() === app || entry.app.toLowerCase().endsWith(`/${app}`) : true))
        .filter((entry) => (query ? entry.key.toLowerCase().includes(query) : true))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (entries.length === 0) {
        return ok(
          `No object types matched query="${query}" app="${app}". ${index.resources.size} endpoints are available in total.`,
        );
      }
      const body = entries.map(describeResource).join("\n\n");
      return ok(`${entries.length} matching object type(s):\n\n${body}`);
    }),
  );

  server.registerTool(
    "netbox_list_objects",
    {
      title: "List NetBox objects",
      description:
        "List objects from a NetBox endpoint. Supports NetBox query filters and pagination controls.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        endpoint: endpointSchema,
        filters: filtersSchema,
        branch: branchSchema,
        limit: z.number().int().min(0).optional().describe("Maximum number of results to return (NetBox `limit`)."),
        offset: z.number().int().min(0).optional().describe("Number of results to skip (NetBox `offset`)."),
        order: z.string().optional().describe("Field(s) to order results by, e.g. `name` or `-created`."),
        fields: z.string().optional().describe("Comma-separated list of fields to include in the response."),
        omit: z.string().optional().describe("Comma-separated list of fields to exclude from the response."),
        brief: z.boolean().optional().describe("Return only brief fields for each object."),
      },
    },
    guarded(async (args) => {
      const entry = requireResource(index, String(args.endpoint));
      if (!entry.operations.list) {
        return fail(`Endpoint "${entry.key}" does not support listing.`);
      }
      const branchSchemaId = await resolveBranchContext(deps, args.branch, false);
      const query: QueryParams = {};
      if (args.filters && typeof args.filters === "object") {
        Object.assign(query, args.filters as QueryParams);
      }
      if (args.limit !== undefined) query.limit = args.limit as number;
      if (args.offset !== undefined) query.offset = args.offset as number;
      if (args.order !== undefined) query.order = args.order as string;
      if (args.fields !== undefined) query.fields = args.fields as string;
      if (args.omit !== undefined) query.omit = args.omit as string;
      if (args.brief !== undefined) query.brief = args.brief as boolean;

      const response = await client.list(entry.path, query, branchSchemaId);
      return ok({
        endpoint: entry.key,
        path: entry.path,
        branch: branchSchemaId ?? "main",
        query,
        result: response.data,
      });
    }),
  );

  server.registerTool(
    "netbox_get_object",
    {
      title: "Get a NetBox object",
      description: "Retrieve a single NetBox object by its numeric (or slug) identifier.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        endpoint: endpointSchema,
        id: z.union([z.string(), z.number()]).describe("Object ID (or slug where the endpoint uses one)."),
        branch: branchSchema,
      },
    },
    guarded(async (args) => {
      const entry = requireResource(index, String(args.endpoint));
      if (!entry.operations.retrieve) {
        return fail(`Endpoint "${entry.key}" does not support retrieval by ID.`);
      }
      const branchSchemaId = await resolveBranchContext(deps, args.branch, false);
      const response = await client.retrieve(entry.path, args.id as string | number, undefined, branchSchemaId);
      return ok({ endpoint: entry.key, id: args.id, branch: branchSchemaId ?? "main", result: response.data });
    }),
  );

  if (config.netbox.allowWrites) {
    server.registerTool(
      "netbox_create_object",
      {
        title: "Create a NetBox object",
        description: "Create a new NetBox object. Provide the field values as `data`.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          endpoint: endpointSchema,
          data: z.record(z.string(), z.unknown()).describe("Object fields to send as the JSON request body."),
          branch: branchSchema,
        },
      },
      guarded(async (args) => {
        const entry = requireResource(index, String(args.endpoint));
        if (!entry.operations.create) {
          return fail(`Endpoint "${entry.key}" does not support creation.`);
        }
        const branchSchemaId = await resolveBranchContext(deps, args.branch, true);
        const response = await client.create(entry.path, args.data, branchSchemaId);
        return ok({
          endpoint: entry.key,
          branch: branchSchemaId ?? "main",
          status: response.status,
          result: response.data,
        });
      }),
    );

    server.registerTool(
      "netbox_update_object",
      {
        title: "Update a NetBox object",
        description:
          "Update an existing NetBox object. Uses PATCH by default (partial update); set `partial: false` for PUT.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          endpoint: endpointSchema,
          id: z.union([z.string(), z.number()]).describe("Object ID to update."),
          data: z.record(z.string(), z.unknown()).describe("Fields to update."),
          partial: z
            .boolean()
            .optional()
            .describe("When true (default) uses PATCH; when false uses PUT (full replacement)."),
          branch: branchSchema,
        },
      },
      guarded(async (args) => {
        const entry = requireResource(index, String(args.endpoint));
        const partial = args.partial !== false;
        if (partial && !entry.operations.partial_update) {
          return fail(`Endpoint "${entry.key}" does not support partial updates (PATCH).`);
        }
        if (!partial && !entry.operations.update) {
          return fail(`Endpoint "${entry.key}" does not support full updates (PUT).`);
        }
        const branchSchemaId = await resolveBranchContext(deps, args.branch, true);
        const response = await client.update(entry.path, args.id as string | number, args.data, partial, branchSchemaId);
        return ok({
          endpoint: entry.key,
          id: args.id,
          method: partial ? "PATCH" : "PUT",
          branch: branchSchemaId ?? "main",
          status: response.status,
          result: response.data,
        });
      }),
    );

    server.registerTool(
      "netbox_delete_object",
      {
        title: "Delete a NetBox object",
        description: "Delete an existing NetBox object by ID.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          endpoint: endpointSchema,
          id: z.union([z.string(), z.number()]).describe("Object ID to delete."),
          branch: branchSchema,
        },
      },
      guarded(async (args) => {
        const entry = requireResource(index, String(args.endpoint));
        if (!entry.operations.delete) {
          return fail(`Endpoint "${entry.key}" does not support deletion.`);
        }
        const branchSchemaId = await resolveBranchContext(deps, args.branch, true);
        const response = await client.delete(entry.path, args.id as string | number, branchSchemaId);
        return ok({
          endpoint: entry.key,
          id: args.id,
          branch: branchSchemaId ?? "main",
          status: response.status,
          deleted: true,
        });
      }),
    );
  }

  server.registerTool(
    "netbox_request",
    {
      title: "Call an arbitrary NetBox API endpoint",
      description:
        "Escape hatch for any documented NetBox REST endpoint, including custom action routes that the CRUD " +
        "tools do not cover (e.g. `/api/dcim/devices/{id}/render-config/`). The path must start with `/api/`.",
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe("API path starting with `/api/`. Include any path parameters, e.g. `/api/ipam/prefixes/42/available-ips/`."),
        query: z
          .record(z.string(), filterValueSchema)
          .optional()
          .describe("Optional query parameters."),
        body: z.record(z.string(), z.unknown()).optional().describe("Optional JSON request body."),
        branch: branchSchema,
      },
    },
    guarded(async (args) => {
      const method = String(args.method).toUpperCase();
      const path = String(args.path);
      if (method !== "GET" && !config.netbox.allowWrites) {
        return fail(
          `Write operations are disabled (NETBOX_ALLOW_WRITES is not set). Only GET is allowed via netbox_request.`,
        );
      }
      const branchSchemaId = await resolveBranchContext(deps, args.branch, method !== "GET");
      const response = await client.request(method, path, {
        query: (args.query as QueryParams | undefined) ?? undefined,
        body: args.body,
        branchSchemaId,
      });
      return ok({ method, path, branch: branchSchemaId ?? "main", status: response.status, result: response.data });
    }),
  );

  /* ------------------------------- branches ------------------------------- */

  server.registerTool(
    "netbox_list_branches",
    {
      title: "List NetBox branches",
      description:
        "List NetBox branching plugin branches with their status and schema ID. Use the schema ID (or name) " +
        "as the `branch` argument on the other tools to work inside a branch.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        status: z.string().optional().describe("Filter by branch status, e.g. `ready`, `merged`, `failed`."),
        name: z.string().optional().describe("Filter by branch name."),
        limit: z.number().int().min(0).optional().describe("Maximum number of branches to return."),
      },
    },
    guarded(async (args) => {
      const query: QueryParams = {};
      if (args.status !== undefined) query.status = args.status as string;
      if (args.name !== undefined) query.name = args.name as string;
      if (args.limit !== undefined) query.limit = args.limit as number;

      const response = await client.request<{ results?: BranchSummary[] } | BranchSummary[]>(
        "GET",
        "/api/plugins/branching/branches/",
        { query },
      );
      const data = response.data;
      const branches = Array.isArray(data) ? data : (data?.results ?? []);
      if (branches.length === 0) {
        return ok("No branches found. Create one with netbox_create_branch (requires writes to be enabled).");
      }
      return ok(branches.map(projectBranch));
    }),
  );

  server.registerTool(
    "netbox_get_branch",
    {
      title: "Get a NetBox branch",
      description: "Retrieve a single NetBox branch by schema ID, numeric ID or name.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        branch: z.string().min(1).describe("Branch schema ID, numeric ID or name."),
      },
    },
    guarded(async (args) => {
      const value = String(args.branch);
      const branch = await client.findBranch(value);
      if (!branch) {
        const available = (await client.listBranches()).map((b) => `${b.name} (${b.schema_id})`);
        throw new BranchResolutionError(`Branch "${value}" not found.`, available);
      }
      return ok(projectBranch(branch));
    }),
  );

  server.registerTool(
    "netbox_list_branch_changes",
    {
      title: "List changes staged in a branch",
      description:
        "List the change diffs (pending creations, updates and deletions) recorded in a branch — i.e. what " +
        "would be written to main if the branch were merged.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        branch: z.string().min(1).describe("Branch schema ID or name to inspect."),
        limit: z.number().int().min(0).optional().describe("Maximum number of changes to return."),
        offset: z.number().int().min(0).optional().describe("Number of changes to skip."),
      },
    },
    guarded(async (args) => {
      const schemaId = await client.resolveBranch(String(args.branch));
      if (!schemaId) {
        return fail(`"${args.branch}" resolves to main; provide a branch to list staged changes.`);
      }
      const query: QueryParams = { branch: schemaId };
      if (args.limit !== undefined) query.limit = args.limit as number;
      if (args.offset !== undefined) query.offset = args.offset as number;
      const response = await client.request("GET", "/api/plugins/branching/changes/", { query });
      const data = response.data;
      const changes = Array.isArray(data) ? data : (data as { results?: unknown[] })?.results ?? [];
      if (changes.length === 0) {
        return ok({ branch: args.branch, schema_id: schemaId, changes: [], note: "No changes staged in this branch." });
      }
      return ok({ branch: args.branch, schema_id: schemaId, changes });
    }),
  );

  if (config.netbox.allowWrites) {
    server.registerTool(
      "netbox_create_branch",
      {
        title: "Create a NetBox branch",
        description:
          "Create a new NetBox branch. Provisioning happens automatically; set `wait: true` to poll until the " +
          "branch is `ready` before returning so it can be used immediately.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          name: z.string().min(1).describe("Branch name."),
          description: z.string().optional().describe("Optional branch description."),
          wait: z.boolean().optional().describe("When true, wait until the branch reaches status `ready` (or fails)."),
        },
      },
      guarded(async (args) => {
        const body: Record<string, unknown> = { name: args.name };
        if (args.description !== undefined) body.description = args.description;
        const response = await client.create<BranchSummary>("/api/plugins/branching/branches/", body);
        client.invalidateBranchCache();
        let branch = response.data;

        if (args.wait === true && typeof branch.id === "number") {
          const outcome = await waitForBranch(client, branch.id, ["ready", "failed"]);
          branch = outcome.branch;
          return ok({ branch: projectBranch(branch), waited: true, timedOut: outcome.timedOut });
        }
        return ok({
          branch: projectBranch(branch),
          note: "Provisioning is automatic; poll netbox_get_branch until status is `ready` before writing.",
        });
      }),
    );

    const lifecycleTool = (
      name: string,
      title: string,
      action: string,
      description: string,
      terminal: string[],
    ): void => {
      server.registerTool(
        name,
        {
          title,
          description,
          annotations: { readOnlyHint: false, destructiveHint: action !== "Sync", idempotentHint: action === "Sync", openWorldHint: true },
          inputSchema: {
            branch: z.string().min(1).describe("Branch schema ID, numeric ID or name."),
            commit: z
              .boolean()
              .optional()
              .describe("When false, performs a dry run that is rolled back at the end (default true)."),
            acknowledge_conflicts: z
              .boolean()
              .optional()
              .describe("When true, proceed despite conflicts, letting the branch value overwrite main."),
            wait: z
              .boolean()
              .optional()
              .describe(`When true, wait until the branch reaches a terminal status (${terminal.join("/")}).`),
          },
        },
        guarded(async (args) => {
          const value = String(args.branch);
          const branch = await client.findBranch(value);
          if (!branch) {
            const available = (await client.listBranches()).map((b) => `${b.name} (${b.schema_id})`);
            throw new BranchResolutionError(`Branch "${value}" not found.`, available);
          }
          const body = {
            commit: args.commit !== false,
            acknowledge_conflicts: args.acknowledge_conflicts === true,
          };
          try {
            const response = await client.request(
              "POST",
              `/api/plugins/branching/branches/${branch.id}/${action.toLowerCase()}/`,
              { body },
            );
            const result: Record<string, unknown> = {
              branch: value,
              action,
              job: response.data,
            };
            if (args.wait === true) {
              const outcome = await waitForBranch(client, branch.id, terminal);
              result.branch = projectBranch(outcome.branch);
              result.waited = true;
              result.timedOut = outcome.timedOut;
            }
            return ok(result);
          } catch (error) {
            if (error instanceof NetBoxRequestError && error.status === 409) {
              return conflictResult(action, error);
            }
            throw error;
          }
        }),
      );
    };

    lifecycleTool(
      "netbox_sync_branch",
      "Sync a NetBox branch with main",
      "Sync",
      "Synchronize changes from main into a branch, updating the branch with the latest live data.",
      ["ready", "failed"],
    );
    lifecycleTool(
      "netbox_merge_branch",
      "Merge a NetBox branch into main",
      "Merge",
      "Merge a branch into main (the live database). This publishes the branch's staged changes. " +
        "Returns HTTP 409 with conflict details if main and the branch diverged; retry with acknowledge_conflicts: true to override.",
      ["merged", "failed"],
    );
    lifecycleTool(
      "netbox_revert_branch",
      "Revert a NetBox branch from main",
      "Revert",
      "Revert a previously merged branch, undoing its changes on main.",
      ["ready", "failed"],
    );
  }
}