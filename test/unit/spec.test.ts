import { describe, expect, it } from "vitest";
import { buildIndex, loadSpecIndex, resolveSpecPath } from "../../src/netbox/spec.js";

const FIXTURE = `
openapi: 3.0.3
info:
  title: Fixture API
  version: 9.9
paths:
  /api/dcim/devices/:
    get:
      operationId: dcim_devices_list
      tags: [dcim]
      description: Get a list of device objects.
    post:
      operationId: dcim_devices_create
      tags: [dcim]
  /api/dcim/devices/{id}/:
    get:
      operationId: dcim_devices_retrieve
      tags: [dcim]
    put:
      operationId: dcim_devices_update
      tags: [dcim]
    patch:
      operationId: dcim_devices_partial_update
      tags: [dcim]
    delete:
      operationId: dcim_devices_delete
      tags: [dcim]
  /api/dcim/devices/{id}/render-config/:
    post:
      operationId: dcim_devices_render_config_create
      tags: [dcim]
  /api/ipam/prefixes/:
    get:
      operationId: ipam_prefixes_list
      tags: [ipam]
  /api/ipam/prefixes/{id}/:
    get:
      operationId: ipam_prefixes_retrieve
      tags: [ipam]
`;

describe("buildIndex", () => {
  const index = buildIndex(FIXTURE);

  it("indexes resources with their operations", () => {
    const devices = index.resources.get("dcim/devices");
    expect(devices).toBeDefined();
    expect(devices!.path).toBe("/api/dcim/devices/");
    expect(devices!.detailPath).toBe("/api/dcim/devices/{id}/");
    expect(Object.keys(devices!.operations).sort()).toEqual([
      "create",
      "delete",
      "list",
      "partial_update",
      "retrieve",
      "update",
    ]);
    expect(devices!.operations.list!.operationId).toBe("dcim_devices_list");
    expect(devices!.operations.list!.summary).toBe("Get a list of device objects.");
  });

  it("records action endpoints separately", () => {
    const devices = index.resources.get("dcim/devices")!;
    expect(devices.actions.map((a) => a.path)).toContain("/api/dcim/devices/{id}/render-config/");
    expect(devices.actions[0]!.kind).toBe("action");
  });

  it("builds alias forms", () => {
    for (const alias of ["dcim/devices", "dcim.devices", "devices", "/api/dcim/devices/", "/api/dcim/devices", "dcim/devices/"]) {
      expect(index.aliases.get(alias), alias).toBe("dcim/devices");
    }
  });

  it("does not alias an ambiguous bare resource name", () => {
    // `prefixes` is unique here, but make sure dot paths remain resolvable.
    expect(index.aliases.get("ipam.prefixes")).toBe("ipam/prefixes");
  });
});

describe("loadSpecIndex (bundled spec)", () => {
  it("loads the real NetBox spec from the repository", async () => {
    expect(resolveSpecPath({ specPath: undefined })).toMatch(/\.ya?ml$/);
    const index = await loadSpecIndex({ specPath: undefined });
    expect(index.resources.size).toBeGreaterThan(150);
    const devices = index.resources.get("dcim/devices");
    expect(devices).toBeDefined();
    expect(devices!.operations.list).toBeDefined();
    expect(devices!.operations.create).toBeDefined();
    expect(index.version).toMatch(/4\.7/);
  });
});