import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, startTestServer, type McpClient, type TestServer } from "../helpers/mcp.js";
import { startMockNetbox, type MockNetbox } from "../helpers/mock-netbox.js";

const READ_TOOLS = [
  "netbox_list_object_types", "netbox_list_objects", "netbox_get_object", "netbox_request",
  "netbox_list_branches", "netbox_get_branch", "netbox_list_branch_changes",
];
const WRITE_TOOLS = [
  "netbox_create_object", "netbox_update_object", "netbox_delete_object",
  "netbox_create_branch", "netbox_sync_branch", "netbox_merge_branch", "netbox_revert_branch",
];

describe("read-only profile", () => {
  let mock: MockNetbox;
  let server: TestServer;
  let mcp: McpClient;

  beforeAll(async () => {
    mock = await startMockNetbox();
    server = await startTestServer({ NETBOX_URL: mock.url, NETBOX_TOKEN: "tok" });
    mcp = await connectMcp(server.url);
  });
  afterAll(async () => {
    await mcp.close();
    await server.close();
    await mock.close();
  });

  it("registers only the read-only tools", async () => {
    const names = (await mcp.listTools()).map((t) => t.name);
    for (const tool of READ_TOOLS) expect(names).toContain(tool);
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
    expect(names).toHaveLength(7);
  });

  it("exposes a branch parameter on read tools", async () => {
    const tools = await mcp.listTools();
    const listObjects = tools.find((t) => t.name === "netbox_list_objects");
    const getObject = tools.find((t) => t.name === "netbox_get_object");
    expect(listObjects?.inputSchema?.properties).toHaveProperty("branch");
    expect(getObject?.inputSchema?.properties).toHaveProperty("branch");
  });

  it("lists object types and suggests alternatives", async () => {
    const good = await mcp.callTool("netbox_list_object_types", { query: "devices" });
    expect(mcp.toolError(good)).toBe(false);
    expect(mcp.toolText(good)).toContain("dcim/devices");

    const bad = await mcp.callTool("netbox_list_objects", { endpoint: "dcim/devicez" });
    expect(mcp.toolError(bad)).toBe(true);
    expect(mcp.toolText(bad)).toContain("Did you mean");
  });

  it("lists branches and reports unknown ones", async () => {
    const branches = await mcp.callTool("netbox_list_branches");
    expect(mcp.toolError(branches)).toBe(false);

    const missing = await mcp.callTool("netbox_get_branch", { branch: "nope" });
    expect(mcp.toolError(missing)).toBe(true);
    expect(mcp.toolText(missing)).toContain("not found");
  });

  it("blocks writes through netbox_request", async () => {
    const response = await mcp.callTool("netbox_request", { method: "POST", path: "/api/dcim/sites/", body: { name: "x" } });
    expect(mcp.toolError(response)).toBe(true);
    expect(mcp.toolText(response)).toMatch(/disabled/i);
  });

  it("serves resources", async () => {
    expect(await mcp.readResource("netbox://health")).toContain('"allowWrites": false');
    expect(await mcp.readResource("netbox://endpoints")).toContain('"resourceCount"');
  });
});

describe("write profile with branch enforcement", () => {
  let mock: MockNetbox;
  let server: TestServer;
  let mcp: McpClient;

  beforeAll(async () => {
    mock = await startMockNetbox();
    server = await startTestServer({
      NETBOX_URL: mock.url,
      NETBOX_TOKEN: "tok",
      NETBOX_ALLOW_WRITES: "true",
      NETBOX_REQUIRE_BRANCH: "true",
    });
    mcp = await connectMcp(server.url);
  });
  afterAll(async () => {
    await mcp.close();
    await server.close();
    await mock.close();
  });

  it("registers the full tool set", async () => {
    const names = (await mcp.listTools()).map((t) => t.name);
    expect(names).toHaveLength(14);
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) expect(names).toContain(tool);
  });

  it("refuses writes without a branch", async () => {
    const create = await mcp.callTool("netbox_create_object", { endpoint: "dcim/sites", data: { name: "x" } });
    expect(mcp.toolError(create)).toBe(true);
    expect(mcp.toolText(create)).toMatch(/requires writes to target a branch/);

    const viaRequest = await mcp.callTool("netbox_request", { method: "POST", path: "/api/dcim/sites/", body: {} });
    expect(mcp.toolError(viaRequest)).toBe(true);
    expect(mcp.toolText(viaRequest)).toMatch(/requires writes to target a branch/);
  });

  it("runs the create → write → review → merge → revert lifecycle", async () => {
    const created = await mcp.callTool("netbox_create_branch", { name: "ai-changes", wait: true });
    expect(mcp.toolError(created)).toBe(false);
    const branch = mcp.toolJson<{ branch: { id: number; status: string; schema_id: string } }>(created).branch;
    expect(branch.status).toBe("ready");
    const schema = branch.schema_id;

    const resolved = await mcp.callTool("netbox_get_branch", { branch: schema });
    expect(mcp.toolJson<{ schema_id: string }>(resolved).schema_id).toBe(schema);

    const write = await mcp.callTool("netbox_create_object", {
      endpoint: "dcim/sites",
      data: { name: "ai-site" },
      branch: schema,
    });
    expect(mcp.toolError(write)).toBe(false);
    expect(mock.state.lastBranchHeader).toBe(schema);

    const read = await mcp.callTool("netbox_list_objects", { endpoint: "dcim/sites", branch: schema });
    expect(mcp.toolJson<{ result: { results: Array<{ branch_header_seen: string }> } }>(read).result.results[0]!.branch_header_seen).toBe(schema);

    const changes = await mcp.callTool("netbox_list_branch_changes", { branch: schema });
    expect(mcp.toolError(changes)).toBe(false);
    expect(mcp.toolJson<{ changes: unknown[] }>(changes).changes).toHaveLength(1);

    const mergeConflict = await mcp.callTool("netbox_merge_branch", { branch: schema });
    expect(mcp.toolError(mergeConflict)).toBe(true);
    expect(mcp.toolText(mergeConflict)).toContain("Conflicts");

    const merge = await mcp.callTool("netbox_merge_branch", { branch: schema, acknowledge_conflicts: true, wait: true });
    expect(mcp.toolError(merge)).toBe(false);
    expect(mcp.toolJson<{ branch: { status: string } }>(merge).branch.status).toBe("merged");

    const revert = await mcp.callTool("netbox_revert_branch", { branch: schema, wait: true });
    expect(mcp.toolError(revert)).toBe(false);
    expect(mcp.toolJson<{ branch: { status: string } }>(revert).branch.status).toBe("ready");
  });
});

describe("bearer-token protection", () => {
  let mock: MockNetbox;
  let server: TestServer;

  beforeAll(async () => {
    mock = await startMockNetbox();
    server = await startTestServer({ NETBOX_URL: mock.url, NETBOX_TOKEN: "tok", MCP_AUTH_TOKEN: "s3cret" });
  });
  afterAll(async () => {
    await server.close();
    await mock.close();
  });

  it("rejects requests without a valid token", async () => {
    await expect(connectMcp(server.url)).rejects.toThrow(/initialize failed/);
    const health = await fetch(`${server.url}/healthz`);
    expect(health.status).toBe(200);
  });

  it("accepts requests with the token", async () => {
    const mcp = await connectMcp(server.url, "s3cret");
    expect((await mcp.listTools()).length).toBe(7);
    await mcp.close();
  });
});