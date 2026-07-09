// callWordPressMcp (cinatra#1214 S1) — the WordPress sibling of
// callDrupalMcp. Covers: the cinatra-content-server URL shape, the
// Application-Password Basic header resolved via the host
// `buildWordPressBasicAuthHeader` dep (never a raw credential field), the
// REQUIRED runtime tool-detection + fail-closed behaviour (an install without
// the plugin's Cinatra tools must NOT degrade to direct REST), response-envelope
// unwrap (structuredContent preferred, text fallback, WP_Error surfaced), and
// close-in-finally. The token never appears in an error message.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { registerWordPressConnector, _resetWordPressDepsForTests } from "../deps";

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // Regular function required — arrow functions cannot be used with `new`.
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, listTools: mockListTools, callTool: mockCallTool, close: mockClose };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

import {
  callWordPressMcp,
  CINATRA_POST_GET_TOOL,
  CINATRA_POST_UPDATE_TOOL,
} from "../lib/wordpress-mcp-client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The host-bound Application-Password Basic-auth-header builder
// (deps.buildWordPressBasicAuthHeader).
const buildWordPressBasicAuthHeader = vi.fn();

const inst = (
  over: Partial<{ id: string; name: string; siteUrl: string; username: string; applicationPassword: string; providerConfigKey: string; connectionId: string }> = {},
) => ({
  id: over.id ?? "1",
  name: over.name ?? "Site 1",
  siteUrl: over.siteUrl ?? "http://localhost:8081",
  username: over.username ?? "admin",
  applicationPassword: over.applicationPassword ?? "app-pass",
  providerConfigKey: over.providerConfigKey ?? "wordpress",
  connectionId: over.connectionId ?? over.id ?? "1",
  createdAt: "",
  updatedAt: "",
});

/** The dedicated Cinatra content MCP server URL (no-pretty-permalinks form). */
const SERVER_URL = "http://localhost:8081/index.php?rest_route=/mcp/cinatra-content-server";

function registerDepsStub() {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances: () => [],
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    // The seam under test.
    buildWordPressBasicAuthHeader,
    // Carve-out content members (unused by this suite's code paths).
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

describe("callWordPressMcp", () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockListTools.mockReset().mockResolvedValue({
      tools: [{ name: CINATRA_POST_GET_TOOL }, { name: CINATRA_POST_UPDATE_TOOL }],
    });
    mockCallTool.mockReset().mockResolvedValue({ structuredContent: { id: 1 } });
    mockClose.mockReset().mockResolvedValue(undefined);
    vi.mocked(StreamableHTTPClientTransport).mockClear();
    buildWordPressBasicAuthHeader.mockReset();
    buildWordPressBasicAuthHeader.mockResolvedValue({ Authorization: "Basic dGVzdA==" });
    registerDepsStub();
  });

  afterEach(() => {
    _resetWordPressDepsForTests();
  });

  it("targets the dedicated cinatra-content-server (no-pretty-permalinks ?rest_route= form) via StreamableHTTPClientTransport", async () => {
    await callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 1 });
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(String(url)).toBe(SERVER_URL);
  });

  it("resolves the Basic header via the host buildWordPressBasicAuthHeader dep and threads it as the transport Authorization header", async () => {
    await callWordPressMcp(inst({ id: "7" }), CINATRA_POST_GET_TOOL, { id: 1 });
    expect(buildWordPressBasicAuthHeader).toHaveBeenCalledWith(
      expect.objectContaining({ instance: expect.objectContaining({ id: "7" }) }),
    );
    const [, opts] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(opts).toMatchObject({ requestInit: { headers: { Authorization: "Basic dGVzdA==" } } });
  });

  it("throws a clear, label-only error when the credential is unavailable (no token in message; no transport constructed)", async () => {
    buildWordPressBasicAuthHeader.mockResolvedValueOnce({ Authorization: "" });
    await expect(
      callWordPressMcp(inst({ siteUrl: "https://example.com" }), CINATRA_POST_GET_TOOL, { id: 1 }),
    ).rejects.toThrow(/credential unavailable for site https:\/\/example\.com/);
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });

  it("propagates a use-gate deny thrown by the auth seam (fail-closed) and never calls a tool", async () => {
    buildWordPressBasicAuthHeader.mockRejectedValueOnce(new Error("connection use denied"));
    await expect(callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 1 })).rejects.toThrow(/use denied/);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // --- Runtime tool-detection + FAIL-CLOSED (cinatra#1214 design §A) ---
  it("FAILS CLOSED when the Cinatra tool is absent (older/missing plugin) — throws, never calls the tool, never falls back", async () => {
    mockListTools.mockResolvedValueOnce({ tools: [{ name: "mcp-adapter-discover-abilities" }] });
    await expect(callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 1 })).rejects.toThrow(
      /is not available|missing or too old|Refusing to fall back/,
    );
    expect(mockCallTool).not.toHaveBeenCalled();
    // The transport was still opened+closed cleanly.
    expect(mockClose).toHaveBeenCalled();
  });

  it("proceeds once tools/list confirms the tool, calling callTool with { name, arguments }", async () => {
    mockCallTool.mockResolvedValueOnce({ structuredContent: { id: 5, status: "draft", title: "Hi" } });
    const result = await callWordPressMcp(inst(), CINATRA_POST_UPDATE_TOOL, { id: 5, status: "draft" });
    expect(mockListTools).toHaveBeenCalled();
    expect(mockCallTool).toHaveBeenCalledWith({ name: CINATRA_POST_UPDATE_TOOL, arguments: { id: 5, status: "draft" } });
    expect(result).toEqual({ id: 5, status: "draft", title: "Hi" });
  });

  it("prefers structuredContent over the text block", async () => {
    mockCallTool.mockResolvedValueOnce({
      structuredContent: { id: 7, title: "structured" },
      content: [{ type: "text", text: '{"id":999,"title":"text"}' }],
    });
    const result = await callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 7 });
    expect(result).toEqual({ id: 7, title: "structured" });
  });

  it("falls back to parsing the text JSON block when there is no structuredContent", async () => {
    mockCallTool.mockResolvedValueOnce({ content: [{ type: "text", text: '{"id":8,"title":"T"}' }] });
    const result = await callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 8 });
    expect(result).toEqual({ id: 8, title: "T" });
  });

  it("surfaces a WP_Error structuredContent envelope ({code,message}, no id) as an error", async () => {
    mockCallTool.mockResolvedValueOnce({
      structuredContent: { code: "cinatra_post_not_found", message: "The requested post could not be found." },
    });
    await expect(callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 404 })).rejects.toThrow(
      /cinatra_post_not_found|could not be found/,
    );
  });

  it("surfaces an isError result as an error", async () => {
    mockCallTool.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "boom" }] });
    await expect(callWordPressMcp(inst(), CINATRA_POST_UPDATE_TOOL, { id: 1, status: "draft" })).rejects.toThrow(
      /failed: boom/,
    );
  });

  it("strips trailing slashes from siteUrl before appending the content-server route", async () => {
    await callWordPressMcp(inst({ siteUrl: "http://localhost:8081///" }), CINATRA_POST_GET_TOOL, { id: 1 });
    const [url] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(String(url)).toBe(SERVER_URL);
  });

  it("calls client.close in finally even when callTool throws", async () => {
    mockCallTool.mockRejectedValueOnce(new Error("network"));
    await expect(callWordPressMcp(inst(), CINATRA_POST_GET_TOOL, { id: 1 })).rejects.toThrow();
    expect(mockClose).toHaveBeenCalled();
  });
});
