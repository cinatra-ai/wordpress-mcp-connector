// Verifies the first-party WordPress external-MCP toolbox (manifest-discovered
// builder). Instance settings, the cached mcp-adapter probe, the endpoint
// resolution, and the private-URL policy come through the host-bound deps
// (wired in src/lib/register-transport-connectors.ts; stubbed here). The
// Basic auth header is built in this extension from the instance credentials.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";

import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressMcpInstance,
} from "../deps";
import { createWordPressExternalMcpToolbox } from "../mcp/toolbox";

const listMcpInstances = vi.fn<() => WordPressMcpInstance[]>(() => []);
const probeMcpAdapter = vi.fn();

const inst = (id: string, siteUrl?: string): WordPressMcpInstance => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  username: `admin-${id}`,
  applicationPassword: `pass-${id}`,
});

const expectedBasicHeader = (instance: WordPressMcpInstance) =>
  `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`, "utf8").toString("base64")}`;

beforeEach(() => {
  vi.clearAllMocks();
  probeMcpAdapter.mockResolvedValue("registered");
  registerWordPressConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: vi.fn(async () => ""),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances,
    probeMcpAdapter,
    resolveMcpServerUrl: (siteUrl: string) =>
      `${siteUrl.replace(/\/+$/, "")}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
    isPrivateUrl: (url: string) => /localhost|127\.0\.0\.1|::1/.test(url),
    // Connection/instance-admin + content surface (cinatra#172 Stage H3 —
    // unused by the toolbox's code paths).
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    createDraft: vi.fn(),
    readPost: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    updatePost: vi.fn(),
    // cinatra#409 write-authority gate — unused by the toolbox's read-only paths.
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
});

afterEach(() => {
  _resetWordPressDepsForTests();
});

describe("createWordPressExternalMcpToolbox().buildTools", () => {
  it("returns [] when no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    listMcpInstances.mockReturnValue([inst("a", "http://localhost:8081")]);
    expect(await createWordPressExternalMcpToolbox().buildTools("openai")).toEqual([]);
    expect(probeMcpAdapter).not.toHaveBeenCalled();
  });

  it("skips instances whose mcp-adapter probe is not 'registered'", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    probeMcpAdapter.mockResolvedValueOnce("not_installed").mockResolvedValueOnce("registered");

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("wordpress-b");
  });

  it("emits one MCP server tool per reachable instance with Basic auth + query-string endpoint", async () => {
    const a = inst("a");
    listMcpInstances.mockReturnValue([a]);

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "mcp",
      serverLabel: "wordpress-a",
      serverUrl:
        "https://site-a.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
      headers: { Authorization: expectedBasicHeader(a) },
      serverDescription:
        "WordPress site Site a (https://site-a.example.com) — MCP adapter",
      allowedTools: null,
      requireApproval: "never",
    });
  });

  it("returns [] and never throws when deps are unavailable", async () => {
    _resetWordPressDepsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createWordPressExternalMcpToolbox().buildTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
