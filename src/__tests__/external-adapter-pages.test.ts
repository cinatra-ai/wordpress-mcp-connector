// Validation record for the external WordPress mcp-adapter page workflow.
//
// The connector injects the external WordPress/mcp-adapter server with
// allowedTools:null + requireApproval:"read-only" because the adapter toolset
// is version-dependent (see src/mcp/toolbox.ts and toolbox.test.ts). This suite
// pins WHAT that toolset actually is on the supported adapter, recorded from a
// live site by scripts/probe-mcp-adapter.mjs into fixtures/mcp-adapter-tools.json.
//
// The finding that justifies routing external page workflows through the
// Cinatra primitives (postType:"page") rather than adapter-native tools: the
// adapter's default MCP server exposes only a generic ability gateway
// (discover / get-info / execute), and no page or post ability is registered —
// so there is NO adapter-native page read/list/update/delete tool to call.
import { describe, expect, it } from "vitest";

import adapter from "./fixtures/mcp-adapter-tools.json";

describe("external WordPress mcp-adapter — validated page-tool surface", () => {
  it("exposes only the generic ability-gateway triad on the default MCP server", () => {
    expect(adapter.tools).toEqual([
      "mcp-adapter-discover-abilities",
      "mcp-adapter-get-ability-info",
      "mcp-adapter-execute-ability",
    ]);
  });

  it("exposes NO first-class page or post tool", () => {
    expect(adapter.pageTools).toEqual([]);
    expect(adapter.postTools).toEqual([]);
    for (const name of adapter.tools) {
      expect(name).not.toMatch(/page|post/i);
    }
  });

  it("registers no page/post ability the execute-ability tool could reach", () => {
    // discover-abilities returns the abilities the default server exposes; the
    // registry lists every ability the site declares. Neither carries a
    // page/post content ability on the supported adapter.
    expect(adapter.discoverAbilities).toEqual([]);
    for (const ability of adapter.abilitiesRegistry) {
      expect(ability).not.toMatch(/\b(page|post)s?\b/i);
    }
  });

  it("records the default-server endpoint the host injects (both permalink forms)", () => {
    expect(adapter.endpoint).toBe("/wp-json/mcp/mcp-adapter-default-server");
    expect(adapter.endpointQueryStringForm).toContain("rest_route=/mcp/mcp-adapter-default-server");
  });
});
