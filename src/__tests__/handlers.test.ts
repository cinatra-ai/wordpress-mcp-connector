import { describe, expect, it, vi, beforeEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
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
const updatePostMock = vi.fn();
const updateDraftMetaMock = vi.fn();
const listMcpInstancesMock = vi.fn(() => [
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

function registerStubDeps() {
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
    createDraft: vi.fn(),
    readPost: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: updateDraftMetaMock,
    updatePost: updatePostMock,
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
    delete process.env.WP_CONTENT_EDITOR_A2A_URL;
  });

  it("is registered as a handler key on createWordPressPrimitiveHandlers()", () => {
    expect(typeof (handlers as any).wordpress_content_editor_run).toBe("function");
  });

  it("rejects empty postId via zod schema", async () => {
    await expect(
      (handlers as any).wordpress_content_editor_run({
        primitiveName: "wordpress_content_editor_run",
        input: { instanceId: "site-1", postId: "", instructions: "edit" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("coerces string postId to number via Zod coerce in the dispatched payload", async () => {
    await (handlers as any).wordpress_content_editor_run({
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
    await (handlers as any).wordpress_content_editor_run({
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

  it("respects WP_CONTENT_EDITOR_A2A_URL when set", async () => {
    process.env.WP_CONTENT_EDITOR_A2A_URL = "http://wayflow-wordpress-content-editor:3021";
    await (handlers as any).wordpress_content_editor_run({
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
    const result = await (handlers as any).wordpress_content_editor_run({
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
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ postId: "10", changes: [] });
  });

  it("falls back to { result: text } when the dispatch reply is not JSON", async () => {
    dispatchContentEditorMock.mockResolvedValue("plain text");
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "plain text" });
  });

  it("falls back to { result: \"\" } when the dispatch reply is empty", async () => {
    dispatchContentEditorMock.mockResolvedValue("");
    const result = await (handlers as any).wordpress_content_editor_run({
      primitiveName: "wordpress_content_editor_run",
      input: { instanceId: "site-1", postId: 10, instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "" });
  });
});

// ---------------------------------------------------------------------------
// wordpress_post_update
// Top-level field updates (title/content/excerpt/status/meta) — NOT just meta.
// Closes the broken edit path that prevented the SKILL.md demote-then-edit.
// ---------------------------------------------------------------------------

describe("wordpress_post_update", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    updatePostMock.mockReset();
    updatePostMock.mockResolvedValue({ id: 10, status: "draft" });
  });

  it("is registered as a handler key on createWordPressPrimitiveHandlers()", () => {
    expect(typeof (handlers as any).wordpress_post_update).toBe("function");
  });

  it("rejects empty instanceId via zod schema", async () => {
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "", postId: 10, title: "X" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("rejects calls with NO editable fields (no title/content/excerpt/status/meta)", async () => {
    // Schema must enforce that at least one editable field is present so the
    // primitive cannot silently no-op.
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 10 },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("forwards top-level title to updateWordPressPost (NOT inside meta)", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, title: "Hello" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(updatePostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wordpressPostId: 10,
        fields: expect.objectContaining({ title: "Hello" }),
      }),
    );
    // Defensive: title should NOT be inside meta
    const call = updatePostMock.mock.calls[0][0];
    expect(call.fields.meta?.title).toBeUndefined();
  });

  it("supports demote-then-edit: status:draft + title in one call (the SKILL.md pattern)", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, status: "draft", title: "X", content: "Y" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const call = updatePostMock.mock.calls[0][0];
    expect(call.fields).toEqual({ status: "draft", title: "X", content: "Y" });
  });

  it("coerces string postId to number via Zod coerce", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: "10", title: "X" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const call = updatePostMock.mock.calls[0][0];
    expect(call.wordpressPostId).toBe(10);  // numeric, not string
  });
});

// ---------------------------------------------------------------------------
// wordpress_post_update_meta empty-string filter
// Same threat class as Drupal node_update: a `z.record` schema
// cannot enforce per-key min(1), so the runtime must strip "" before dispatch.
// ---------------------------------------------------------------------------

describe("wordpress_post_update_meta empty-field guard", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;

  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    updateDraftMetaMock.mockReset();
    updateDraftMetaMock.mockResolvedValue({ ok: true } as any);
  });

  it("wordpress_post_update_meta strips empty-string meta values before dispatch", async () => {
    await (handlers as any).wordpress_post_update_meta({
      primitiveName: "wordpress_post_update_meta",
      input: {
        instanceId: "site-1",
        postId: 10,
        meta: {
          _yoast_wpseo_metadesc: "Real description",
          _yoast_wpseo_focuskw: "",
        },
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    const call = updateDraftMetaMock.mock.calls[0][0] as {
      instance: unknown;
      wordpressPostId: number;
      meta: Record<string, unknown>;
    };

    expect(call.wordpressPostId).toBe(10);
    // Pin the FULL meta shape, not just one key. toHaveProperty alone would let an extra key (e.g. an
    // accidentally-leaked excerpt:"") slip through. Match the
    // belt-and-braces pattern from the Drupal sibling test
    // (handlers.test.ts: drupal_node_update strips empty-string ...).
    expect(call.meta).toEqual({ _yoast_wpseo_metadesc: "Real description" });
    expect(call.meta).not.toHaveProperty("_yoast_wpseo_focuskw");
  });

  // The handler comment documents the invariant: only literal "" is dropped;
  // null/undefined/false/0 pass through unchanged. Without this test a
  // refactor that switched `v !== ""` to a truthiness check would silently
  // break legitimate clears (e.g. boolean meta flags).
  it("wordpress_post_update_meta preserves null/false/0 — only \"\" is filtered", async () => {
    await (handlers as any).wordpress_post_update_meta({
      primitiveName: "wordpress_post_update_meta",
      input: {
        instanceId: "site-1",
        postId: 10,
        meta: {
          _yoast_wpseo_metadesc: "Real description",
          _yoast_wpseo_focuskw: "",
          _hide_from_search: false,
          _content_score: 0,
          _legacy_field: null,
        },
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    const call = updateDraftMetaMock.mock.calls[0][0] as {
      wordpressPostId: number;
      meta: Record<string, unknown>;
    };

    expect(call.wordpressPostId).toBe(10);
    expect(call.meta).toEqual({
      _yoast_wpseo_metadesc: "Real description",
      _hide_from_search: false,
      _content_score: 0,
      _legacy_field: null,
    });
  });

  // The strip filter would otherwise dispatch an empty meta object to
  // updateWordPressDraftMeta — WordPress would silently accept the no-op
  // and the agent would see a bogus success. Pin the runtime throw and
  // assert no API call escapes the handler.
  it("wordpress_post_update_meta throws when ALL meta values are empty strings (no API call dispatched)", async () => {
    await expect(
      (handlers as any).wordpress_post_update_meta({
        primitiveName: "wordpress_post_update_meta",
        input: {
          instanceId: "site-1",
          postId: 10,
          meta: {
            _yoast_wpseo_metadesc: "",
            _yoast_wpseo_focuskw: "",
          },
        },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/all submitted meta values were empty/i);

    expect(updateDraftMetaMock).not.toHaveBeenCalled();
  });
});
