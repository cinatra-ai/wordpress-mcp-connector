// cinatra-ai/cinatra#2022 — the relocated ability-name-keyed content-review
// trigger.
//
// `wordpress_post_update`'s handler (see cms-review-handler.test.ts) was,
// until this change, the ONLY place in this connector that called
// `evaluateStagedContentWrite` — the review-before-publish TRIGGER that holds
// a staged content write fail-closed until a human approves it. The GENERIC
// forwarding primitive, `wordpress_site_tool_call`, was a bare pass-through
// with no review-triggering logic: a caller reaching `ewpa/update-post`
// directly through it bypassed the gate entirely. This suite pins:
//   - the relocated trigger fires identically to the dedicated tool's own
//     gate (before/after behavioral parity);
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
    requireInstanceWriteAuthority: vi.fn(async () => {}),
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
    ).rejects.toThrow(/positive numeric "post_id"/);
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
// Before/after behavioral parity: the SAME staged write through the OLD
// dedicated tool path (`wordpress_post_update`, still present on main — this
// change does not delete it) and the NEW generic path
// (`wordpress_site_tool_call` with toolName:"ewpa/update-post") produces the
// SAME hold/approve/reject outcome for equivalent inputs.
// ---------------------------------------------------------------------------
describe("behavioral parity — wordpress_post_update vs. wordpress_site_tool_call(ewpa/update-post)", () => {
  function freshDeps(extra: Partial<WordPressConnectorDeps> = {}) {
    invokeSiteToolMock = vi.fn();
    _resetWordPressDepsForTests();
    registerStubDeps(extra);
    routeMcpByTool();
  }

  it("HOLD: both paths capture the identical scope manifest and hold — WordPress unchanged either way", async () => {
    const seamOld = makeSeam();
    freshDeps({ cmsReview: seamOld });
    const oldHandlers = createWordPressPrimitiveHandlers();
    const oldRes = (await (oldHandlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title", content: "<p>New body</p>" },
    })) as Record<string, unknown>;
    const oldScope = vi.mocked(seamOld.captureStagedWrite).mock.calls[0]![0].scopeManifest.paths;

    const seamNew = makeSeam();
    freshDeps({ cmsReview: seamNew });
    const newHandlers = createWordPressPrimitiveHandlers();
    const newRes = (await (newHandlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input: {
        toolName: "ewpa/update-post",
        args: { post_id: 42, title: "New title", content: "<p>New body</p>" },
        instanceId: "site-1",
      },
      actor: MODEL_ACTOR,
      mode: "agentic",
    })) as Record<string, unknown>;
    const newScope = vi.mocked(seamNew.captureStagedWrite).mock.calls[0]![0].scopeManifest.paths;

    expect((oldRes as any).status).toBe("pending_review");
    expect((newRes as any).status).toBe("pending_review");
    expect((oldRes as any).applied).toBe(false);
    expect((newRes as any).applied).toBe(false);
    expect(newScope).toEqual(oldScope);
  });

  it("APPROVE: both paths apply the write and record a verified read-back", async () => {
    const approvedDisposition = async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } });

    const seamOld = makeSeam({ resolveDisposition: vi.fn(approvedDisposition) });
    freshDeps({ cmsReview: seamOld });
    const oldHandlers = createWordPressPrimitiveHandlers();
    const oldRes = (await (oldHandlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    })) as Record<string, unknown>;

    const seamNew = makeSeam({ resolveDisposition: vi.fn(approvedDisposition) });
    freshDeps({ cmsReview: seamNew });
    const newHandlers = createWordPressPrimitiveHandlers();
    const newRes = (await (newHandlers as any).wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input: { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      actor: MODEL_ACTOR,
      mode: "agentic",
    })) as Record<string, unknown>;

    expect(((oldRes as any).review).outcome).toBe("verified");
    expect(((newRes as any).review).outcome).toBe("verified");
    expect(seamOld.recordApplyVerification).toHaveBeenCalledTimes(1);
    expect(seamNew.recordApplyVerification).toHaveBeenCalledTimes(1);
  });

  it("REJECT: both paths refuse — WordPress never receives the write", async () => {
    const rejectedDisposition = async () => ({ disposition: "rejected" as const, gate: { gateId: "gate-1", runId: "run-1" } });

    const seamOld = makeSeam({ resolveDisposition: vi.fn(rejectedDisposition) });
    freshDeps({ cmsReview: seamOld });
    const oldHandlers = createWordPressPrimitiveHandlers();
    await expect(
      (oldHandlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 42, title: "New title" },
      }),
    ).rejects.toThrow(/rejected/i);
    const oldUpdateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(oldUpdateCalls).toHaveLength(0);

    const seamNew = makeSeam({ resolveDisposition: vi.fn(rejectedDisposition) });
    freshDeps({ cmsReview: seamNew });
    const newHandlers = createWordPressPrimitiveHandlers();
    await expect(
      (newHandlers as any).wordpress_site_tool_call({
        primitiveName: "wordpress_site_tool_call",
        input: { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
        actor: MODEL_ACTOR,
        mode: "agentic",
      }),
    ).rejects.toThrow(/rejected/i);
    const newUpdateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(newUpdateCalls).toHaveLength(0);
  });
});
