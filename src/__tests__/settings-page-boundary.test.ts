/**
 * connector-setup-tabs (wordpress-mcp-connector#70): boundary-respect pin.
 * Plain node-environment source check (mirrors the established
 * `setup-page-review.test.ts` pattern in sibling connector repos) — asserts
 * the settings page consumes the SHARED `@cinatra-ai/sdk-ui/tabs` primitive
 * rather than a locally vendored copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../settings-page.tsx", import.meta.url)),
  "utf8",
);

describe("settings-page — boundary respect (connector-setup-tabs #70)", () => {
  it("imports the shared Tabs primitive from @cinatra-ai/sdk-ui/tabs — no local tabs copy", () => {
    expect(src).toContain('from "@cinatra-ai/sdk-ui/tabs"');
    expect(src).not.toMatch(/from ["']\.\/(components\/ui\/)?tabs["']/);
  });

  it("Help is declared last among the TabsTrigger values (source order pin)", () => {
    const triggerValues = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(triggerValues).toEqual(["setup", "connections", "help"]);
    expect(triggerValues.at(-1)).toBe("help");
  });
});
