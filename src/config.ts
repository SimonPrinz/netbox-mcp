/**
 * Runtime configuration, loaded and validated from environment variables.
 */

export interface NetBoxConfig {
  baseUrl: string;
  token: string;
  tokenType: "token" | "bearer";
  verifyTls: boolean;
  timeoutMs: number;
  allowWrites: boolean;
  /** When true, write operations must specify a branch. */
  requireBranch: boolean;
  /** Optional branch (schema ID or name) applied to requests that do not specify one. */
  defaultBranch?: string;
}

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  stateless: boolean;
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export interface Config {
  netbox: NetBoxConfig;
  http: HttpConfig;
  /** Optional override for the bundled OpenAPI spec location. */
  specPath?: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return defaultValue;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}".`);
}

function intEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}".`);
  }
  return parsed;
}

function listEnv(name: string): string[] {
  const raw = env(name);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizePath(input: string): string {
  const withLeading = input.startsWith("/") ? input : `/${input}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
}

export function loadConfig(): Config {
  const baseUrlRaw = env("NETBOX_URL");
  if (!baseUrlRaw) {
    throw new ConfigError(
      "NETBOX_URL is required (e.g. https://netbox.example.com).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    throw new ConfigError(`NETBOX_URL is not a valid URL: "${baseUrlRaw}".`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ConfigError("NETBOX_URL must use http:// or https://.");
  }

  const token = env("NETBOX_TOKEN");
  if (!token) {
    throw new ConfigError("NETBOX_TOKEN is required.");
  }

  const tokenTypeRaw = (env("NETBOX_TOKEN_TYPE") ?? "token").toLowerCase();
  let tokenType: "token" | "bearer";
  if (tokenTypeRaw === "auto") {
    tokenType = token.includes(".") ? "bearer" : "token";
  } else if (tokenTypeRaw === "token" || tokenTypeRaw === "bearer") {
    tokenType = tokenTypeRaw;
  } else {
    throw new ConfigError(
      `NETBOX_TOKEN_TYPE must be one of "token", "bearer" or "auto", got "${tokenTypeRaw}".`,
    );
  }

  const host = env("MCP_HTTP_HOST") ?? "127.0.0.1";
  const port = intEnv("MCP_HTTP_PORT", 3000, 1, 65535);
  const path = normalizePath(env("MCP_HTTP_PATH") ?? "/mcp");

  const configuredHosts = listEnv("MCP_ALLOWED_HOSTS");
  const allowedHosts =
    configuredHosts.length > 0
      ? configuredHosts
      : host === "0.0.0.0" || host === "::"
        ? []
        : [`${host}:${port}`, `localhost:${port}`];

  // The base URL is normalized without a trailing slash so path joins are predictable.
  const baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  return {
    netbox: {
      baseUrl,
      token,
      tokenType,
      verifyTls: boolEnv("NETBOX_VERIFY_TLS", true),
      timeoutMs: intEnv("NETBOX_TIMEOUT_MS", 30_000, 1_000, 600_000),
      allowWrites: boolEnv("NETBOX_ALLOW_WRITES", false),
      requireBranch: boolEnv("NETBOX_REQUIRE_BRANCH", false),
      defaultBranch: env("NETBOX_DEFAULT_BRANCH"),
    },
    http: {
      host,
      port,
      path,
      stateless: boolEnv("MCP_HTTP_STATELESS", false),
      authToken: env("MCP_AUTH_TOKEN"),
      allowedHosts,
      allowedOrigins: listEnv("MCP_ALLOWED_ORIGINS"),
    },
    specPath: env("NETBOX_SPEC_PATH"),
  };
}

export { ConfigError };