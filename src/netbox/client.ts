/**
 * Thin HTTP client for the NetBox REST API.
 *
 * Handles authentication, branch context (via the `X-NetBox-Branch` header),
 * query serialization (including NetBox's repeated array parameters), timeouts,
 * TLS verification and error surfacing.
 */
import { Agent, type Dispatcher } from "undici";
import type { NetBoxConfig } from "../config.js";

export type QueryValue = string | number | boolean | Array<string | number> | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface NetBoxResponse<T = unknown> {
  status: number;
  data: T;
  contentType: string | undefined;
}

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  timeoutMs?: number;
  /**
   * NetBox branch schema ID. When set, adds the `X-NetBox-Branch` header so the
   * request is executed within that branch. Omit to target main.
   */
  branchSchemaId?: string;
}

/** Minimal representation of a netbox-branching branch. */
export interface BranchSummary {
  id: number;
  name: string;
  status: string;
  schema_id: string;
  description?: string;
  last_sync?: string | null;
  merged_time?: string | null;
  owner?: { display?: string; username?: string } | null;
  [key: string]: unknown;
}

/** Raised when a branch identifier cannot be resolved to a unique branch. */
export class BranchResolutionError extends Error {
  readonly candidates: string[];

  constructor(message: string, candidates: string[] = []) {
    super(message);
    this.name = "BranchResolutionError";
    this.candidates = candidates;
  }
}

/** Values that explicitly select the main (default) branch. */
const MAIN_ALIASES = new Set(["", "main", "default", "-"]);
const BRANCH_CACHE_TTL_MS = 15_000;

export class NetBoxRequestError extends Error {
  readonly status: number | undefined;
  readonly method: string;
  readonly url: string;
  readonly body: string;

  constructor(message: string, options: {
    status?: number;
    method: string;
    url: string;
    body?: string;
    cause?: unknown;
  }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NetBoxRequestError";
    this.status = options.status;
    this.method = options.method;
    this.url = options.url;
    this.body = options.body ?? "";
  }
}

export class NetBoxClient {
  private readonly dispatcher: Dispatcher | undefined;
  private readonly authHeader: string;
  private branchCache?: { at: number; branches: BranchSummary[] };

  constructor(private readonly config: NetBoxConfig) {
    this.dispatcher = config.verifyTls
      ? undefined
      : new Agent({ connect: { rejectUnauthorized: false } });
    this.authHeader =
      config.tokenType === "bearer" ? `Bearer ${config.token}` : `Token ${config.token}`;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get allowWrites(): boolean {
    return this.config.allowWrites;
  }

  /** Serialize a query object, expanding arrays into repeated keys. */
  static buildQuery(params: QueryParams | undefined): string {
    if (!params) return "";
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) search.append(key, String(item));
      } else {
        search.append(key, String(value));
      }
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
  }

  /**
   * Build an absolute NetBox URL from an API path. The path must begin with
   * `/api/` (or `/`) and must not be an absolute URL, otherwise this throws.
   */
  resolveUrl(path: string, query?: QueryParams): string {
    if (!path.startsWith("/")) {
      throw new NetBoxRequestError(
        `Invalid API path "${path}": paths must start with "/".`,
        { method: "GET", url: path },
      );
    }
    if (!path.startsWith("/api/") && path !== "/api") {
      throw new NetBoxRequestError(
        `Invalid API path "${path}": only "/api/..." paths are allowed.`,
        { method: "GET", url: path },
      );
    }
    return `${this.config.baseUrl}${path}${NetBoxClient.buildQuery(query)}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<NetBoxResponse<T>> {
    const upperMethod = method.toUpperCase();
    const url = this.resolveUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (options.branchSchemaId) {
      headers["X-NetBox-Branch"] = options.branchSchemaId;
    }
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      const init = {
        method: upperMethod,
        headers,
        body: payload,
        signal: controller.signal,
        // undici dispatcher controls TLS verification; global fetch accepts it at runtime.
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher };
      response = await fetch(url, init as RequestInit);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new NetBoxRequestError(
          `Request to NetBox timed out after ${timeoutMs}ms (${upperMethod} ${path}).`,
          { method: upperMethod, url, cause: error },
        );
      }
      throw new NetBoxRequestError(
        `Failed to reach NetBox at ${this.config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { method: upperMethod, url, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    let text = "";
    try {
      text = await response.text();
    } catch {
      // ignore body read errors; status is what matters
    }

    if (!response.ok) {
      let detail = humanizeErrorBody(text);
      if (response.status === 400 && /not ready/i.test(text)) {
        detail += " (the branch may still be provisioning; wait for status \"ready\")";
      }
      throw new NetBoxRequestError(
        `NetBox returned HTTP ${response.status} for ${upperMethod} ${path}${text ? `: ${detail}` : ""}`,
        { status: response.status, method: upperMethod, url, body: text },
      );
    }

    let data: unknown = text;
    if (text.length === 0) {
      data = null;
    } else if (contentType?.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T, contentType };
  }

  list<T = unknown>(path: string, query?: QueryParams, branchSchemaId?: string): Promise<NetBoxResponse<T>> {
    return this.request<T>("GET", path, { query, branchSchemaId });
  }

  retrieve<T = unknown>(
    path: string,
    id: string | number,
    query?: QueryParams,
    branchSchemaId?: string,
  ): Promise<NetBoxResponse<T>> {
    return this.request<T>("GET", endpointWithId(path, id), { query, branchSchemaId });
  }

  create<T = unknown>(path: string, body: unknown, branchSchemaId?: string): Promise<NetBoxResponse<T>> {
    return this.request<T>("POST", path, { body, branchSchemaId });
  }

  update<T = unknown>(
    path: string,
    id: string | number,
    body: unknown,
    partial: boolean,
    branchSchemaId?: string,
  ): Promise<NetBoxResponse<T>> {
    return this.request<T>(partial ? "PATCH" : "PUT", endpointWithId(path, id), {
      body,
      branchSchemaId,
    });
  }

  delete<T = unknown>(path: string, id: string | number, branchSchemaId?: string): Promise<NetBoxResponse<T>> {
    return this.request<T>("DELETE", endpointWithId(path, id), { branchSchemaId });
  }

  /* ------------------------------- branches ------------------------------- */

  /** Fetch all branches (cached briefly). */
  async listBranches(force = false): Promise<BranchSummary[]> {
    const now = Date.now();
    if (!force && this.branchCache && now - this.branchCache.at < BRANCH_CACHE_TTL_MS) {
      return this.branchCache.branches;
    }
    const response = await this.request<unknown>("GET", "/api/plugins/branching/branches/", {
      query: { limit: 0 },
    });
    const data = response.data as { results?: BranchSummary[] } | BranchSummary[];
    const branches = Array.isArray(data) ? data : (data?.results ?? []);
    this.branchCache = { at: now, branches };
    return branches;
  }

  /** Drop the cached branch list (e.g. after creating a branch). */
  invalidateBranchCache(): void {
    this.branchCache = undefined;
  }

  /**
   * Find a branch by schema ID, numeric ID or name. Names are not unique, so an
   * ambiguous name throws with the candidate schema IDs.
   */
  async findBranch(value: string): Promise<BranchSummary | undefined> {
    const needle = value.trim();
    if (!needle) return undefined;

    const search = (branches: BranchSummary[]): BranchSummary | undefined => {
      const bySchema = branches.find((b) => b.schema_id === needle || b.schema_id?.toLowerCase() === needle.toLowerCase());
      if (bySchema) return bySchema;
      const byId = branches.find((b) => String(b.id) === needle);
      if (byId) return byId;
      const byName = branches.filter((b) => b.name === needle);
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) {
        throw new BranchResolutionError(
          `Branch name "${needle}" is ambiguous; use a schema ID instead.`,
          byName.map((b) => `${b.name} (${b.schema_id})`),
        );
      }
      return undefined;
    };

    let branch = search(await this.listBranches());
    if (!branch) {
      branch = search(await this.listBranches(true));
    }
    return branch;
  }

  /**
   * Resolve a user-supplied branch identifier to its schema ID for use in the
   * `X-NetBox-Branch` header. Returns undefined for main / no branch.
   */
  async resolveBranch(value: string | undefined): Promise<string | undefined> {
    if (value === undefined) return undefined;
    const needle = value.trim();
    if (MAIN_ALIASES.has(needle.toLowerCase())) return undefined;

    const branch = await this.findBranch(needle);
    if (!branch) {
      const available = (await this.listBranches()).map((b) => `${b.name} (${b.schema_id})`);
      throw new BranchResolutionError(
        `Branch "${value}" not found.`,
        available,
      );
    }
    return branch.schema_id;
  }
}

/** Append an identifier to a collection endpoint such as `/api/dcim/devices/`. */
export function endpointWithId(path: string, id: string | number): string {
  const base = path.endsWith("/") ? path : `${path}/`;
  return `${base}${encodeURIComponent(String(id))}/`;
}

/** Extract a concise message from a NetBox error body (JSON or plain text). */
function humanizeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.detail === "string") return record.detail;
      if (Array.isArray(record.non_field_errors) && record.non_field_errors.length > 0) {
        return record.non_field_errors.map(String).join("; ");
      }
    }
  } catch {
    // fall through to raw text
  }
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}