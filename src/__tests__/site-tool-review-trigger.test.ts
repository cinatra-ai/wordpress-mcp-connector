// cinatra-ai/cinatra#2022 — the relocated ability-name-keyed content-review
// trigger.
//
// The dedicated post-update tool's handler was, until wmc#100, the ONLY place in
// this connector that called `evaluateStagedContentWrite` — the
// review-before-publish TRIGGER that holds a staged content write
// fail-closed until a human approves it. The GENERIC forwarding primitive,
// `wordpress_site_tool_call`, was a bare pass-through with no
// review-triggering logic: a caller reaching `ewpa/update-post` directly
// through it bypassed the gate entirely. wmc#100 relocated the trigger onto
// `wordpress_site_tool_call` itself, keyed on ability name, BEFORE PR-θ
// deleted that dedicated tool (and its own now-redundant inline gate)
// along with the other 11 dead facade tools — so this suite now covers the
// trigger's ONLY remaining home. (The dedicated tool's own gate test file,
// `cms-review-handler.test.ts`, and the before/after parity suite that once
// compared the two paths side by side, are deleted with the tool — see
// registry-omission.test.ts for the deletion's own regression coverage.)
// This suite pins:
//   - the relocated trigger's hold/approve/reject/pass behavior on the
//     generic path;
//   - a call with no agent-run context still holds fail-closed;
//   - the mutating ability is NEVER invoked while held/rejected
//     (hold-before-forward);
//   - a non-target ability is completely unaffected.
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  createWordPressPrimitiveHandlers,
  CONTENT_REVIEW_TARGET_ABILITIES,
} from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
  type WordPressMcpInstance,
  type CmsReviewSeam,
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

// Rebound in beforeEach — every test gets a fresh mock, matching
// cms-review-handler.test.ts's own convention for this exact deps member.
let invokeSiteToolMock: ReturnType<typeof vi.fn>;
// Rebound in beforeEach too (parity with write-authority.test.ts's own
// convention for this dep) — default ALLOW; individual tests override to
// DENY (reject) to model the cinatra#409 gate's fail-closed decisions.
let requireInstanceWriteAuthorityMock: ReturnType<typeof vi.fn>;

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

function makeSeam(overrides: Partial<CmsReviewSeam> = {}): CmsReviewSeam {
  return {
    isReviewActive: () => true,
    captureStagedWrite: vi.fn(async (input) => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      operationId: input.operationId,
      producedEventId: "evt-1",
    })),
    resolveDisposition: vi.fn(async () => ({ disposition: "held" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    recordApplyVerification: vi.fn(async () => ({ ok: true, outcome: "verified" as const })),
    ...overrides,
  };
}

const MODEL_ACTOR = { actorType: "model", source: "agent" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  invokeSiteToolMock = vi.fn();
  requireInstanceWriteAuthorityMock = vi.fn(async () => {});
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

  it("FENCE ON, gate held: captures the proposed content and HOLDS — the mutating ability is NEVER invoked (hold-before-forward)", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await call(
      {
        toolName: "ewpa/update-post",
        args: { post_id: 42, title: "New title", content: "<p>New body</p>" },
        instanceId: "site-1",
      },
      handlers,
    )) as Record<string, unknown>;
    expect((res as any).status).toBe("pending_review");
    expect((res as any).applied).toBe(false);
    expect(seam.captureStagedWrite).toHaveBeenCalledTimes(1);
    const capArg = vi.mocked(seam.captureStagedWrite).mock.calls[0]![0];
    expect(capArg.scopeManifest.paths).toEqual(["title", "content"]);
    // CRITICAL — hold-before-forward proof: the mutating ability is never
    // invoked while held. Only the current-content fetch (ewpa/get-post) ran.
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
    const getCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/get-post");
    expect(getCalls).toHaveLength(1);
  });

  it("FENCE ON, gate approved: applies the write AND records read-back verification", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await call(
      { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      handlers,
    )) as Record<string, unknown>;
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
    expect(seam.recordApplyVerification).toHaveBeenCalledTimes(1);
    expect((res as any).review).toBeDefined();
    expect((res as any).review.outcome).toBe("verified");
    // The applied ability's own raw envelope is preserved alongside the
    // review meta (a best-effort merge — see the code comment: the ability's
    // response shape is not pinned by this change).
    expect((res as any).success).toBe(true);
    expect((res as any).data).toEqual({ post_id: 42, message: "Post updated successfully." });
  });

  it("FENCE ON, gate rejected: refuses — the mutating ability is NEVER invoked (hold-before-forward)", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "rejected" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/rejected/i);
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
  });

  it("requires an explicit instanceId for a content-review-gated ability (fail-closed parity with wordpress_post_update's own unconditional requirement)", async () => {
    registerStubDeps({ cmsReview: makeSeam() });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" } }, handlers),
    ).rejects.toThrow(/requires an explicit instanceId/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("refuses a meta payload pre-gate (mirrors wordpress_post_update's own hardening — never strands an approved-but-inapplicable review)", async () => {
    registerStubDeps({ cmsReview: makeSeam() });
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
    registerStubDeps({ cmsReview: makeSeam() });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/positive integer "post_id"/);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it('refuses a non-integer "post_id" (e.g. "42.5") before any capture — Number.isInteger, not bare Number()', async () => {
    registerStubDeps({ cmsReview: makeSeam() });
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
    registerStubDeps({ cmsReview: makeSeam() });
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
    registerStubDeps({ cmsReview: makeSeam() });
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
    registerStubDeps({ cmsReview: makeSeam() });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      call({ toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" }, handlers),
    ).rejects.toThrow(/denied/i);
    expect(invokeSiteToolMock).not.toHaveBeenCalled();
  });

  it("a transient post-apply read-back failure does not mask a successful write as a failure (reread failure ≠ write failure)", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    let getPostCalls = 0;
    invokeSiteToolMock.mockImplementation(async (input: { toolName: string; args: Record<string, unknown> }) => {
      if (input.toolName === "ewpa/get-post") {
        getPostCalls += 1;
        // First call: evaluateStagedContentWrite's fetchCurrent (pre-write) — succeeds.
        if (getPostCalls === 1) {
          return {
            success: true,
            data: { ID: 42, post_status: "publish", post_title: "Old title", post_content: "<p>Old body</p>", post_excerpt: "old" },
          };
        }
        // Second call: the post-apply read-back — a transient MCP failure.
        throw new Error("transient MCP failure");
      }
      if (input.toolName === "ewpa/update-post") {
        return { success: true, data: { post_id: input.args.post_id, message: "Post updated successfully." } };
      }
      return { ok: true, toolName: input.toolName };
    });
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await call(
      { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      handlers,
    )) as Record<string, unknown>;
    // The write itself landed and the caller does NOT see a thrown error.
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
    // The failed reread is recorded as an unverified read-back — never a
    // fabricated "verified" outcome, and never a call to recordApplyVerification
    // (there is no re-read content to verify against).
    expect(seam.recordApplyVerification).not.toHaveBeenCalled();
    expect((res as any).review).toMatchObject({ ok: false, code: "readback-unavailable" });
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

  // The no-run-context / orphan-run test. This connector's trigger call
  // never reads run/actor context (identity is always host-derived, §2.4) —
  // it uniformly defers to the seam's disposition. A call carrying no
  // agent-run-identifying context at all (no runId, no actor) exercises
  // exactly the same code path as any other call, so it holds fail-closed
  // identically — proving there is no branch here that COULD skip review for
  // a run-less/orphan-run capture (the host mints a synthetic run and fails
  // closed while the gate is pending, regardless of what this handler does).
  it("holds fail-closed for a call carrying no agent-run context (the orphan-run fallback is host-side, not read here)", async () => {
    const seam = makeSeam(); // held — the verdict for a fresh/pending capture either way
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool();
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input: { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      // No actor / run-identifying fields at all — a bare/synthetic frame.
      actor: undefined,
      mode: "agentic",
    })) as Record<string, unknown>;
    expect((res as any).status).toBe("pending_review");
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
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
// §15.4) records the property-by-property comparison. The hold/approve/
// reject/pass coverage on the surviving generic path lives in the describe
// block above; a non-target-ability regression test and a no-run-context
// (orphan-run) test are also covered there.
// ---------------------------------------------------------------------------
