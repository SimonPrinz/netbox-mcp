/**
 * In-process mock of the NetBox API plus the netbox-branching plugin endpoints.
 * Used by the unit and integration tests so they never depend on a live NetBox.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSpecIndex } from "../../src/netbox/spec.js";

/**
 * NetBox version reported by the mock's `/api/status/` endpoint. Derived from
 * the bundled OpenAPI spec so it stays in sync automatically instead of drifting
 * from a hardcoded value. Computed once per test process.
 */
let specVersionPromise: Promise<string> | undefined;
function getSpecVersion(): Promise<string> {
  specVersionPromise ??= loadSpecIndex({ specPath: undefined })
    .then((index) => index.version.split(/\s+/)[0] || index.version)
    .catch(() => "unknown");
  return specVersionPromise;
}

export interface MockBranch {
  id: number;
  name: string;
  description: string;
  status: string;
  schema_id: string;
  last_sync: string | null;
  merged_time: string | null;
  owner: { username: string };
  created: string;
  last_updated: string;
}

export interface MockState {
  branches: MockBranch[];
  lastBranchHeader: string | null;
  lastWritePath: string | null;
  mergeAttempts: number;
  conflictPending: boolean;
}

export interface MockNetbox {
  url: string;
  port: number;
  state: MockState;
  close(): Promise<void>;
}

export interface MockNetboxOptions {
  /** Delay (ms) before a provisioned/merged branch reaches its terminal status. */
  transitionDelayMs?: number;
  /** When true (default), the first unacknowledged merge returns HTTP 409. */
  mergeConflict?: boolean;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        resolvePromise({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startMockNetbox(options: MockNetboxOptions = {}): Promise<MockNetbox> {
  const netboxVersion = await getSpecVersion();
  const transitionDelayMs = options.transitionDelayMs ?? 50;
  const state: MockState = {
    branches: [],
    lastBranchHeader: null,
    lastWritePath: null,
    mergeAttempts: 0,
    conflictPending: options.mergeConflict ?? true,
  };
  let nextId = 1;
  let nextSchema = 1;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const branchHeader = req.headers["x-netbox-branch"];
      if (typeof branchHeader === "string" && method !== "GET") state.lastBranchHeader = branchHeader;

      if (path === "/__state") return sendJson(res, 200, state);

      if (path === "/api/plugins/branching/branches/" && method === "GET") {
        return sendJson(res, 200, {
          count: state.branches.length,
          next: null,
          previous: null,
          results: state.branches,
        });
      }

      if (path === "/api/plugins/branching/branches/" && method === "POST") {
        const body = await readBody(req);
        const branch: MockBranch = {
          id: nextId++,
          name: String(body.name ?? "branch"),
          description: String(body.description ?? ""),
          status: "provisioning",
          schema_id: `mock${(nextSchema++).toString().padStart(4, "0")}`,
          last_sync: null,
          merged_time: null,
          owner: { username: "admin" },
          created: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };
        state.branches.push(branch);
        setTimeout(() => {
          branch.status = "ready";
        }, transitionDelayMs);
        return sendJson(res, 201, branch);
      }

      let match = path.match(/^\/api\/plugins\/branching\/branches\/(\d+)\/$/);
      if (match && method === "GET") {
        const branch = state.branches.find((b) => b.id === Number(match![1]));
        return branch ? sendJson(res, 200, branch) : sendJson(res, 404, { detail: "Not found." });
      }

      match = path.match(/^\/api\/plugins\/branching\/branches\/(\d+)\/(sync|merge|revert)\/$/);
      if (match && method === "POST") {
        const branch = state.branches.find((b) => b.id === Number(match![1]));
        if (!branch) return sendJson(res, 404, { detail: "Not found." });
        const action = match[2]!;
        const body = await readBody(req);
        if (action === "merge") state.mergeAttempts++;
        if (action === "merge" && state.conflictPending && body.acknowledge_conflicts !== true) {
          return sendJson(res, 409, {
            detail: "All conflicts must be acknowledged before this action can proceed.",
            conflicts: [
              {
                id: 1,
                object_type: "dcim.site",
                object_id: 5,
                object_repr: "ai-site",
                action: { value: "update", label: "Updated" },
                conflicts: ["description"],
              },
            ],
          });
        }
        if (body.acknowledge_conflicts === true) state.conflictPending = false;
        const target = action === "merge" ? "merged" : "ready";
        branch.status = action === "merge" ? "merging" : action === "sync" ? "syncing" : "reverting";
        setTimeout(() => {
          branch.status = target;
          if (action === "merge") branch.merged_time = new Date().toISOString();
        }, transitionDelayMs);
        return sendJson(res, 200, {
          id: 100 + state.mergeAttempts,
          name: `${action} branch`,
          status: { value: "pending", label: "Pending" },
          job_id: `job-${action}-${branch.id}`,
        });
      }

      if (path === "/api/plugins/branching/changes/" && method === "GET") {
        const branchFilter = url.searchParams.get("branch");
        return sendJson(res, 200, {
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              id: 1,
              object_type: "dcim.site",
              object_id: 5,
              object_repr: "ai-site",
              action: { value: "create", label: "Created" },
              branched_from: branchFilter,
            },
          ],
        });
      }

      if (path === "/api/plugins/branching/branchable-models/" && method === "GET") {
        return sendJson(res, 200, [{ app_label: "dcim", model: "site", verbose_name: "site", verbose_name_plural: "sites" }]);
      }

      if (path === "/api/status/" && method === "GET") {
        return sendJson(res, 200, { "netbox-version": netboxVersion, plugins: { netbox_branching: "1.2.2" } });
      }

      if (path === "/api/dcim/sites/") {
        if (method === "POST") {
          const body = await readBody(req);
          state.lastWritePath = path;
          return sendJson(res, 201, { id: 5, name: body.name ?? "site", branch_header_seen: branchHeader ?? null });
        }
        if (method === "GET") {
          return sendJson(res, 200, {
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 5, name: "ai-site", branch_header_seen: branchHeader ?? null }],
          });
        }
      }

      match = path.match(/^\/api\/dcim\/sites\/(\d+)\/$/);
      if (match && (method === "PATCH" || method === "GET")) {
        return sendJson(res, 200, { id: Number(match[1]), branch_header_seen: branchHeader ?? null });
      }
      if (match && method === "DELETE") {
        res.writeHead(204);
        return res.end();
      }

      return sendJson(res, 404, { detail: `No mock route for ${method} ${path}` });
    })();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    state,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}