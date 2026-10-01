// The post update ability of `wordpress_site_tool_call`. This suite pins:
//   - the ability's arguments are checked before any call is forwarded
//     (instance id, post id, meta, out-of-scope fields, editable fields);
//   - the per-instance write-authority gate runs before the call is
//     forwarded, and a denial forwards nothing;
//   - the arguments reach the invoker unchanged;
//   - a non-target ability is completely unaffected.
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

import {
  createWordPressPrimitiveHandlers,
  CONTENT_REVIEW_TARGET_ABILITIES,
} from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
} from "../deps";

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

// Mock signatures are DERIVED FROM THE DEPS CONTRACT itself, never restated —
// so a change to either member's shape re-types these mocks (and their
// `mock.calls` argument tuples) instead of silently drifting. A bare
// `ReturnType<typeof vi.fn>` widens to vitest's default `Mock<Procedure |
// Constructable>`, which is not assignable to the strictly-typed deps members.
type RequireInstanceWriteAuthorityFn = WordPressConnectorDeps["requireInstanceWriteAuthority"];
// `invokeSiteTool` is OPTIONAL on the deps (skew posture); the mock stands in
// for the BOUND member, hence NonNullable.
type InvokeSiteToolFn = NonNullable<WordPressConnectorDeps["invokeSiteTool"]>;

// Rebound in beforeEach — every test gets a fresh mock, matching
// cms-review-handler.test.ts's own convention for this exact deps member.
let invokeSiteToolMock: Mock<InvokeSiteToolFn>;
// Rebound in beforeEach too (parity with write-authority.test.ts's own
// convention for this dep) — default ALLOW; individual tests override to
// DENY (reject) to model the cinatra#409 gate's fail-closed decisions.
let requireInstanceWriteAuthorityMock: Mock<RequireInstanceWriteAuthorityFn>;

function registerStubDeps(extra: Partial<WordPressConnectorDeps> = {}) {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) || 0 : 0),
    buildListPage: (items, total, offset, limit) => ({ items, total }),
    dispatchContentEditor: vi.fn(async () => "{}"),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances: listMcpInstancesMock,
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    getApiStatus: vi.fn(() => ({ status: "not_connected" as const, detail: "" })),
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
    invokeSiteTool: invokeSiteToolMock,
    ...extra,
  });
}

/** Route the invokeSiteTool mock by ability name — the same `{success, data}`
 * envelope + snake_case fields cms-review-handler.test.ts's `routeMcpByTool`
 * pins for `ewpa/get-post` / `ewpa/update-post`. Any OTHER ability (e.g.
 * `core/get-site-info`) returns a plain marker object — used by the
 * non-target-ability regression test. */
function routeMcpByTool(current: Record<string, unknown> = {}) {
  invokeSiteToolMock.mockImplementation(async (input: { toolName: string; args: Record<string, unknown> }) => {
    if (input.toolName === "ewpa/get-post") {
      return {
        success: true,
        data: {
          ID: 42,
          post_status: "publish",
          post_title: "Old title",
          post_content: "<p>Old body</p>",
          post_excerpt: "old",
          ...current,
        },
      };
    }
    if (input.toolName === "ewpa/update-post") {
      // The community ability's minimal echo — no content field (matches
      // cms-review-handler.test.ts's own documented evidence).
      return { success: true, data: { post_id: input.args.post_id, message: "Post updated successfully." } };
    }
    return { ok: true, toolName: input.toolName };
  });
}

const MODEL_ACTOR = { actorType: "model", source: "agent" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  invokeSiteToolMock = vi.fn<InvokeSiteToolFn>();
  requireInstanceWriteAuthorityMock = vi.fn<RequireInstanceWriteAuthorityFn>(async () => {});
  _resetWordPressDepsForTests();
});

describe("wordpress_site_tool_call — relocated content-review trigger (cinatra-ai/cinatra#2022)", () => {
  const call = (input: unknown, handlers: ReturnType<typeof createWordPressPrimitiveHandlers>) =>
    (handlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input,
      actor: MODEL_ACTOR,
      mode: "agentic",
    });

  it("keys ONLY ewpa/update-post today — a disclosed, not-yet-widened set (review focus: completeness)", () => {
    expect(CONTENT_REVIEW_TARGET_ABILITIES.has("ewpa/update-post")).toBe(true);
    // ewpa/create-post is a real, open completeness question (see the section
    // comment in handlers.ts) — NOT silently included in this PR.
    expect(CONTENT_REVIEW_TARGET_ABILITIES.has("ewpa/create-post")).toBe(false);
  });

  it("FENCE OFF (no cmsReview seam): byte-identical — forwards ewpa/update-post straight through, no capture", async () => {
    registerStubDeps(); // cmsReview unbound
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await call(
      { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      handlers,
    )) as Record<string, unknown>;
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toEqual({
      toolName: "ewpa/update-post",
      args: { post_id: 42, title: "New title" },
      instanceId: "site-1",
    });
    // No review wrapper on the fence-off pass path.
    expect((res as any).review).toBeUndefined();
  });

  it("requires an explicit instanceId for a content-review-gated ability (fail-closed parity with wordpress_post_update's own unconditional requirement)", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" } }, handlers),
    ).rejects.toThrow(/requires an explicit instanceId/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("refuses a meta payload pre-gate (mirrors wordpress_post_update's own hardening — never strands an approved-but-inapplicable review)", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call(
        { toolName: "ewpa/update-post", args: { post_id: 42, meta: { foo: "bar" } }, instanceId: "site-1" },
        handlers,
      ),
    ).rejects.toThrow(/cannot write post meta/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("refuses a missing/invalid post_id before any capture", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/positive integer "post_id"/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it('refuses a non-integer "post_id" (e.g. "42.5") before any capture — Number.isInteger, not bare Number()', async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: "42.5", title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/positive integer "post_id"/);
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42.5, title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/positive integer "post_id"/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it('accepts an exponential-but-integral "post_id" (e.g. "1e2") — the same coercion the dedicated tool\'s z.coerce.number().int() allows', async () => {
    registerStubDeps({}); // fence off — no cmsReview, so the write forwards straight through
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await call({ toolName: "ewpa/update-post", args: { post_id: "1e2", title: "New title" }, instanceId: "site-1" }, handlers);
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
  });

  // CodeRabbit-adopted hardening: an unreviewed field must not ride an
  // unchanged-title "pass" verdict onto WordPress unreviewed.
  it("rejects a field outside the content-review scope on the pass path", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    // "Old title" matches routeMcpByTool's current title exactly, so if this
    // were allowed through, changedPaths would be empty and the write would
    // ride a no-gate `pass` verdict — carrying the unreviewed "slug" with it.
    await expect(
      call(
        { toolName: "ewpa/update-post", args: { post_id: 42, title: "Old title", slug: "sneaky" }, instanceId: "site-1" },
        handlers,
      ),
    ).rejects.toThrow(/outside the content-review scope/);
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
  });

  it("gates the write with requireWriteAuthority BEFORE the review capture/write (parity with wordpress_post_update's own gate)", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await call(
      { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      handlers,
    );
    expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith({
      instanceId: "site-1",
      primitiveName: "wordpress_site_tool_call",
    });
    expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledTimes(1);
  });

  it("DENIED write authority -> throws and NEVER reaches WordPress (parity: the write is refused exactly as wordpress_post_update refuses)", async () => {
    requireInstanceWriteAuthorityMock.mockRejectedValueOnce(new Error("write denied: no use right"));
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/denied/i);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("a NON-target ability is unaffected — forwards straight through with no review-trigger logic", async () => {
    registerStubDeps();
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    const res = await call({ toolName: "core/get-site-info", args: { verbose: true }, instanceId: "site-1" }, handlers);
    expect(invokeSiteToolMock).toHaveBeenCalledWith({
      toolName: "core/get-site-info",
      args: { verbose: true },
      instanceId: "site-1",
    });
    expect(res).toEqual({ ok: true, toolName: "core/get-site-info" });
  });
});

// ---------------------------------------------------------------------------
// REMOVED (cinatra-ai/cinatra#2022 PR-θ): a "behavioral parity — the
// dedicated post-update tool vs. wordpress_site_tool_call(ewpa/update-post)"
// suite used to live here, driving the SAME staged write through both the
// OLD dedicated tool path and the NEW generic path to prove identical
// hold/approve/reject outcomes. PR-θ deletes that dedicated tool (and
// the eleven other superseded facade tools) now that this relocation has
// soaked — `createWordPressPrimitiveHandlers()` no longer has a key for it,
// so a parity comparison against it can no
// longer be driven. The equivalence this suite proved is not lost: it was
// exercised for real, on both paths, while both existed (wmc#100), and the
// design's own equivalence mapping (`.claude/scratch/s7-2022/DESIGN.md`
// §15.4) records the property-by-property comparison.
// ---------------------------------------------------------------------------
