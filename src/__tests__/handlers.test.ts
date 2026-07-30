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

// The in-admin get/update reroute to the MCP client (cinatra#1214 S1) — mocked
// so these handler tests assert the MCP tool call, not a live MCP transport.
vi.mock("../lib/wordpress-mcp-client", () => ({
  callWordPressMcp: vi.fn(),
  CINATRA_POST_GET_TOOL: "cinatra-post-get",
  CINATRA_POST_UPDATE_TOOL: "cinatra-post-update",
  // wordpress-plugin#82 — the six rehomed primitives route through MCP too.
  CINATRA_POST_STATUS_TOOL: "cinatra-post-status",
  CINATRA_POSTS_LIST_TOOL: "cinatra-posts-list",
  CINATRA_POST_DELETE_TOOL: "cinatra-post-delete",
  CINATRA_MEDIA_UPLOAD_TOOL: "cinatra-media-upload",
  CINATRA_POST_CREATE_DRAFT_TOOL: "cinatra-post-create-draft",
  CINATRA_POST_UPDATE_META_TOOL: "cinatra-post-update-meta",
}));
import { callWordPressMcp } from "../lib/wordpress-mcp-client";

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

// ---------------------------------------------------------------------------
// wordpress_instances_list read-boundary redaction
// A read/list primitive MUST NOT emit credential material. The handler returns
// redacted public rows — never applicationPassword nor the Nango credential
// binding (providerConfigKey/connectionId).
// ---------------------------------------------------------------------------
describe("wordpress_instances_list — read-boundary redaction", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  beforeEach(() => {
    _resetWordPressDepsForTests();
    registerStubDeps();
    handlers = createWordPressPrimitiveHandlers();
    listMcpInstancesMock.mockReset();
    listMcpInstancesMock.mockReturnValue([
      {
        id: "site-1",
        siteUrl: "https://example.com",
        username: "u",
        // credential material that must NEVER reach a read caller:
        applicationPassword: "super-secret-app-pass",
        providerConfigKey: "wordpress",
        connectionId: "nango-conn-123",
        name: "Site 1",
        createdAt: "",
        updatedAt: "",
      },
    ]);
  });

  function call() {
    return (handlers as any).wordpress_instances_list({
      primitiveName: "wordpress_instances_list",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
  }

  // POSITIVE: the intended authorized path still returns instances with the
  // non-secret display fields a caller needs to pick an instance.
  it("returns instances with non-secret display fields (authorized path still works)", async () => {
    const result = await call();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "site-1",
      name: "Site 1",
      siteUrl: "https://example.com",
      username: "u",
    });
  });

  // NEGATIVE regression: returned rows must NEVER contain applicationPassword or
  // the credential binding — the unauthorized credential-harvest path is denied.
  it("NEVER returns applicationPassword or credential binding (cross-actor harvest denied)", async () => {
    const result = await call();
    for (const row of result) {
      expect(row).not.toHaveProperty("applicationPassword");
      expect(row).not.toHaveProperty("providerConfigKey");
      expect(row).not.toHaveProperty("connectionId");
      // Belt-and-braces: no field value leaks the secret string either.
      expect(JSON.stringify(row)).not.toContain("super-secret-app-pass");
      expect(JSON.stringify(row)).not.toContain("nango-conn-123");
    }
  });
});

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

// ---------------------------------------------------------------------------
// wordpress_post_update
// Top-level field updates (title/content/excerpt/status/meta) — NOT just meta.
// Closes the broken edit path that prevented the SKILL.md demote-then-edit.
// ---------------------------------------------------------------------------

describe("wordpress_post_update", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  let invokeSiteToolMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetWordPressDepsForTests();
    // cinatra-ai/cinatra#2022: wordpress_post_get / wordpress_post_update route
    // through the governed invoker's ewpa/get-post + ewpa/update-post
    // abilities, NOT callWordPressMcp. Route by toolName: ewpa/get-post
    // returns a full post (post_content present — the update path's
    // independent post-apply re-read reads this); ewpa/update-post returns
    // the community catalog's minimal echo (no content field), proving the
    // handler does NOT trust that echo for its return value.
    invokeSiteToolMock = vi.fn(async (input: { toolName: string; args: Record<string, unknown> }) => {
      if (input.toolName === "ewpa/get-post" || input.toolName === "ewpa/get-page") {
        return {
          success: true,
          data: {
            ID: input.args.post_id,
            post_status: "draft",
            post_title: "",
            post_content: "",
            post_excerpt: "",
          },
        };
      }
      if (input.toolName === "ewpa/update-post") {
        return { success: true, data: { post_id: input.args.post_id, message: "Post updated successfully." } };
      }
      throw new Error(`unexpected toolName in test: ${input.toolName}`);
    });
    registerStubDeps({ invokeSiteTool: invokeSiteToolMock });
    handlers = createWordPressPrimitiveHandlers();
    // cinatra#409: the gate is invoked by every write primitive; default ALLOW.
    requireInstanceWriteAuthorityMock.mockReset();
    requireInstanceWriteAuthorityMock.mockResolvedValue(undefined);
  });

  function updateCalls() {
    return invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
  }

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

  it("forwards top-level title to the governed invoker's ewpa/update-post ability (NOT inside meta)", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, title: "Hello" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(invokeSiteToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "ewpa/update-post",
        args: { post_id: 10, title: "Hello" },
        instanceId: "site-1",
      }),
    );
    // Defensive: the tool args carry no meta key.
    const args = updateCalls()[0]![0].args as Record<string, unknown>;
    expect(args).not.toHaveProperty("meta");
  });

  it("supports demote-then-edit: status:draft + title in one call (the SKILL.md pattern)", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, status: "draft", title: "X", content: "Y" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const args = updateCalls()[0]![0].args;
    expect(args).toEqual({ post_id: 10, status: "draft", title: "X", content: "Y" });
  });

  it("coerces string postId to number via Zod coerce (as the ability's post_id)", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: "10", title: "X" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const args = updateCalls()[0]![0].args as { post_id: number };
    expect(args.post_id).toBe(10); // numeric, not string
  });

  it("runs the #409 write-authority gate BEFORE the invoker write", async () => {
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, title: "X" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "site-1", primitiveName: "wordpress_post_update" }),
    );
  });

  it("FAILS CLOSED on meta (the ability has no meta) — throws, routes to wordpress_post_update_meta, no invoker write call", async () => {
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 10, meta: { _yoast_wpseo_metadesc: "x" } },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/wordpress_post_update_meta|cannot write post meta/);
    expect(updateCalls()).toHaveLength(0);
  });

  it("strips an empty-string excerpt before dispatch (never wipes a field via literal '')", async () => {
    // content has schema min(1); excerpt does not, so an empty excerpt reaches
    // the handler and must be dropped rather than sent as a literal "".
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, title: "T", excerpt: "" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const args = updateCalls()[0]![0].args as Record<string, unknown>;
    expect(args).toEqual({ post_id: 10, title: "T" });
  });

  it("does NOT trust the update ability's own response echo — independently re-reads the post via ewpa/get-post for the returned shape", async () => {
    invokeSiteToolMock.mockImplementation(async (input: { toolName: string; args: Record<string, unknown> }) => {
      if (input.toolName === "ewpa/update-post") {
        // The community catalog's minimal echo — no title/content/excerpt.
        return { success: true, data: { post_id: input.args.post_id, message: "Post updated successfully." } };
      }
      if (input.toolName === "ewpa/get-post") {
        return {
          success: true,
          data: {
            ID: input.args.post_id,
            post_status: "publish",
            post_title: "Applied title",
            post_content: "<p>Applied body</p>",
            post_excerpt: "Applied excerpt",
          },
        };
      }
      throw new Error(`unexpected toolName: ${input.toolName}`);
    });
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 10, title: "New title" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as Record<string, unknown>;
    expect(res.title).toBe("Applied title");
    expect(res.content).toBe("<p>Applied body</p>");
    expect(res.excerpt).toBe("Applied excerpt");
  });

  // Codex-adopted hardening: unlike the READ side (ewpa/get-page is proven to
  // exist for postType:"page"), no captured schema or execution proves
  // ewpa/update-post accepts a page id, and no distinct page-update ability
  // exists in the pinned fixture's discovery capture — so postType:"page" is
  // refused for UPDATES, fail-closed, before the review-gate captures
  // anything (never a silent mis-route to an unproven ability).
  it('FAILS CLOSED on postType:"page" (page updates are unproven, unlike page reads)', async () => {
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 10, postType: "page", title: "New title" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/postType "page" is not supported/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an arbitrary/custom postType (no proven ewpa/* ability behind it)", async () => {
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 10, postType: "product", title: "New title" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/postType "product" is not supported/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wordpress_post_get — cinatra-ai/cinatra#2022 governed-invoker retarget.
//
// HARD REQUIREMENT coverage: the retarget must not silently lose post body
// content (the recorded gap on the earlier `ewpa/get-posts` list re-point).
// These tests prove (a) content flows through end-to-end from the invoker's
// `ewpa/get-post` response to the handler's return value, (b) the handler
// fails LOUD — never silently empty — when the response carries no
// recognizable content field, and (c) postType:"page" dispatches to the
// distinct `ewpa/get-page` ability, matching the abilities actually
// discovered against the pinned S1 fixture (no unified page/post read
// ability exists there).
// ---------------------------------------------------------------------------

describe("wordpress_post_get", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  let invokeSiteToolMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetWordPressDepsForTests();
    invokeSiteToolMock = vi.fn();
    registerStubDeps({ invokeSiteTool: invokeSiteToolMock });
    handlers = createWordPressPrimitiveHandlers();
  });

  function call(input: Record<string, unknown>) {
    return (handlers as any).wordpress_post_get({
      primitiveName: "wordpress_post_get",
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
  }

  it("calls the governed invoker with ewpa/get-post and post_id (not id)", async () => {
    invokeSiteToolMock.mockResolvedValue({
      success: true,
      data: { ID: 42, post_status: "publish", post_title: "T", post_content: "<p>Body</p>", post_excerpt: "E" },
    });
    await call({ instanceId: "site-1", postId: 42 });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/get-post",
      args: { post_id: 42 },
      instanceId: "site-1",
    });
  });

  it("HARD REQUIREMENT: returns the full post_content field through to the caller (content is NOT lost)", async () => {
    invokeSiteToolMock.mockResolvedValue({
      success: true,
      data: {
        ID: 42,
        post_status: "publish",
        post_title: "Hello world",
        post_content: "<p>The full article body, several paragraphs long.</p>",
        post_excerpt: "A short excerpt",
      },
    });
    const res = await call({ instanceId: "site-1", postId: 42 });
    expect(res.content).toBe("<p>The full article body, several paragraphs long.</p>");
    expect(res.title).toBe("Hello world");
    expect(res.excerpt).toBe("A short excerpt");
    expect(res.status).toBe("publish");
  });

  it("also accepts a plain \"content\" key as a fallback field name", async () => {
    invokeSiteToolMock.mockResolvedValue({
      success: true,
      data: { ID: 42, status: "publish", title: "T", content: "<p>Fallback-shaped body</p>", excerpt: "E" },
    });
    const res = await call({ instanceId: "site-1", postId: 42 });
    expect(res.content).toBe("<p>Fallback-shaped body</p>");
  });

  it("FAILS LOUD (never silently empty) when the response carries no recognizable content field", async () => {
    invokeSiteToolMock.mockResolvedValue({
      success: true,
      // Neither post_content nor content present — a field-name mismatch.
      data: { ID: 42, post_status: "publish", post_title: "T", post_excerpt: "E" },
    });
    await expect(call({ instanceId: "site-1", postId: 42 })).rejects.toThrow(
      /no recognizable content field/,
    );
  });

  it("FAILS CLOSED when the invoker reports success:false", async () => {
    invokeSiteToolMock.mockResolvedValue({ success: false, data: null });
    await expect(call({ instanceId: "site-1", postId: 42 })).rejects.toThrow(/unsuccessful result/);
  });

  it("FAILS CLOSED when the governed invoker is unbound", async () => {
    _resetWordPressDepsForTests();
    registerStubDeps({ invokeSiteTool: undefined });
    handlers = createWordPressPrimitiveHandlers();
    await expect(call({ instanceId: "site-1", postId: 42 })).rejects.toThrow(
      /governed connector-instance invoker is unavailable/,
    );
  });

  it('dispatches to ewpa/get-page (not ewpa/get-post) when postType is "page"', async () => {
    invokeSiteToolMock.mockResolvedValue({
      success: true,
      data: { ID: 7, post_status: "publish", post_title: "A Page", post_content: "<p>Page body</p>", post_excerpt: "" },
    });
    await call({ instanceId: "site-1", postId: 7, postType: "page" });
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "ewpa/get-page",
      args: { post_id: 7 },
      instanceId: "site-1",
    });
  });

  // Codex-adopted hardening: an arbitrary/custom postType (a CPT slug) has no
  // proven ewpa/* ability behind it in this retarget (the pinned fixture's
  // discovery capture registers SEPARATE ewpa/get-cpt-item(s) abilities for
  // custom post types, not wired up here) — refuse rather than silently
  // mis-route it to the post- or page-shaped ability.
  it("FAILS CLOSED on an arbitrary/custom postType (no proven ewpa/* ability behind it)", async () => {
    await expect(call({ instanceId: "site-1", postId: 7, postType: "product" })).rejects.toThrow(
      /postType "product" is not supported/,
    );
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
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
    // wordpress-plugin#82: meta writes reroute to the MCP tool
    // (cinatra-post-update-meta), NOT the retired updateDraftMeta REST dep.
    vi.mocked(callWordPressMcp).mockReset();
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 10, updated: ["_yoast_wpseo_metadesc"] });
    updateDraftMetaMock.mockReset();
    // cinatra#409: meta updates go through the write-authority gate; default ALLOW.
    requireInstanceWriteAuthorityMock.mockReset();
    requireInstanceWriteAuthorityMock.mockResolvedValue(undefined);
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

    // MCP-only egress: the meta write reaches the plugin's cinatra-post-update-meta
    // tool, never the direct-REST dep. Assert the tool + the stripped meta args.
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-update-meta",
      { id: 10, meta: { _yoast_wpseo_metadesc: "Real description" } },
    );
    const args = vi.mocked(callWordPressMcp).mock.calls[0][2] as { id: number; meta: Record<string, unknown> };
    expect(args.meta).not.toHaveProperty("_yoast_wpseo_focuskw");
    expect(updateDraftMetaMock).not.toHaveBeenCalled();
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

    const args = vi.mocked(callWordPressMcp).mock.calls[0][2] as {
      id: number;
      meta: Record<string, unknown>;
    };

    expect(args.id).toBe(10);
    expect(args.meta).toEqual({
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

    expect(callWordPressMcp).not.toHaveBeenCalled();
    expect(updateDraftMetaMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wordpress_pages_list — page discovery routes to the pages content dep
// (/wp/v2/pages), NOT the posts dep, and paginates like wordpress_posts_list.
// ---------------------------------------------------------------------------
describe("wordpress_pages_list — routes to cinatra-posts-list (postType:page) + paginates", () => {
  const SITE = {
    id: "site-1",
    siteUrl: "https://example.com",
    username: "u",
    applicationPassword: "p",
    name: "Site 1",
    createdAt: "",
    updatedAt: "",
  };

  beforeEach(() => {
    _resetWordPressDepsForTests();
    vi.mocked(callWordPressMcp).mockReset();
  });

  it("lists via cinatra-posts-list with postType:'page' (MCP-only) and returns a paginated page", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({
      items: [
        { id: 81, title: "Cinatra UAT Page", status: "publish", date: "2026-01-02T03:04:05", url: "https://example.com/uat-page" },
      ],
      total: 15,
    });
    registerStubDeps({ listMcpInstances: () => [SITE] });
    const handlers = createWordPressPrimitiveHandlers();

    const result = await (handlers as any).wordpress_pages_list({
      primitiveName: "wordpress_pages_list",
      input: { instanceId: "site-1" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-posts-list",
      { perPage: 10, offset: 0, postType: "page" },
    );
    expect(result).toEqual({
      items: [
        { id: 81, title: "Cinatra UAT Page", status: "publish", date: "2026-01-02T03:04:05", url: "https://example.com/uat-page" },
      ],
      total: 15,
      nextCursor: "10",
    });
  });

  it("threads the decoded cursor as the next-page offset", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ items: [], total: 25 });
    registerStubDeps({ listMcpInstances: () => [SITE] });
    const handlers = createWordPressPrimitiveHandlers();

    await (handlers as any).wordpress_pages_list({
      primitiveName: "wordpress_pages_list",
      input: { instanceId: "site-1", cursor: "10" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-posts-list",
      { perPage: 10, offset: 10, postType: "page" },
    );
  });

  it("throws when the instance is not found", async () => {
    registerStubDeps({ listMcpInstances: () => [SITE] });
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      (handlers as any).wordpress_pages_list({
        primitiveName: "wordpress_pages_list",
        input: { instanceId: "nope" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/instance not found/i);
  });
});

// ---------------------------------------------------------------------------
// wordpress_post_status / wordpress_post_delete — page-aware: the optional
// postType must be threaded through to the host deps (postType:"page" routes
// the read/delete to /wp/v2/pages/{id}); posts keep their prior behavior.
// ---------------------------------------------------------------------------
describe("wordpress_post_status / wordpress_post_delete — thread postType", () => {
  const SITE = {
    id: "site-1",
    siteUrl: "https://example.com",
    username: "u",
    applicationPassword: "p",
    name: "Site 1",
    createdAt: "",
    updatedAt: "",
  };

  beforeEach(() => {
    _resetWordPressDepsForTests();
    vi.mocked(callWordPressMcp).mockReset();
  });

  it("wordpress_post_status forwards postType:'page' to cinatra-post-status (MCP-only)", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 81, status: "publish", link: "https://example.com/p" });
    registerStubDeps({ listMcpInstances: () => [SITE] });
    const handlers = createWordPressPrimitiveHandlers();
    await (handlers as any).wordpress_post_status({
      primitiveName: "wordpress_post_status",
      input: { instanceId: "site-1", postId: 81, postType: "page" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-status",
      { id: 81, postType: "page" },
    );
  });

  it("wordpress_post_status leaves postType out of the tool args for posts", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 82, status: "draft" });
    registerStubDeps({ listMcpInstances: () => [SITE] });
    const handlers = createWordPressPrimitiveHandlers();
    await (handlers as any).wordpress_post_status({
      primitiveName: "wordpress_post_status",
      input: { instanceId: "site-1", postId: 82 },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-status",
      { id: 82 },
    );
  });

  it("wordpress_post_delete forwards postType:'page' to cinatra-post-delete (after write authority, MCP-only)", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ deleted: true, previousStatus: "publish" });
    const requireInstanceWriteAuthority = vi.fn(async () => {});
    registerStubDeps({ listMcpInstances: () => [SITE], requireInstanceWriteAuthority });
    const handlers = createWordPressPrimitiveHandlers();
    const res = await (handlers as any).wordpress_post_delete({
      primitiveName: "wordpress_post_delete",
      input: { instanceId: "site-1", postId: 81, postType: "page" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(requireInstanceWriteAuthority).toHaveBeenCalledWith({
      instanceId: "site-1",
      primitiveName: "wordpress_post_delete",
    });
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-delete",
      { id: 81, postType: "page" },
    );
    expect(res).toEqual({ ok: true });
  });
});
