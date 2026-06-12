// `register(ctx)` shape — the Stage 3 transport-DI inversion: the connector
// binds its host deps slot itself (always-bind since the post-cutover sweep, lazy per-call
// host-service resolution). Leaf-graph pin: the entry imports ONLY ./deps.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { register } from "../register";
import {
  getWordPressDeps,
  registerWordPressConnector,
  _resetWordPressDepsForTests,
} from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
  } as never;
  register(ctx);
  return { resolveProviders };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWordPressDepsForTests();
});

describe("register(ctx) — transport-DI deps binding (Stage 3)", () => {
  it("binds the deps slot when absent, resolving host services LAZILY at call time", async () => {
    const decodeCursor = vi.fn(() => 3);
    const deleteInstance = vi.fn(async () => {});
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:mcp-pagination": { decodeCursor, buildListPage: vi.fn() },
      "@cinatra-ai/host:wordpress-mcp": {
        listInstances: vi.fn(() => []),
        probeAdapter: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
        deleteInstance,
      },
    });
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getWordPressDeps().decodeCursor("x")).toBe(3);
    await getWordPressDeps().deleteInstance("id-1");
    expect(deleteInstance).toHaveBeenCalledWith("id-1");
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", () => {
    const sentinel = vi.fn(() => 42);
    registerWordPressConnector({ decodeCursor: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:mcp-pagination": { decodeCursor: () => 0 } });
    expect(getWordPressDeps().decodeCursor("x")).toBe(0);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getWordPressDeps().listMcpInstances()).toThrow(
      /host service "@cinatra-ai\/host:wordpress-mcp" is not registered/,
    );
    expect(() => getWordPressDeps().decodeCursor("x")).toThrow(
      /host service "@cinatra-ai\/host:mcp-pagination" is not registered/,
    );
  });
});
