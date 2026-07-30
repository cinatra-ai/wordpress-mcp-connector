import { describe, expect, it, vi, beforeEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
// cinatra-ai/cinatra#2022 S7: `wordpress_content_editor_run` was extracted
// into its own relay-only module (`mcp/relay.ts`, cinatra#246) — it is no
// longer a key on `createWordPressPrimitiveHandlers()`'s returned object.
import { runContentEditorRelay } from "@cinatra-ai/wordpress-mcp-connector/mcp-relay";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
} from "../deps";

// All host surfaces resolve through the deps SLOT (cinatra#172 Stage H3): the
// instance/status reads, the post/media content CRUD, the pagination helpers
// and the content-editor A2A dispatch are host-bound members the suite stubs
// via registerWordPressConnector — no `@/lib/*` mock (the host owns those
// edges and tests them host-side).
const dispatchContentEditorMock = vi.fn(
  async (_input: {
    agentUrl: string;
    payload: unknown;
    timeoutMs: number;
    packageName: string;
  }) => "{}",
);
const updateDraftMetaMock = vi.fn();
// cinatra#409 per-user write-authority gate. Default: ALLOW (resolves void).
// The deny/forged-org/unbound suites below override this per-case.
const requireInstanceWriteAuthorityMock = vi.fn(
  async (_input: { instanceId: string; primitiveName: string }) => {},
);
const listMcpInstancesMock = vi.fn((): WordPressMcpInstance[] => [
  {
    id: "site-1",
    siteUrl: "https://example.com",
    username: "u",
    applicationPassword: "p",
    name: "Site 1",
    createdAt: "",
    updatedAt: "",
  },
]);

function registerStubDeps(extra: Partial<WordPressConnectorDeps> = {}) {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) || 0 : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchContentEditorMock,
    deleteInstance: vi.fn(async () => {}),
    // External-MCP toolbox + instance reads (the handlers' list-and-find).
    listMcpInstances: listMcpInstancesMock,
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    // Connection/instance-admin + content surface (cinatra#172 Stage H3).
    getApiStatus: vi.fn(() => ({ status: "not_connected" as const, detail: "" })),
    // In-admin get/update auth seam (cinatra#1214 S1). The real MCP call is
    // mocked (vi.mock above); this only needs to exist on the deps slot.
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: updateDraftMetaMock,
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
    ...extra,
  });
}

describe("wordpress_content_editor_run", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    dispatchContentEditorMock.mockReset();
    dispatchContentEditorMock.mockResolvedValue("{}");
  });

  // cinatra#246 / cinatra-ai/cinatra#2022 S7: the content-editor RELAY is a
  // dispatch primitive, deliberately never a model-visible MCP tool — it was
  // extracted into its own module (`mcp/relay.ts`) precisely so it can never
  // be a key on this handlers object (previously enforced by a skip-by-name
  // check in registry.ts's registration loop; now structural). Every other
  // test below calls `runContentEditorRelay` directly.
  it("is NOT a handler key on createWordPressPrimitiveHandlers() — lives in mcp/relay.ts instead", () => {
    expect((handlers as any).wordpress_content_editor_run).toBeUndefined();
    expect(typeof runContentEditorRelay).toBe("function");
  });

  it("rejects empty postId via zod schema", async () => {
    await expect(
      runContentEditorRelay({
        primitiveName: "wordpress_content_editor_run",
        input: { instanceId: "site-1", postId: "", instructions: "edit" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("coerces string postId to number via Zod coerce in the dispatched payload", async () => {
    await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: "10", instructions: "edit" },  // string
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    // The handler forwards the validated input as `payload` to the host dispatch.
    // Coerced postId should be the number 10, not the string "10".
    const dispatchCall = dispatchContentEditorMock.mock.calls[0][0];
    expect((dispatchCall.payload as { postId: unknown }).postId).toBe(10);
  });

  it("dispatches via deps.dispatchContentEditor with default :3010 agent route and timeout 300_000", async () => {
    await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: {
        instanceId: "site-1",
        postId: 10,
        postType: "post",
        postStatus: "publish",
        instructions: "Fix typo",
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(dispatchContentEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUrl: "http://localhost:3010/agents/cinatra-ai/wordpress-agent",
        timeoutMs: 300_000,
        // cinatra#246: agent package name drives host-side OBO run creation.
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    );
  });

  it("respects the host-settings agentUrl override when the dep resolves one", async () => {
    // Boundary rule (cinatra#978): the override arrives through the host-bound
    // `resolveContentEditorAgentUrl` dep (`settings` host port), never via a
    // process.env read in connector code.
    registerStubDeps({
      resolveContentEditorAgentUrl: async () => "http://wayflow-wordpress-content-editor:3021",
    });
    await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "edit" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(dispatchContentEditorMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: "http://wayflow-wordpress-content-editor:3021" }),
    );
  });

  it("parses JSON from the host dispatch reply text", async () => {
    dispatchContentEditorMock.mockResolvedValue(
      '{"postId":"10","changes":[{"field":"title","before":"Old","after":"New"}]}',
    );
    const result = await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({
      postId: "10",
      changes: [{ field: "title", before: "Old", after: "New" }],
    });
  });

  it("strips Markdown code fences before JSON.parse", async () => {
    dispatchContentEditorMock.mockResolvedValue('```json\n{"postId":"10","changes":[]}\n```');
    const result = await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ postId: "10", changes: [] });
  });

  it("falls back to { result: text } when the dispatch reply is not JSON", async () => {
    dispatchContentEditorMock.mockResolvedValue("plain text");
    const result = await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "plain text" });
  });

  it("falls back to { result: \"\" } when the dispatch reply is empty", async () => {
    dispatchContentEditorMock.mockResolvedValue("");
    const result = await runContentEditorRelay({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "" });
  });
});

