import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type Config } from "../../src/config.js";

const ALL_KEYS = [
  "NETBOX_URL", "NETBOX_TOKEN", "NETBOX_TOKEN_TYPE", "NETBOX_VERIFY_TLS", "NETBOX_TIMEOUT_MS",
  "NETBOX_ALLOW_WRITES", "NETBOX_REQUIRE_BRANCH", "NETBOX_DEFAULT_BRANCH", "NETBOX_SPEC_PATH",
  "MCP_HTTP_HOST", "MCP_HTTP_PORT", "MCP_HTTP_PATH", "MCP_HTTP_STATELESS", "MCP_AUTH_TOKEN",
  "MCP_ALLOWED_HOSTS", "MCP_ALLOWED_ORIGINS",
] as const;

function loadWith(overrides: Record<string, string>): Config {
  const saved = new Map<string, string | undefined>();
  for (const key of ALL_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return loadConfig();
  } finally {
    for (const key of ALL_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE = { NETBOX_URL: "https://nb.example.com/", NETBOX_TOKEN: "abc123" };

describe("loadConfig", () => {
  it("applies defaults and normalizes the base URL", () => {
    const config = loadWith(BASE);
    expect(config.netbox.baseUrl).toBe("https://nb.example.com");
    expect(config.netbox.tokenType).toBe("token");
    expect(config.netbox.verifyTls).toBe(true);
    expect(config.netbox.timeoutMs).toBe(30_000);
    expect(config.netbox.allowWrites).toBe(false);
    expect(config.netbox.requireBranch).toBe(false);
    expect(config.http.host).toBe("127.0.0.1");
    expect(config.http.port).toBe(3000);
    expect(config.http.path).toBe("/mcp");
    expect(config.http.stateless).toBe(false);
    expect(config.http.allowedHosts).toContain("127.0.0.1:3000");
  });

  it("preserves a sub-path in NETBOX_URL", () => {
    expect(loadWith({ ...BASE, NETBOX_URL: "https://nb.example.com/netbox/" }).netbox.baseUrl).toBe(
      "https://nb.example.com/netbox",
    );
  });

  it("detects bearer tokens with NETBOX_TOKEN_TYPE=auto", () => {
    expect(loadWith({ ...BASE, NETBOX_TOKEN: "key.token", NETBOX_TOKEN_TYPE: "auto" }).netbox.tokenType).toBe("bearer");
    expect(loadWith({ ...BASE, NETBOX_TOKEN: "plain", NETBOX_TOKEN_TYPE: "auto" }).netbox.tokenType).toBe("token");
  });

  it("parses write and branch settings", () => {
    const config = loadWith({
      ...BASE,
      NETBOX_ALLOW_WRITES: "true",
      NETBOX_REQUIRE_BRANCH: "true",
      NETBOX_DEFAULT_BRANCH: "br000001",
      NETBOX_VERIFY_TLS: "false",
    });
    expect(config.netbox.allowWrites).toBe(true);
    expect(config.netbox.requireBranch).toBe(true);
    expect(config.netbox.defaultBranch).toBe("br000001");
    expect(config.netbox.verifyTls).toBe(false);
  });

  it("normalizes the HTTP path", () => {
    expect(loadWith({ ...BASE, MCP_HTTP_PATH: "custom" }).http.path).toBe("/custom");
    expect(loadWith({ ...BASE, MCP_HTTP_PATH: "/custom/" }).http.path).toBe("/custom");
  });

  it("disables host validation when binding all interfaces without an allowlist", () => {
    expect(loadWith({ ...BASE, MCP_HTTP_HOST: "0.0.0.0" }).http.allowedHosts).toEqual([]);
  });

  it("fails fast on missing or invalid configuration", () => {
    expect(() => loadWith({ NETBOX_TOKEN: "abc" })).toThrow(ConfigError);
    expect(() => loadWith({ NETBOX_URL: "https://nb.example.com" })).toThrow(ConfigError);
    expect(() => loadWith({ ...BASE, NETBOX_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() => loadWith({ ...BASE, NETBOX_VERIFY_TLS: "maybe" })).toThrow(ConfigError);
    expect(() => loadWith({ ...BASE, MCP_HTTP_PORT: "abc" })).toThrow(ConfigError);
  });
});