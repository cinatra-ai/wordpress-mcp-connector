import { describe, expect, it, vi, beforeEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
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

// cinatra-ai/cinatra#2022: wordpress_post_get / wordpress_post_update now reach
// WordPress content through the GOVERNED INVOKER's `ewpa/get-post` /
// `ewpa/update-post` abilities (getWordPressDeps().invokeSiteTool), not
// callWordPressMcp — this suite mocks that deps member directly instead of
// the retired MCP-client mock.
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

/** Route the invokeSiteTool mock by ability name — the governed invoker's
 * `{success, data}` envelope (cinatra-ai/cinatra#2022): `ewpa/get-post` returns
 * the current post; `ewpa/update-post` echoes only a minimal ack (the
 * community catalog's own convention — the handler must NOT depend on this
 * echo for content; see handlers.ts's `updatePostViaMcp` doc comment). The
 * post-apply verification path re-reads via `ewpa/get-post` again — same
 * route, `current`'s override applies there too so a read-back test can
 * simulate a drifted/faithful apply. */
function routeMcpByTool(current: Record<string, unknown>) {
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
      // The community ability's minimal echo — no content field. Proves the
      // handler doesn't (and can't) rely on this response for the applied
      // content; it independently re-reads via ewpa/get-post instead.
      return { success: true, data: { post_id: input.args.post_id, message: "Post updated successfully." } };
    }
    throw new Error(`unexpected toolName in test: ${input.toolName}`);
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

beforeEach(() => {
  vi.clearAllMocks();
  invokeSiteToolMock = vi.fn();
  _resetWordPressDepsForTests();
});

describe("wordpress_post_update — S5 review trigger", () => {
  it("FENCE OFF (no cmsReview seam): byte-identical — applies via ewpa/update-post, no capture", async () => {
    registerStubDeps(); // cmsReview unbound
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    })) as Record<string, unknown>;
    // The write reached WordPress (the update ability was called).
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
    expect((res as any).status).not.toBe("pending_review");
  });

  it("FENCE OFF (seam bound, isReviewActive false): byte-identical, no pre-write get/capture", async () => {
    const seam = makeSeam({ isReviewActive: () => false });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    });
    // No pre-write current fetch (byte-identical hot path) — but the
    // apply path still does its OWN post-write re-read (updatePostViaMcp's
    // independent re-read, unrelated to the review gate), so assert exactly
    // one get call (the post-write re-read), not zero.
    const getCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/get-post");
    expect(getCalls).toHaveLength(1);
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
  });

  it("FENCE ON, gate held: captures the proposed content + manifest and HOLDS — WordPress unchanged", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title", content: "<p>New body</p>" },
    })) as Record<string, unknown>;
    // Held descriptor returned; the effect is NOT applied.
    expect((res as any).status).toBe("pending_review");
    expect((res as any).applied).toBe(false);
    // The capture got the proposed content + the changed-paths scope manifest.
    expect(seam.captureStagedWrite).toHaveBeenCalledTimes(1);
    const capArg = vi.mocked(seam.captureStagedWrite).mock.calls[0]![0];
    expect(capArg.scopeManifest.paths).toEqual(["title", "content"]);
    expect(capArg.resolved.text).toContain("New title");
    // CRITICAL: the update ability was NEVER called — WordPress content unchanged.
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
  });

  it("FENCE ON, gate approved: applies the write AND records read-back verification", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    const res = (await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    })) as Record<string, unknown>;
    // The write reached WordPress.
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(1);
    // Read-back verification recorded.
    expect(seam.recordApplyVerification).toHaveBeenCalledTimes(1);
    expect((res as any).review).toBeDefined();
    expect((res as any).review.outcome).toBe("verified");
  });

  it("read-back verification is built from an INDEPENDENT re-read, not the update ability's own echo (no content field)", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "approved" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({ post_content: "<p>Post-apply body, freshly re-read</p>" });
    const handlers = createWordPressPrimitiveHandlers();
    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 42, title: "New title" },
    });
    const verifyArg = vi.mocked(seam.recordApplyVerification).mock.calls[0]![0];
    expect(verifyArg.postApplyFields.content).toBe("<p>Post-apply body, freshly re-read</p>");
  });

  it("FENCE ON, gate rejected: refuses — the write never reaches WordPress", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "rejected" as const, gate: { gateId: "gate-1", runId: "run-1" } })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcpByTool({});
    const handlers = createWordPressPrimitiveHandlers();
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 42, title: "New title" },
      }),
    ).rejects.toThrow(/rejected/i);
    const updateCalls = invokeSiteToolMock.mock.calls.filter((c) => c[0].toolName === "ewpa/update-post");
    expect(updateCalls).toHaveLength(0);
  });
});
