import { describe, expect, it, vi, beforeEach } from "vitest";

// The wordpress-content-editor A2A dispatch — the A2A client, the bearer-token
// mint, AND the `task.history` role-acceptance walk ("agent" | "assistant",
// pick the last agent message, "" when none) — now lives HOST-SIDE behind
// `getWordPressDeps().dispatchContentEditor`, which returns the resolved
// last-agent reply TEXT. This file tests the CONNECTOR-side consumption of that
// text (code-fence-strip + JSON.parse + graceful fallback). The host owns the
// history-walk + role-acceptance contract and tests it host-side.

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
} from "../deps";

const dispatchContentEditorMock = vi.fn(
  async (_input: { agentUrl: string; payload: unknown; timeoutMs: number }) => "",
);

function registerStubDeps() {
  registerWordPressConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: dispatchContentEditorMock,
    deleteInstance: vi.fn(async () => {}),
    // External-MCP toolbox surfaces (unused by this suite's code paths).
    listMcpInstances: () => [],
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    // Connection/instance-admin + content surface (cinatra#172 Stage H3 —
    // unused by this suite's code paths).
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    createDraft: vi.fn(),
    readPost: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    updatePost: vi.fn(),
    // cinatra#409 write-authority gate — unused by the relay suite's code paths
    // (wordpress_content_editor_run is a DISPATCH relay, not a direct writer).
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

describe("wordpress_content_editor_run — dispatch-reply handling", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;

  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    dispatchContentEditorMock.mockReset();
    dispatchContentEditorMock.mockResolvedValue("");
  });

  it("Test 1: JSON envelope reply text returns the parsed object", async () => {
    dispatchContentEditorMock.mockResolvedValue(
      '{"postId":"14","changes":[{"field":"title","before":"old","after":"new"}]}',
    );
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 14, instructions: "Update title" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({
      postId: "14",
      changes: [{ field: "title", before: "old", after: "new" }],
    });
  });

  it("Test 2: empty dispatch reply (no agent message host-side) → fallback { result: '' }", async () => {
    dispatchContentEditorMock.mockResolvedValue("");
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 14, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "" });
  });

  it("Test 3: code-fenced JSON reply → stripCodeFences + parse OK", async () => {
    dispatchContentEditorMock.mockResolvedValue('```json\n{"postId":"14","changes":[]}\n```');
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 14, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ postId: "14", changes: [] });
  });

  it("Test 4: non-JSON prose reply → returns { result: <text> }", async () => {
    dispatchContentEditorMock.mockResolvedValue("Edit complete.");
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 14, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "Edit complete." });
  });

  it("Test 5: forwards the validated input as the dispatch payload", async () => {
    dispatchContentEditorMock.mockResolvedValue('{"postId":"42","changes":[]}');
    await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 42, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const dispatchCall = dispatchContentEditorMock.mock.calls[0][0];
    expect((dispatchCall.payload as { instanceId: string; postId: number }).instanceId).toBe("site-1");
    expect((dispatchCall.payload as { instanceId: string; postId: number }).postId).toBe(42);
  });
});
