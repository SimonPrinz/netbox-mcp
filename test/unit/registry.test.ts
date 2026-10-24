import { describe, expect, it } from "vitest";
import { buildIndex } from "../../src/netbox/spec.js";
import { endpointVariants, resolveOrSuggest, resolveResource, suggestKeywords } from "../../src/netbox/registry.js";

const FIXTURE = `
openapi: 3.0.3
info: { title: Fixture, version: "1" }
paths:
  /api/dcim/devices/:
    get: { operationId: dcim_devices_list, tags: [dcim] }
  /api/ipam/prefixes/:
    get: { operationId: ipam_prefixes_list, tags: [ipam] }
  /api/ipam/roles/:
    get: { operationId: ipam_roles_list, tags: [ipam] }
  /api/dcim/roles/:
    get: { operationId: dcim_roles_list, tags: [dcim] }
`;

const index = buildIndex(FIXTURE);

describe("resolveResource", () => {
  it("resolves canonical, dotted, bare and path forms", () => {
    expect(resolveResource(index, "dcim/devices")!.key).toBe("dcim/devices");
    expect(resolveResource(index, "dcim.devices")!.key).toBe("dcim/devices");
    expect(resolveResource(index, "devices")!.key).toBe("dcim/devices");
    expect(resolveResource(index, "/api/dcim/devices/")!.key).toBe("dcim/devices");
    expect(resolveResource(index, "/api/dcim/devices")!.key).toBe("dcim/devices");
  });

  it("returns undefined for unknown endpoints", () => {
    expect(resolveResource(index, "dcim/devicez")).toBeUndefined();
  });

  it("does not resolve ambiguous bare names", () => {
    expect(resolveResource(index, "roles")).toBeUndefined();
    expect(resolveResource(index, "ipam/roles")!.key).toBe("ipam/roles");
  });
});

describe("endpointVariants", () => {
  it("produces path and dotted variants", () => {
    const variants = endpointVariants("/api/dcim/devices/");
    expect(variants).toContain("dcim/devices");
    expect(variants).toContain("dcim.devices");
  });
});

describe("suggestKeywords", () => {
  it("suggests close matches", () => {
    const suggestions = suggestKeywords(index, "dcim/devicez");
    expect(suggestions).toContain("dcim/devices");
  });

  it("resolveOrSuggest returns suggestions when unresolved", () => {
    const result = resolveOrSuggest(index, "devicez");
    expect(result.entry).toBeUndefined();
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});