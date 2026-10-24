import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BranchResolutionError,
  NetBoxClient,
  NetBoxRequestError,
  endpointWithId,
} from "../../src/netbox/client.js";
import type { NetBoxConfig } from "../../src/config.js";
import { startMockNetbox, type MockNetbox } from "../helpers/mock-netbox.js";

describe("query serialization and URL handling", () => {
  it("expands arrays and skips empty values", () => {
    const qs = NetBoxClient.buildQuery({ a: "1", b: [1, 2], c: undefined, d: "", e: null, f: true });
    expect(qs).toBe("?a=1&b=1&b=2&f=true");
  });

  it("appends identifiers to collection paths", () => {
    expect(endpointWithId("/api/dcim/devices/", 5)).toBe("/api/dcim/devices/5/");
    expect(endpointWithId("/api/dcim/devices", 5)).toBe("/api/dcim/devices/5/");
  });
});

describe("NetBoxClient against a mock NetBox", () => {
  let mock: MockNetbox;
  let client: NetBoxClient;

  beforeAll(async () => {
    mock = await startMockNetbox();
    const config: NetBoxConfig = {
      baseUrl: mock.url.replace(/\/$/, ""),
      token: "tok",
      tokenType: "token",
      verifyTls: true,
      timeoutMs: 5_000,
      allowWrites: true,
      requireBranch: false,
    };
    client = new NetBoxClient(config);
  });

  afterAll(async () => {
    await mock.close();
  });

  it("rejects non-/api paths", () => {
    expect(() => client.resolveUrl("/v2/foo")).toThrow(NetBoxRequestError);
    expect(() => client.resolveUrl("http://evil.example/api/")).toThrow(NetBoxRequestError);
  });

  it("sends the X-NetBox-Branch header when a branch schema ID is given", async () => {
    await client.create("/api/dcim/sites/", { name: "ai-site" }, "mockschema");
    expect(mock.state.lastBranchHeader).toBe("mockschema");
  });

  it("surfaces HTTP errors with status", async () => {
    await expect(client.request("GET", "/api/does-not-exist/")).rejects.toMatchObject({
      name: "NetBoxRequestError",
      status: 404,
    });
  });

  it("lists and resolves branches", async () => {
    expect(await client.resolveBranch("main")).toBeUndefined();
    expect(await client.resolveBranch(undefined)).toBeUndefined();

    const created = await client.create<{ id: number; schema_id: string; name: string }>(
      "/api/plugins/branching/branches/",
      { name: "feature-x" },
    );
    client.invalidateBranchCache();
    const { schema_id: schema, name } = created.data;

    expect(await client.resolveBranch(schema)).toBe(schema);
    expect(await client.resolveBranch(String(created.data.id))).toBe(schema);
    expect(await client.resolveBranch(name)).toBe(schema);
  });

  it("throws BranchResolutionError for unknown branches", async () => {
    await expect(client.resolveBranch("nope")).rejects.toBeInstanceOf(BranchResolutionError);
  });

  it("reports ambiguous branch names", async () => {
    await client.create("/api/plugins/branching/branches/", { name: "duplicate" });
    await client.create("/api/plugins/branching/branches/", { name: "duplicate" });
    client.invalidateBranchCache();
    await expect(client.resolveBranch("duplicate")).rejects.toMatchObject({ name: "BranchResolutionError" });
  });
});